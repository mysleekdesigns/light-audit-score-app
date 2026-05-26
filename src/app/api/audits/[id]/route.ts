/**
 * `GET /api/audits/:id` — fetch the current snapshot of one batch (PRD §6 Phase 2).
 *
 * Returns the lhr-stripped {@link Batch} (HTTP 200) or a structured 404 when the
 * id is unknown. For a live feed of progress, clients use the `/stream` SSE route.
 */

import { notFound } from "@/lib/api/errors";
import { getAuditQueue } from "@/lib/queue/AuditQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Next 16: dynamic route params are async and must be awaited.
  const { id } = await params;

  const batch = getAuditQueue().getBatch(id);
  if (!batch) {
    return notFound("batch_not_found", `No batch found with id "${id}".`);
  }

  return Response.json(batch, { status: 200 });
}
