/**
 * `DELETE /api/history/batch/:id` — delete a whole persisted batch.
 *
 * Removes the batch's AI analyses, its run rows, those runs' stored report files,
 * and the batch row itself. A console shows a batch as a unit, so the destructive
 * "Clear" is batch-wide rather than per-run. Returns 404 if no batch with that id
 * exists.
 */

import { notFound } from "@/lib/api/errors";
import { deleteBatch } from "@/lib/db/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const deleted = await deleteBatch(id);
  if (!deleted) {
    return notFound("batch_not_found", `No batch found with id "${id}".`);
  }
  return Response.json({ deleted: true }, { status: 200 });
}
