/**
 * `POST /api/audits/:id/cancel` — cancel a batch in flight.
 *
 * Delegates to {@link AuditQueueApi.cancelBatch}: queued jobs are dropped,
 * running worker children are SIGKILLed, and the batch transitions to the
 * terminal `cancelled` status (the SSE stream then emits `batch-cancelled` and
 * closes). Jobs that already settled keep their results / persisted runs. The
 * call is idempotent — cancelling an already-terminal batch is a no-op that
 * returns its current snapshot. Returns 404 for an unknown batch id.
 */

import { notFound } from "@/lib/api/errors";
import { getAuditQueue } from "@/lib/queue/AuditQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const batch = getAuditQueue().cancelBatch(id);
  if (!batch) {
    return notFound("batch_not_found", `No batch found with id "${id}".`);
  }
  return Response.json(batch, { status: 200 });
}
