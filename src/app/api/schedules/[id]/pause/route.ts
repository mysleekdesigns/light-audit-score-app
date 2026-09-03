/**
 * `POST /api/schedules/:id/pause` — stop the schedule's run in flight.
 *
 * Delegates to `getScheduler().cancelActiveBatches(id)`: every batch the
 * schedule has queued or running is cancelled through the audit queue (worker
 * children killed, finished pages kept), exactly like the audit console's
 * Cancel. The schedule itself is untouched — its daily cadence keeps firing —
 * and the next "Run now" resumes from the pages that never finished. Returns
 * the cancelled batch ids (empty when nothing was running: pausing is
 * idempotent), or a structured 404 for an unknown schedule.
 */

import { apiError, notFound } from "@/lib/api/errors";
import { getSchedule } from "@/lib/db/schedules";
import { getScheduler } from "@/lib/schedules/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Next 16: dynamic route params are async and must be awaited.
  const { id } = await params;

  if (!getSchedule(id)) {
    return notFound("schedule_not_found", `No schedule found with id "${id}".`);
  }

  const cancelledBatchIds = getScheduler()
    .cancelActiveBatches(id)
    .map((batch) => batch.id);
  return Response.json({ cancelledBatchIds }, { status: 200 });
}

// Reject unsupported methods with a structured 405 rather than Next's default.
export async function GET(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use POST to pause the schedule's run.");
}
