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
import type { AuditResult } from "@/lib/lighthouse/types";
import { runAuditInWorker } from "@/lib/queue/runAuditWorker";
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
    const concurrency = clampConcurrency(input.concurrency);
    // The PQueue is shared across batches; the most recent batch's concurrency
    // wins. Single-user tool, so batches don't realistically overlap.
    this.queue.concurrency = concurrency;

    const createdAt = now();
    const batchId = nanoid();

    const jobs: AuditJob[] = input.urls.map((url, index) => ({
      id: nanoid(),
      index,
      url,
      status: "queued",
      queuedAt: createdAt,
    }));

    const batch: BatchRecord = {
      id: batchId,
      status: "queued",
      options: input.options,
      concurrency,
      jobs,
      counts: computeCounts(jobs),
      createdAt,
    };

    this.batches.set(batchId, batch);

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

    return cloneBatch(batch);
  }

  /** Current snapshot of a batch (lhr-stripped), or `undefined` if unknown. */
  getBatch(id: string): Batch | undefined {
    const batch = this.batches.get(id);
    return batch ? cloneBatch(batch) : undefined;
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
      const result = await runAuditInWorker(job.url, batch.options);
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

    this.maybeFinalizeBatch(batch);
  }

  /**
   * If every job in the batch has settled (done/error), transition the batch to
   * its terminal status and emit `batch-completed`. Idempotent: a batch already
   * in a terminal state is left untouched.
   */
  private maybeFinalizeBatch(batch: BatchRecord): void {
    if (batch.status === "completed" || batch.status === "completed_with_errors") {
      return;
    }
    const allSettled = batch.jobs.every(
      (j) => j.status === "done" || j.status === "error",
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
