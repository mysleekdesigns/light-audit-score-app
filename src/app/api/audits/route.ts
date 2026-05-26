/**
 * `POST /api/audits` — create an audit batch (PRD §6 Phase 2).
 *
 * Validates the request body, hands the resolved {@link CreateBatchInput} to the
 * in-process queue, and returns the initial {@link Batch} snapshot (HTTP 201).
 * All failures return the structured {@link ApiErrorBody} envelope; raw errors
 * are never surfaced to the client.
 */

import { parseCreateBatchBody } from "@/lib/api/audits-schema";
import { apiError, badRequest, serverError } from "@/lib/api/errors";
import { getAuditQueue } from "@/lib/queue/AuditQueue";

// Node runtime + always-dynamic: the queue is an in-process singleton driving
// Chrome via the Phase-1 engine; this route must never be statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Parse the JSON body defensively: a malformed body is a client error, not a 500.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("invalid_json", "Request body must be valid JSON.");
  }

  const parsed = parseCreateBatchBody(raw);
  if (!parsed.ok) {
    return badRequest(
      "invalid_request",
      "The request body failed validation.",
      parsed.issues,
    );
  }

  try {
    const batch = getAuditQueue().createBatch(parsed.value);
    return Response.json(batch, { status: 201 });
  } catch (error) {
    // Defensive: createBatch is synchronous and shouldn't throw on valid input,
    // but never leak internals if it does.
    const message =
      error instanceof Error ? error.message : "Failed to create the audit batch.";
    return serverError("batch_create_failed", message);
  }
}

// Reject unsupported methods with a structured 405 rather than Next's default.
export async function GET(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use POST to create a batch.");
}
