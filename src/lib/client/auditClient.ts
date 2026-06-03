/**
 * Typed browser-side client for the Phase-2 audit API (PRD §6 Phase 3).
 *
 * The single seam UI code uses to talk to the route handlers — it owns request
 * shaping, response typing, and turning the structured {@link ApiErrorBody}
 * envelope into a throwable {@link ApiError}. Live progress is consumed
 * separately via the SSE hook (`useBatchStream`); this module covers the
 * request/response endpoints (`POST /api/audits`, `GET /api/audits/:id`) plus
 * report URL helpers.
 */

import type {
  AnalysisCategory,
  AnalysisResult,
  AnalysisStreamEvent,
} from "@/lib/analysis/types";
import type {
  AuditOptions,
  AuditSource,
  DeviceSelection,
} from "@/lib/lighthouse/types";
import type { ApiErrorBody, ApiErrorIssue, Batch } from "@/lib/queue/types";

/** Body accepted by {@link createBatch}; mirrors `POST /api/audits` (options/concurrency optional). */
export interface CreateBatchRequest {
  urls: string[];
  /**
   * Device selection (PRD §6 Phase 12). `"both"` audits each URL on mobile AND
   * desktop (two jobs per URL). Optional; when omitted the server falls back to
   * `options.formFactor` (single-device run), keeping older callers working.
   */
  device?: DeviceSelection;
  options?: Partial<AuditOptions>;
  /**
   * Engine to run on (PSI feature). `"psi"` routes the batch through Google
   * PageSpeed Insights; omitted/`"local"` uses the forked-Chrome engine.
   */
  source?: AuditSource;
  concurrency?: number;
  /**
   * When true, the server forces effective concurrency to 1 if Performance is in
   * scope (DevTools-panel parity, PRD §6 Phase 9). Optional; defaults to false.
   */
  accuracyMode?: boolean;
  /**
   * The id of the batch this request re-runs (PRD §6 Phase 13). Optional; recorded
   * as lineage on the new batch so its runs are one click from compare / trend.
   */
  priorBatchId?: string;
}

/** Thrown by every client call on a non-2xx response; carries the structured envelope. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: ApiErrorIssue[];

  constructor(
    status: number,
    code: string,
    message: string,
    issues: ApiErrorIssue[] = [],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

/** Parse a failed `Response` into an {@link ApiError}, tolerating non-JSON bodies. */
async function toApiError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON / empty body — fall through to a generic message.
  }
  const err = body?.error;
  return new ApiError(
    response.status,
    err?.code ?? "request_failed",
    err?.message ?? `Request failed (${response.status}).`,
    err?.issues ?? [],
  );
}

/** Create an audit batch and return its initial snapshot. Throws {@link ApiError} on failure. */
export async function createBatch(input: CreateBatchRequest): Promise<Batch> {
  const response = await fetch("/api/audits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as Batch;
}

/** Fetch the current snapshot of a batch. Throws {@link ApiError} (e.g. 404) on failure. */
export async function getBatch(id: string): Promise<Batch> {
  const response = await fetch(`/api/audits/${encodeURIComponent(id)}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as Batch;
}

/**
 * Cancel a batch in flight and return its (terminal) snapshot. Queued jobs are
 * dropped and running workers killed; already-completed jobs keep their results.
 * Throws {@link ApiError} (e.g. 404) on failure.
 */
export async function cancelBatch(id: string): Promise<Batch> {
  const response = await fetch(
    `/api/audits/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as Batch;
}

/** Delete a single persisted run (row + stored reports). Throws {@link ApiError} on failure. */
export async function deleteRun(runId: string): Promise<void> {
  const response = await fetch(`/api/history/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await toApiError(response);
}

/** Counts removed by {@link clearHistory}. */
export interface ClearHistoryResult {
  runs: number;
  batches: number;
}

/** Delete ALL persisted runs/batches and their stored reports. Throws {@link ApiError} on failure. */
export async function clearHistory(): Promise<ClearHistoryResult> {
  const response = await fetch("/api/history", { method: "DELETE" });
  if (!response.ok) throw await toApiError(response);
  const body = (await response.json()) as { cleared: ClearHistoryResult };
  return body.cleared;
}

/** URL of the raw Lighthouse Result JSON for a completed run. */
export function reportJsonUrl(runId: string): string {
  return `/api/reports/${encodeURIComponent(runId)}`;
}

/** URL of the rendered standalone Lighthouse HTML report for a completed run. */
export function reportHtmlUrl(runId: string): string {
  return `/api/reports/${encodeURIComponent(runId)}?format=html`;
}

// --- AI score analysis (the "explain & fix my score" feature) --------------

/**
 * Fetch the persisted analysis for a `(runId, category)`, or `null` when there
 * isn't one yet (the 404 the route returns — "not analyzed yet" is not an error).
 * Other non-2xx responses still throw {@link ApiError}.
 */
export async function getAnalysis(
  runId: string,
  category: AnalysisCategory,
): Promise<AnalysisResult | null> {
  const response = await fetch(
    `/api/reports/${encodeURIComponent(runId)}/analyze?category=${encodeURIComponent(category)}`,
    { method: "GET", cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as AnalysisResult;
}

/**
 * The POST target that streams a fresh analysis as SSE. The streaming transport
 * lives in `useAnalysisStream` (fetch + ReadableStream reader) rather than here,
 * the same way `useBatchStream` owns its `EventSource`.
 */
export function analyzeStreamUrl(runId: string): string {
  return `/api/reports/${encodeURIComponent(runId)}/analyze`;
}

/**
 * Parse one SSE frame (the text between `\n\n` delimiters) into an
 * {@link AnalysisStreamEvent}. The framed `data:` payload is itself a discriminated
 * union carrying its own `type`, so the `event:` line is redundant and ignored.
 * Returns `null` for malformed/empty frames (callers skip them). Pure + testable.
 */
export function parseAnalysisSseFrame(frame: string): AnalysisStreamEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as AnalysisStreamEvent;
  } catch {
    return null;
  }
}
