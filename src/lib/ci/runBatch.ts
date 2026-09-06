/**
 * Running a batch headlessly, and reading back what it archived.
 *
 * This is the seam Phase F built inside `scripts/audit-cli.ts` and Phase G's
 * "reuse, don't fork" rule pulled out of it: submit URLs to the *existing*
 * queue, wait for the batch to settle, then read the runs back out of SQLite.
 * The CLI and the MCP server are two callers of one path — no second engine, no
 * second settlement rule, and above all no second definition of which rows a
 * verdict is computed from.
 *
 * What deliberately stays with the callers is the **verdict**. This module
 * reports what happened (the batch, its rows, how many jobs settled); it never
 * decides that a short read is a failure or that a cancellation is an error,
 * because those answers differ: the CLI owns a build's exit code, while an agent
 * asking for one audit wants a readable result either way.
 *
 * Nothing here prints. The CLI's progress output is its own — passed in as
 * `onEvent` — which is what allows the same code to run inside an MCP server,
 * where a stray write to stdout would corrupt the JSON-RPC stream.
 */

import { listHistory, type HistoryRow } from "@/lib/db/persistence";
import type { AuditOptions, DeviceSelection } from "@/lib/lighthouse/types";
import {
  DEFAULT_CONCURRENCY,
  type AuditQueueApi,
  type Batch,
  type BatchStatus,
  type ProgressEvent,
} from "@/lib/queue/types";

/** Terminal batch statuses — the point at which every job has settled. */
export function isTerminalBatchStatus(status: BatchStatus): boolean {
  return (
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "cancelled"
  );
}

/**
 * Await a batch's terminal event, reporting progress as it goes.
 *
 * Every terminal state is handled, not just the happy one: `batch-completed`
 * covers both `completed` and `completed_with_errors` (a failed job settles the
 * batch, it doesn't stall it), and `batch-cancelled` resolves too — a caller that
 * waits forever on a cancelled batch is strictly worse than one that fails.
 *
 * The subscription is registered right after `createBatch`, which is safe by the
 * queue's own contract: it defers every job past the current microtask so a
 * caller subscribing immediately catches every event. The terminal re-check
 * below closes the one remaining gap (a batch finalised inline, before any
 * listener could exist) so this can never hang.
 */
export function awaitBatchSettlement(
  queue: AuditQueueApi,
  batchId: string,
  onEvent: (event: ProgressEvent) => void,
): Promise<Batch> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const settle = (batch: Batch): void => {
      unsubscribe?.();
      unsubscribe = null;
      resolve(batch);
    };
    unsubscribe = queue.subscribe(batchId, (event) => {
      onEvent(event);
      if (event.type === "batch-completed" || event.type === "batch-cancelled") {
        settle(event.batch);
      }
    });
    const snapshot = queue.getBatch(batchId);
    if (snapshot && isTerminalBatchStatus(snapshot.status)) settle(snapshot);
  });
}

/**
 * The batch's persisted runs, in batch order.
 *
 * This is decision 1 of the CI contract made concrete: the rows judged are the
 * rows in SQLite, read back through the same `listHistory()` the archive UI
 * uses. A run id IS its job id, so the batch's job order sorts them; anything
 * unrecognised sorts last rather than being dropped.
 */
export function persistedRows(batch: Batch): HistoryRow[] {
  const order = new Map(batch.jobs.map((job) => [job.id, job.index]));
  return listHistory()
    .filter((row) => row.batchId === batch.id)
    .sort(
      (a, b) =>
        (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * How many of the batch's jobs reached a settled state.
 *
 * The denominator for "did every finished run reach the archive?" — a check that
 * only means anything when it is counted the same way by everyone who makes it.
 */
export function settledJobCount(batch: Batch): number {
  return batch.jobs.filter(
    (job) => job.status === "done" || job.status === "error",
  ).length;
}

/** What to run. Already-validated: URLs normalised, options resolved. */
export interface RunBatchInput {
  urls: string[];
  device: DeviceSelection;
  options: AuditOptions;
  /** Clamped by the queue; omit for {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
  accuracyMode?: boolean;
  /** Progress sink. Omit for silence — which is what an MCP server needs. */
  onEvent?: (event: ProgressEvent) => void;
  /**
   * Called once with the fresh batch, before any waiting begins.
   *
   * The hook exists for cancellation: the CLI installs a SIGINT handler that
   * calls `queue.cancelBatch(batch.id)`, and it can only do that if it learns the
   * id at creation rather than at settlement.
   */
  onBatchCreated?: (batch: Batch) => void;
}

/** What happened. The caller turns this into a verdict. */
export interface RunBatchOutcome {
  /** Terminal snapshot — `completed`, `completed_with_errors` or `cancelled`. */
  batch: Batch;
  /** The runs this batch archived, in batch order. */
  rows: HistoryRow[];
  /** Jobs that reached `done`/`error`; compare with `rows.length`. */
  settledJobs: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * Create a batch, wait for it, and read back what it archived.
 *
 * Deliberately takes the queue rather than reaching for `getAuditQueue()`, so a
 * test can drive the whole path against a fake and so the module keeps no
 * process-wide state of its own.
 */
export async function runBatchToCompletion(
  queue: AuditQueueApi,
  input: RunBatchInput,
): Promise<RunBatchOutcome> {
  const startedAt = new Date().toISOString();
  const batch = queue.createBatch({
    urls: input.urls,
    device: input.device,
    options: input.options,
    concurrency: input.concurrency ?? DEFAULT_CONCURRENCY,
    accuracyMode: input.accuracyMode,
  });
  input.onBatchCreated?.(batch);

  const settled = await awaitBatchSettlement(
    queue,
    batch.id,
    input.onEvent ?? (() => {}),
  );
  const finishedAt = new Date().toISOString();

  return {
    batch: settled,
    rows: persistedRows(settled),
    settledJobs: settledJobCount(settled),
    startedAt,
    finishedAt,
  };
}
