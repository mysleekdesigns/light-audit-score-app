/**
 * `PATCH /api/schedules/:id` — partial update (pause/enable/edit, PRD §6 Phase 14).
 * `DELETE /api/schedules/:id` — remove a schedule.
 *
 * Mirrors `src/app/api/audits/[id]/route.ts`: Next 16 async params, structured
 * error envelopes for failures, raw errors never leak. PATCH uses
 * `parseUpdateScheduleBody` so a body with only `{ enabled: false }` is enough
 * to pause without re-sending the whole config.
 */

import { parseUpdateScheduleBody } from "@/lib/api/schedules-schema";
import { apiError, badRequest, notFound } from "@/lib/api/errors";
import { deleteSchedule, updateSchedule } from "@/lib/db/schedules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Next 16: dynamic route params are async and must be awaited.
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("invalid_json", "Request body must be valid JSON.");
  }

  const parsed = parseUpdateScheduleBody(raw);
  if (!parsed.ok) {
    return badRequest(
      "invalid_request",
      "The request body failed validation.",
      parsed.issues,
    );
  }

  const updated = updateSchedule(id, parsed.value);
  if (!updated) {
    return notFound("schedule_not_found", `No schedule found with id "${id}".`);
  }
  return Response.json(updated, { status: 200 });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const removed = deleteSchedule(id);
  if (!removed) {
    return notFound("schedule_not_found", `No schedule found with id "${id}".`);
  }
  return new Response(null, { status: 204 });
}

// Reject unsupported methods with a structured 405 rather than Next's default.
export async function GET(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use PATCH to update or DELETE to remove.");
}

export async function POST(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use PATCH to update or DELETE to remove.");
}

export async function PUT(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use PATCH to update or DELETE to remove.");
}
