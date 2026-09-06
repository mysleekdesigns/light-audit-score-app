/**
 * `GET /api/schedules` — list all persisted schedules (PRD §6 Phase 14).
 * `POST /api/schedules` — create a new schedule.
 *
 * Mirrors `src/app/api/audits/route.ts`: structured error envelopes from
 * `@/lib/api/errors`, JSON parsed defensively, validation through
 * `parseCreateScheduleBody`, raw errors never surface to the client.
 *
 * The persistence layer (`createSchedule` / `listSchedules`) is itself never-throwing,
 * so the route's job is purely to gate input + shape the response.
 *
 * The `Schedule` echoed back carries its regression-alert preferences
 * (`notify`, ROADMAP Phase C) and nothing credential-shaped: the webhook URL is
 * read from `LH_ALERT_WEBHOOK_URL` at delivery time and never travels with a
 * schedule (see `schedules-schema.ts` and `.claude/rules/security.md`).
 */

import { parseCreateScheduleBody } from "@/lib/api/schedules-schema";
import { apiError, badRequest, serverError } from "@/lib/api/errors";
import { createSchedule, listSchedules } from "@/lib/db/schedules";

// Node runtime + always-dynamic: schedules live in the local SQLite store and
// this route must never be statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const schedules = listSchedules();
  return Response.json({ schedules }, { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  // Parse the JSON body defensively: a malformed body is a client error, not a 500.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("invalid_json", "Request body must be valid JSON.");
  }

  const parsed = parseCreateScheduleBody(raw);
  if (!parsed.ok) {
    return badRequest(
      "invalid_request",
      "The request body failed validation.",
      parsed.issues,
    );
  }

  const schedule = createSchedule(parsed.value);
  if (!schedule) {
    // createSchedule is never-throwing; a null return means the DB layer failed.
    return serverError("schedule_create_failed", "Failed to create the schedule.");
  }
  return Response.json(schedule, { status: 201 });
}

// Reject unsupported methods with a structured 405 rather than Next's default.
export async function PUT(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use GET to list or POST to create.");
}

export async function DELETE(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use GET to list or POST to create.");
}

export async function PATCH(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use GET to list or POST to create.");
}
