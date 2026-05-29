/**
 * `GET /api/audits/:id/stream` — Server-Sent Events feed of a batch's progress
 * (PRD §6 Phase 2).
 *
 * Streaming protocol (matches the queue's {@link ProgressEvent} contract):
 *  1. We **subscribe first**, then immediately emit a `batch-snapshot` built from
 *     the queue's current state. Subscribe-then-snapshot closes the race window
 *     where an event could fire between reading the snapshot and registering the
 *     listener.
 *  2. Incremental `job-*` events are forwarded as they arrive.
 *  3. On `batch-completed`, we flush the final event, unsubscribe, and close.
 *  4. If the batch is already terminal when we subscribe, we send the snapshot
 *     then synthesize a close (no further events would ever arrive).
 *  5. Client disconnects (`request.signal` abort) unsubscribe and close.
 *
 * Each event is framed as `event: <type>\n` + `data: <json>\n\n` (UTF-8). Every
 * `controller.enqueue` is guarded so a write after close can never throw.
 */

import { notFound } from "@/lib/api/errors";
import { getAuditQueue } from "@/lib/queue/AuditQueue";
import type { Batch, ProgressEvent } from "@/lib/queue/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Batch lifecycle states from which no further progress events will be emitted. */
const TERMINAL_BATCH_STATUSES = new Set<Batch["status"]>([
  "completed",
  "completed_with_errors",
  "cancelled",
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const queue = getAuditQueue();
  const initial = queue.getBatch(id);
  if (!initial) {
    return notFound("batch_not_found", `No batch found with id "${id}".`);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;

      /** Enqueue one SSE-framed event; no-op after the stream is closed. */
      const send = (event: ProgressEvent): void => {
        if (closed) return;
        try {
          const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Controller already closed/errored — stop trying to write.
          closed = true;
        }
      };

      /** Tear down exactly once: unsubscribe from the queue and close the stream. */
      const teardown = (): void => {
        if (closed) return;
        closed = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed — nothing to do.
        }
      };

      // Stop streaming when the client disconnects.
      const onAbort = (): void => teardown();
      if (request.signal.aborted) {
        // Client already gone before we started.
        teardown();
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });

      // 1. Subscribe BEFORE snapshotting so we can't miss an event in the gap.
      unsubscribe = queue.subscribe(id, (event) => {
        send(event);
        if (event.type === "batch-completed" || event.type === "batch-cancelled") {
          teardown();
        }
      });

      // 2. Emit the current snapshot. Re-read so it's as fresh as possible.
      const current = queue.getBatch(id) ?? initial;
      send({ type: "batch-snapshot", batch: current });

      // 4. If the batch is already terminal, no further events will fire — close.
      if (TERMINAL_BATCH_STATUSES.has(current.status)) {
        teardown();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
