/**
 * The audits this server currently has in flight, so a hangup can cancel them
 * (ROADMAP Phase G security re-review, L4).
 *
 * An MCP client restarts its servers routinely — on a config change, on a new
 * session, when the user reloads. Without this, a restart during an `audit_url`
 * left the forked worker and its headless Chrome running to completion with
 * nobody to read the result: the worker has no disconnect handler of its own,
 * and the kill-on-timeout timer lives in the parent that just exited. An orphan
 * that renders a page for another thirty seconds is a real process on a real
 * machine, and the user has no idea it is there.
 *
 * The registry is a set of batch ids rather than anything richer because that is
 * all cancellation needs: `AuditQueueApi` has no way to enumerate live batches,
 * and adding one to a contract shared with the app to serve a shutdown path here
 * would be the wrong direction. Cancelling goes through `cancelBatch`, the same
 * route the CLI's Ctrl-C takes, so runs that already finished stay in History.
 */

import { getAuditQueue } from "@/lib/queue/AuditQueue";

const active = new Set<string>();

/** Record a batch as in flight. */
export function trackBatch(batchId: string): void {
  active.add(batchId);
}

/** Forget a batch that has settled on its own. */
export function untrackBatch(batchId: string): void {
  active.delete(batchId);
}

/** Batch ids currently in flight (for tests and diagnostics). */
export function activeBatchIds(): string[] {
  return [...active];
}

/**
 * Cancel every in-flight batch. Returns how many were cancelled.
 *
 * Total by contract: it runs on the way out of the process, where a throw would
 * replace an orderly shutdown with a stack trace and still leave the child
 * running. Each cancellation is independent, so one failure must not stop the
 * next.
 */
export function cancelActiveBatches(): number {
  if (active.size === 0) return 0;
  const queue = getAuditQueue();
  let cancelled = 0;
  for (const batchId of [...active]) {
    try {
      queue.cancelBatch(batchId);
      cancelled += 1;
    } catch (error) {
      console.error(
        `[mcp] could not cancel batch ${batchId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    active.delete(batchId);
  }
  return cancelled;
}
