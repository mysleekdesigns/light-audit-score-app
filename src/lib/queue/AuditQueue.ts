/**
 * In-process audit job queue + batch orchestration (PRD §6 Phase 2).
 *
 * This module implements the {@link AuditQueueApi} seam declared in
 * `src/lib/queue/types.ts`. It owns the only in-memory store of batches/jobs and
 * the only `p-queue` instance, runs each job through the Phase 1 engine — via
 * {@link runAuditInWorker}, which forks an isolated process per job so concurrent
 * audits don't collide on Lighthouse's process-global performance marks — and
 * broadcasts {@link ProgressEvent}s to subscribers.
 *
 * Design notes:
 *  - **One PQueue, bounded concurrency.** A single `PQueue` (concurrency capped
 *    by {@link MAX_CONCURRENCY}) governs how many Lighthouse audits run at once.
 *    Running too many on one machine contends for CPU and distorts performance
 *    scores (PRD §3), hence the cap. `createBatch` (re)sets the queue's
 *    concurrency from the batch input.
 *  - **Lhr-stripping.** A full {@link AuditResult} carries `median.lhr` (≈1 MB).
 *    We keep that heavy object only in a side map keyed by runId (the job id),
 *    reachable via {@link AuditQueue.getJobResult}; every batch/job snapshot and
 *    every progress event carries the lhr-stripped {@link AuditResultLite} view.
 *  - **Defensive snapshots.** `getBatch`/events return shallow clones of the
 *    batch and its jobs so external callers can't mutate internal state. The
 *    lite views never contain the lhr, so a shallow clone is sufficient.
 *  - **HMR-safe singleton.** {@link getAuditQueue} pins the instance to
 *    `globalThis` so Next.js dev-mode hot reloads don't spawn duplicate queues
 *    (and orphan in-flight audits). Tests construct `new AuditQueue()` directly
 *    to get an isolated instance.
 */

import { EventEmitter } from "node:events";

import PQueue from "p-queue";
import { nanoid } from "nanoid";

import {
  recordBatch,
  recordFailedRun,
  recordRun,
  updateBatchStatus,
} from "@/lib/db/persistence";
import { resolveFormFactors } from "@/lib/lighthouse/options";
import type { AuditResult } from "@/lib/lighthouse/types";
import { runPsiAudit } from "@/lib/pagespeed/runPsiAudit";
import { runAuditInWorker, WorkerAbortError } from "@/lib/queue/runAuditWorker";
import {
  type AuditJob,
  type AuditQueueApi,
  type AuditResultLite,
  type Batch,
  type BatchCounts,
  type CreateBatchInput,
  type ProgressEvent,
  type ProgressListener,
  clampConcurrency,
  resolveEffectiveConcurrency,
} from "@/lib/queue/types";

/**
 * Internal batch record. Identical in shape to the public {@link Batch} but kept
 * as the canonical mutable store; public reads go through {@link cloneBatch}.
 */
type BatchRecord = Batch;

/** Current ISO timestamp helper (centralised so it's easy to stub in future). */
function now(): string {
  return new Date().toISOString();
}

/**
 * Derive aggregate {@link BatchCounts} from a job list. Recomputed on every
 * emit/snapshot so counts are always consistent with job statuses (cheap: jobs
 * per batch are small).
 */
function computeCounts(jobs: AuditJob[]): BatchCounts {
  const counts: BatchCounts = {
    total: jobs.length,
    queued: 0,
    running: 0,
    done: 0,
    error: 0,
    cancelled: 0,
  };
  for (const job of jobs) {
    counts[job.status] += 1;
  }
  return counts;
}

/**
 * Strip the heavy `median.lhr` off a full {@link AuditResult}, producing the
 * {@link AuditResultLite} view safe to embed in snapshots and SSE payloads.
 */
function toResultLite(result: AuditResult): AuditResultLite {
  const { lhr, ...medianWithoutLhr } = result.median;
  void lhr; // intentionally dropped from the lite view
  return { ...result, median: medianWithoutLhr };
}

/** Shallow-clone a single job (lite views carry no lhr, so this is enough). */
function cloneJob(job: AuditJob): AuditJob {
  return {
    ...job,
    error: job.error ? { ...job.error } : undefined,
  };
}

/**
 * Produce a defensively-copied public snapshot of a batch: fresh `jobs` array of
 * cloned jobs, freshly recomputed `counts`. External mutation of the returned
 * object cannot corrupt internal state.
 */
function cloneBatch(batch: BatchRecord): Batch {
  const jobs = batch.jobs.map(cloneJob);
  return {
    ...batch,
    jobs,
    counts: computeCounts(jobs),
  };
}

/**
 * In-process audit queue. Implements {@link AuditQueueApi}. Construct directly
 * for an isolated instance (tests); use {@link getAuditQueue} for the shared,
 * HMR-safe singleton in app code.
 */
export class AuditQueue implements AuditQueueApi {
  /** The single work queue governing audit concurrency. */
  private readonly queue: PQueue;

  /** Canonical store of batches by id. */
  private readonly batches = new Map<string, BatchRecord>();

  /**
   * Full (lhr-bearing) results by runId (== job id), for the report endpoint.
   * Kept separate so heavy LHRs never travel through snapshots/events.
   */
  private readonly results = new Map<string, AuditResult>();

  /** Per-batch progress listeners. Lazily created on first subscribe/emit. */
  private readonly emitter = new EventEmitter();

  /**
   * Per-batch {@link AbortController}, created in `createBatch`. Aborting it
   * (via {@link cancelBatch}) SIGKILLs every running worker child for that batch
   * — each `runJob` passes its batch's `signal` into {@link runAuditInWorker}.
   */
  private readonly batchControllers = new Map<string, AbortController>();

  constructor(concurrency: number = clampConcurrency(Number.NaN)) {
    // EventEmitter defaults to a 10-listener warning; a batch may legitimately
    // have more SSE subscribers, so lift the cap.
    this.emitter.setMaxListeners(0);
    this.queue = new PQueue({ concurrency: clampConcurrency(concurrency) });
  }

  /** Current effective queue concurrency. */
  get concurrency(): number {
    return this.queue.concurrency;
  }

  /**
   * Create a batch, enqueue one job per URL, and begin processing under the
   * batch's (clamped) concurrency. Returns the initial all-`queued` snapshot.
   */
  createBatch(input: CreateBatchInput): Batch {
    // Accuracy mode (PRD §6 Phase 9) forces concurrency to 1 when Performance is
    // in scope so parallel Chromes can't contend during the simulated-throttling
    // trace and deflate scores. `batch.concurrency` records what actually ran.
    // PSI runs on Google's servers, so local CPU contention is irrelevant —
    // accuracy mode never pins PSI concurrency (it would only slow the batch).
    const source = input.source ?? "local";
    const concurrency = resolveEffectiveConcurrency(
      input.options,
      input.concurrency,
      source === "psi" ? false : input.accuracyMode,
    );
    // The PQueue is shared across batches; the most recent batch's concurrency
    // wins. Single-user tool, so batches don't realistically overlap.
    this.queue.concurrency = concurrency;

    const createdAt = now();
    const batchId = nanoid();

    // Fan a `"both"` device selection out into per-(url, form-factor) jobs (PRD
    // §6 Phase 12). `"both"` is purely a batch-creation concern — the engine and
    // worker stay single-form-factor and never see it. Each URL yields one job
    // per resolved form factor (mobile then desktop for `"both"`); a single
    // device yields one job per URL exactly as before. `index` is the global
    // flattened position across the whole fanned-out list so ordering stays
    // stable regardless of how many form factors each URL expanded into.
    const formFactors = resolveFormFactors(input.device);
    const jobs: AuditJob[] = [];
    let index = 0;
    for (const url of input.urls) {
      for (const formFactor of formFactors) {
        jobs.push({
          id: nanoid(),
          index: index++,
          url,
          device: formFactor,
          status: "queued",
          queuedAt: createdAt,
        });
      }
    }

    const batch: BatchRecord = {
      id: batchId,
      status: "queued",
      device: input.device,
      // Engine this batch runs on (PSI feature); dispatched on in `runJob`.
      source,
      // Pin a concrete representative form factor onto the batch-level options
      // (the first resolved form factor) so single-device reads of
      // `batch.options.formFactor` keep working and it's never `"both"`. Each
      // job overrides this with its own `device` when the engine runs.
      options: { ...input.options, formFactor: formFactors[0] },
      concurrency,
      // Re-run lineage (PRD §6 Phase 13): null/undefined for fresh batches.
      priorBatchId: input.priorBatchId,
      // Schedule lineage (PRD §6 Phase 14): set when fired by the local scheduler,
      // undefined for ad-hoc batches.
      scheduleId: input.scheduleId,
      jobs,
      counts: computeCounts(jobs),
      createdAt,
    };

    this.batches.set(batchId, batch);
    // One AbortController per batch; `cancelBatch` aborts it to kill running workers.
    this.batchControllers.set(batchId, new AbortController());

    // Index the freshly-created batch (pure side effect; never throws).
    recordBatch(batch);

    // Enqueue one task per job. Each task is self-contained and never rejects
    // (failures are caught and recorded), so one bad URL can't poison the queue.
    //
    // `PQueue.add` synchronously invokes the task up to its first `await` when
    // concurrency is free, which would flip job 0 to `running` BEFORE we return.
    // The contract requires the initial snapshot to be all-`queued`, so we defer
    // the actual work past the current microtask. This also guarantees a caller
    // that subscribes immediately after `createBatch` catches every event.
    for (const job of jobs) {
      void this.queue.add(async () => {
        await Promise.resolve();
        await this.runJob(batchId, job.id);
      });
    }

    // Defensive: a batch with zero jobs enqueues nothing, so `runJob` — and with
    // it `maybeFinalizeBatch` — never runs, leaving the batch stuck `queued`
    // forever (the client would spin on "Running…"). The API/form both reject
    // empty URL lists, so this is belt-and-suspenders, but the queue's own
    // contract must never produce a non-finalizing batch. Finalize inline so the
    // returned snapshot is already terminal.
    if (jobs.length === 0) {
      this.maybeFinalizeBatch(batch);
    }

    return cloneBatch(batch);
  }

  /** Current snapshot of a batch (lhr-stripped), or `undefined` if unknown. */
  getBatch(id: string): Batch | undefined {
    const batch = this.batches.get(id);
    return batch ? cloneBatch(batch) : undefined;
  }

  /**
   * Cancel a batch in flight (see {@link AuditQueueApi.cancelBatch}). Flips every
   * not-yet-settled job to `cancelled`, aborts the batch's worker children, marks
   * the batch terminal, and emits `batch-cancelled`. Already-settled jobs
   * (`done`/`error`) are untouched so their persisted runs survive. Idempotent.
   */
  cancelBatch(id: string): Batch | undefined {
    const batch = this.batches.get(id);
    if (!batch) return undefined;
    // Already terminal — nothing to cancel; return the current snapshot.
    if (
      batch.status === "completed" ||
      batch.status === "completed_with_errors" ||
      batch.status === "cancelled"
    ) {
      return cloneBatch(batch);
    }

    const finishedAt = now();
    batch.status = "cancelled";
    batch.finishedAt = finishedAt;
    // Stop queued jobs from ever launching (runJob bails on non-`queued`) and
    // mark in-flight jobs cancelled; the abort below kills their workers. Jobs
    // already done/errored keep their result and persisted run.
    for (const job of batch.jobs) {
      if (job.status === "queued" || job.status === "running") {
        job.status = "cancelled";
        job.finishedAt = finishedAt;
      }
    }

    // SIGKILL any running worker children for this batch.
    this.batchControllers.get(id)?.abort();

    // Mirror the terminal status to the persistence index.
    updateBatchStatus(id, { status: "cancelled", finishedAt });

    this.emit(id, { type: "batch-cancelled", batch: cloneBatch(batch) });
    return cloneBatch(batch);
  }

  /**
   * The full (lhr-bearing) {@link AuditResult} for a completed run, or
   * `undefined` if the run is unknown / not yet done.
   */
  getJobResult(runId: string): AuditResult | undefined {
    return this.results.get(runId);
  }

  /**
   * Subscribe to a batch's progress. Returns an unsubscribe function. Safe to
   * call before the batch exists; the listener simply receives events once the
   * batch starts emitting.
   */
  subscribe(batchId: string, listener: ProgressListener): () => void {
    this.emitter.on(batchId, listener);
    return () => {
      this.emitter.off(batchId, listener);
    };
  }

  /** Broadcast an event to all listeners registered for its batch. */
  private emit(batchId: string, event: ProgressEvent): void {
    this.emitter.emit(batchId, event);
  }

  /**
   * Execute one job: flip it (and possibly its batch) to `running`, run the
   * engine, then record success/failure and, when the batch is fully settled,
   * finalise it. Never throws — failures are captured onto the job.
   */
  private async runJob(batchId: string, jobId: string): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    const job = batch.jobs.find((j) => j.id === jobId);
    if (!job) return;

    // If the job is no longer `queued` it was cancelled before its turn (see
    // `cancelBatch`, which flips queued jobs to `cancelled`). Don't launch a
    // worker; the batch is already terminal so there's nothing to finalize.
    if (job.status !== "queued") return;

    const signal = this.batchControllers.get(batchId)?.signal;

    // --- start ---
    job.status = "running";
    job.startedAt = now();
    if (batch.status === "queued") {
      batch.status = "running";
      batch.startedAt = job.startedAt;
      // Mirror the queued→running transition to the persistence index.
      updateBatchStatus(batchId, {
        status: "running",
        startedAt: job.startedAt,
      });
    }
    this.emit(batchId, {
      type: "job-started",
      batchId,
      job: cloneJob(job),
      counts: computeCounts(batch.jobs),
    });

    // --- run + settle ---
    try {
      // Run the batch options with this job's concrete form factor (PRD §6
      // Phase 12). For a single-device batch this equals `batch.options`; for a
      // `"both"` batch it pins the per-job device so the persisted run records
      // the right one (`result.options.formFactor` flows straight through).
      const jobOptions = { ...batch.options, formFactor: job.device };
      // Dispatch on the batch engine (PSI feature): PSI is an in-process HTTPS
      // call to Google (cancellable via the same AbortSignal); the local engine
      // forks an isolated Chrome worker. Both resolve to an AuditResult.
      const result =
        batch.source === "psi"
          ? await runPsiAudit(job.url, jobOptions, signal)
          : await runAuditInWorker(job.url, jobOptions, signal);
      // A cancel that landed after the worker finished but before we recorded:
      // drop the result and mark the job cancelled (cancelBatch set it already,
      // but a late-completing worker would otherwise overwrite that here).
      if (signal?.aborted) {
        if (job.status === "running") {
          job.status = "cancelled";
          job.finishedAt = now();
        }
        this.maybeFinalizeBatch(batch);
        return;
      }
      // Stash the heavy, lhr-bearing result under the runId for the report
      // endpoint; surface only the lite view on the job.
      this.results.set(job.id, result);
      job.status = "done";
      job.finishedAt = now();
      job.result = toResultLite(result);
      // Persist the run (report files + indexed row) BEFORE announcing the job
      // as done, so the report files exist by the time the UI reacts. recordRun
      // never throws, so no extra try/catch is required.
      await recordRun(batch, job, result);
      this.emit(batchId, {
        type: "job-completed",
        batchId,
        job: cloneJob(job),
        counts: computeCounts(batch.jobs),
      });
    } catch (err) {
      // A cancel (worker SIGKILLed via AbortSignal) is not a failure: mark the
      // job cancelled and persist nothing. `cancelBatch` may have already set
      // this; either way we never record a failed run for a cancellation.
      if (err instanceof WorkerAbortError || signal?.aborted) {
        if (job.status === "running") {
          job.status = "cancelled";
          job.finishedAt = now();
        }
      } else {
        job.status = "error";
        job.finishedAt = now();
        job.error = { message: errorMessage(err) };
        // Index the failed run BEFORE announcing the failure.
        recordFailedRun(batch, job);
        this.emit(batchId, {
          type: "job-failed",
          batchId,
          job: cloneJob(job),
          counts: computeCounts(batch.jobs),
        });
      }
    }

    this.maybeFinalizeBatch(batch);
  }

  /**
   * If every job in the batch has settled (done/error), transition the batch to
   * its terminal status and emit `batch-completed`. Idempotent: a batch already
   * in a terminal state is left untouched.
   */
  private maybeFinalizeBatch(batch: BatchRecord): void {
    if (
      batch.status === "completed" ||
      batch.status === "completed_with_errors" ||
      batch.status === "cancelled"
    ) {
      // Already terminal — `cancelBatch` owns the cancelled transition, and a
      // late-rejecting killed worker must not flip the batch back.
      return;
    }
    const allSettled = batch.jobs.every(
      (j) =>
        j.status === "done" ||
        j.status === "error" ||
        j.status === "cancelled",
    );
    if (!allSettled) return;

    const hasError = batch.jobs.some((j) => j.status === "error");
    batch.status = hasError ? "completed_with_errors" : "completed";
    batch.finishedAt = now();
    // Persist the terminal status / finishedAt for the History view.
    updateBatchStatus(batch.id, {
      status: batch.status,
      finishedAt: batch.finishedAt,
    });
    this.emit(batch.id, { type: "batch-completed", batch: cloneBatch(batch) });
  }
}

/** Normalise a thrown value into a string message for `job.error.message`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * Process-global singleton holder. Pinned to `globalThis` so Next.js dev-mode
 * HMR reuses one queue across module reloads instead of spawning duplicates.
 */
const globalForQueue = globalThis as typeof globalThis & {
  __auditQueue?: AuditQueue;
};

/**
 * The shared {@link AuditQueueApi} instance for app code. Lazily created and
 * cached on `globalThis`. Tests should use `new AuditQueue()` for isolation.
 */
export function getAuditQueue(): AuditQueueApi {
  return (globalForQueue.__auditQueue ??= new AuditQueue());
}
