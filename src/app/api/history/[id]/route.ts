/**
 * `DELETE /api/history/:id` — delete a single persisted run.
 *
 * Removes the run's row and its stored report files (and the parent batch row if
 * this was its last run). Returns 404 if no run with that id exists. Backs the
 * per-row delete in the History table.
 */

import { notFound } from "@/lib/api/errors";
import { deleteRun } from "@/lib/db/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const deleted = await deleteRun(id);
  if (!deleted) {
    return notFound("run_not_found", `No run found with id "${id}".`);
  }
  return Response.json({ deleted: true }, { status: 200 });
}
