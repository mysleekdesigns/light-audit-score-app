/**
 * `POST /api/schedules/:id/run` — force-fire a schedule now, ignoring cadence
 * (PRD §6 Phase 14, "Run now" affordance in the Archive view).
 *
 * Delegates to `getScheduler().runNow(id)`, which resolves the schedule's URLs
 * (re-running discovery for crawl targets) and submits a batch through the
 * existing audit queue with `scheduleId` set. When the schedule's latest batch
 * was paused, the fire resumes it: URLs that already have a result are skipped
 * and the new batch links back via `priorBatchId`. Returns the `FireOutcome`
 * (`batchId`, `urlCount`, `resumedFrom`, `skipped`) on success, a structured
 * 404 when the schedule doesn't exist, or a 500 when the fire failed (e.g. a
 * crawl target that resolved to zero URLs).
 */

import { apiError, notFound, serverError } from "@/lib/api/errors";
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

  // Pre-check existence so we can return a structured 404 distinct from a
  // fire-failed 500. `runNow` returns null in both cases, but a 404 is the more
  // useful client signal when the id is wrong.
  if (!getSchedule(id)) {
    return notFound("schedule_not_found", `No schedule found with id "${id}".`);
  }

  const outcome = await getScheduler().runNow(id);
  if (outcome === null) {
    return serverError(
      "schedule_run_failed",
      "Failed to fire the schedule (it may have resolved to zero URLs).",
    );
  }
  return Response.json(outcome, { status: 200 });
}

// Reject unsupported methods with a structured 405 rather than Next's default.
export async function GET(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use POST to fire the schedule now.");
}
