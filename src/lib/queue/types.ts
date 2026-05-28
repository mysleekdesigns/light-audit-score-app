/**
 * Shared contract for the audit job queue + batch orchestration (PRD §6 Phase 2).
 *
 * This is the stable seam the queue implementation (`AuditQueue.ts`) and the API
 * route handlers (`src/app/api/**`) both code against:
 *  - `AuditQueue.ts` implements {@link AuditQueueApi}, owns the in-process store,
 *    runs jobs via the Phase 1 engine (`runAudit`), and emits {@link ProgressEvent}s.
 *  - the route handlers validate input, call the queue, and stream events.
 *
 * Keep this file free of runtime/Chrome/p-queue imports so it can be shared by
 * server route handlers and (later) client code alike. It only depends on the
 * engine's pure type contract.
 */

import type {
  AuditOptions,
  AuditResult,
  CategoryScores,
  DeviceSelection,
  FormFactor,
} from "@/lib/lighthouse/types";

// --- Concurrency guardrails (PRD §5: default 3, bounded) -------------------

/** Lower bound on queue concurrency. */
export const MIN_CONCURRENCY = 1;
/**
 * Hard ceiling on queue concurrency. PRD §3 warns that high concurrency on one
 * machine distorts performance scores (CPU contention), so we cap it. The API
 * layer clamps any requested concurrency into [MIN_CONCURRENCY, MAX_CONCURRENCY].
 */
export const MAX_CONCURRENCY = 8;
/** Default queue concurrency when the caller doesn't specify one. */
export const DEFAULT_CONCURRENCY = 3;

/** Clamp an arbitrary number into the allowed concurrency band (floored to int). */
export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(n)));
}

/**
 * The concurrency a batch will *actually* run at (PRD §6 Phase 9 — accuracy mode).
 *
 * "Accuracy mode" forces a single Lighthouse at a time **when Performance is in
 * scope**. Simulated throttling derives its whole estimate from the page's
 * initial *unthrottled* load trace, so CPU contention from parallel Chrome
 * instances inflates TBT/TTI/LCP and silently **deflates** Performance versus a
 * solo DevTools-panel run (PRD §3 host-parity finding; Lighthouse
 * `docs/variability.md`: "DO NOT collect multiple Lighthouse reports at the same
 * time on the same machine"). For batches that don't score Performance
 * (a11y/SEO/best-practices only), parallelism is harmless, so we keep the
 * requested concurrency. Always returns a value within the clamped band.
 */
export function resolveEffectiveConcurrency(
  options: AuditOptions,
  requestedConcurrency: number,
  accuracyMode = false,
): number {
  if (accuracyMode && options.categories.includes("performance")) {
    return MIN_CONCURRENCY;
  }
  return clampConcurrency(requestedConcurrency);
}

// --- Job / batch model -----------------------------------------------------

/** Lifecycle of a single per-URL audit job. */
export type JobStatus = "queued" | "running" | "done" | "error";

/** Lifecycle of a batch (set of jobs). */
export type BatchStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors";

/**
 * Lhr-stripped audit result surfaced through the API/SSE. The raw `median.lhr`
 * (≈1 MB) is intentionally omitted to keep batch/stream payloads small; fetch it
 * via `GET /api/reports/:runId`. `perRunScores` is retained (it's tiny + useful
 * for variance display).
 */
export type AuditResultLite = Omit<AuditResult, "median"> & {
  median: Omit<AuditResult["median"], "lhr">;
};

/** A single per-URL job within a batch. The job's `id` is also its report runId. */
export interface AuditJob {
  /** Stable id (nanoid); doubles as the `runId` for `GET /api/reports/:runId`. */
  id: string;
  /** Index of this job within its batch (0-based), for stable ordering. */
  index: number;
  url: string;
  /**
   * The concrete form factor THIS job runs (PRD §6 Phase 12). For a `"both"`
   * batch each URL fans out into a `mobile` and a `desktop` job that stream
   * independently (distinct ids); for a single-device batch it equals the
   * batch's `options.formFactor`. The job runs the batch options with this
   * `formFactor` override, so the persisted run records the right device.
   */
  device: FormFactor;
  status: JobStatus;
  /** Present once `status === "done"`. Lhr-stripped (see {@link AuditResultLite}). */
  result?: AuditResultLite;
  /** Present once `status === "error"`. */
  error?: { message: string };
  /** ISO timestamps marking lifecycle transitions. */
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Aggregate counts derived from a batch's jobs (convenience for clients). */
export interface BatchCounts {
  total: number;
  queued: number;
  running: number;
  done: number;
  error: number;
}

/** A batch: many per-URL jobs sharing one set of audit options. */
export interface Batch {
  id: string;
  status: BatchStatus;
  /**
   * Device selection the batch was created with (PRD §6 Phase 12). When `"both"`,
   * each URL fanned out into a mobile + a desktop job; otherwise every job runs
   * this single form factor. `options.formFactor` holds a concrete representative
   * (the first resolved form factor) so existing single-device reads still work.
   */
  device: DeviceSelection;
  /** Resolved audit options applied to every job in the batch (per-job `formFactor` overridden by `AuditJob.device`). */
  options: AuditOptions;
  /** Resolved (clamped) concurrency this batch was created with. */
  concurrency: number;
  /**
   * The batch this one was created from via Re-run / Regenerate (PRD §6 Phase 13);
   * `undefined` for originally-submitted batches. Recorded so a re-run's new runs
   * are one click from the Phase-6 compare / trend of the same URLs.
   */
  priorBatchId?: string;
  /**
   * The schedule that fired this batch (PRD §6 Phase 14); `undefined` for ad-hoc
   * batches. Surfaced so the Archive view can group batches by schedule for
   * day-over-day trends.
   */
  scheduleId?: string;
  jobs: AuditJob[];
  counts: BatchCounts;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

// --- Progress events (SSE payloads) ----------------------------------------

/**
 * Events emitted as a batch progresses. The stream handler sends `batch-snapshot`
 * immediately on subscribe (full current state), then incremental events, then
 * `batch-completed` (after which it closes the stream). All payloads are
 * lhr-stripped views.
 */
export type ProgressEvent =
  | { type: "batch-snapshot"; batch: Batch }
  | { type: "job-started"; batchId: string; job: AuditJob; counts: BatchCounts }
  | {
      type: "job-completed";
      batchId: string;
      job: AuditJob;
      counts: BatchCounts;
    }
  | { type: "job-failed"; batchId: string; job: AuditJob; counts: BatchCounts }
  | { type: "batch-completed"; batch: Batch };

/** Listener registered via {@link AuditQueueApi.subscribe}. */
export type ProgressListener = (event: ProgressEvent) => void;

// --- Queue public API ------------------------------------------------------

/**
 * Input to {@link AuditQueueApi.createBatch}. The HTTP layer is responsible for
 * validating the raw request body and resolving it into this already-validated
 * shape (urls non-empty, options resolved via `resolveAuditOptions`, concurrency
 * clamped via {@link clampConcurrency}) before handing it to the queue.
 */
export interface CreateBatchInput {
  urls: string[];
  /**
   * Device selection (PRD §6 Phase 12). `"both"` fans each URL out into a mobile
   * + a desktop job; a single device runs once per URL. When the HTTP layer omits
   * it, it resolves to `options.formFactor` (back-compatible single-device run).
   */
  device: DeviceSelection;
  options: AuditOptions;
  concurrency: number;
  /**
   * When true, the queue forces effective concurrency to 1 if Performance is in
   * scope, for DevTools-panel parity (see {@link resolveEffectiveConcurrency}).
   * Optional; treated as `false` when omitted. Never mutates the caller's saved
   * concurrency — it only affects this batch's effective run.
   */
  accuracyMode?: boolean;
  /**
   * When set, the id of the batch this one re-runs (PRD §6 Phase 13). Recorded on
   * the new {@link Batch} (and persisted) for lineage; does not affect execution.
   */
  priorBatchId?: string;
  /**
   * When set, the id of the schedule that fired this batch (PRD §6 Phase 14).
   * Recorded on the new {@link Batch} (and persisted) so the Archive view can
   * group batches by schedule. Never affects execution.
   */
  scheduleId?: string;
}

/**
 * Public surface of the in-process audit queue. Implemented by `AuditQueue.ts`
 * and obtained via its `getAuditQueue()` singleton accessor. Route handlers
 * depend only on this interface.
 */
export interface AuditQueueApi {
  /**
   * Create a batch, enqueue one job per URL, and begin processing under the
   * batch's concurrency. Returns the initial batch snapshot (all jobs `queued`).
   */
  createBatch(input: CreateBatchInput): Batch;

  /** Current snapshot of a batch, or `undefined` if unknown. */
  getBatch(id: string): Batch | undefined;

  /**
   * The full (lhr-bearing) {@link AuditResult} for a completed job/run, for the
   * report endpoint. `undefined` if the job is unknown or not yet done.
   */
  getJobResult(runId: string): AuditResult | undefined;

  /**
   * Subscribe to a batch's progress. The returned function unsubscribes.
   * Implementations should not assume the batch exists yet at call time.
   */
  subscribe(batchId: string, listener: ProgressListener): () => void;

  /** Current effective queue concurrency. */
  readonly concurrency: number;
}

// --- API request / response DTOs -------------------------------------------

/**
 * Raw `POST /api/audits` request body (pre-validation). The handler validates
 * this with zod, reusing the engine's `auditOptionsSchema` for `options`.
 */
export interface CreateBatchRequestBody {
  urls?: unknown;
  options?: unknown;
  concurrency?: unknown;
}

/** Single zod-style issue surfaced in a structured error. */
export interface ApiErrorIssue {
  path: string;
  message: string;
}

/** Structured error envelope returned by every route handler on failure. */
export interface ApiErrorBody {
  error: {
    message: string;
    code: string;
    issues?: ApiErrorIssue[];
  };
}

/** Re-exported for convenience so consumers import one place. */
export type { CategoryScores };
