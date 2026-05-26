/**
 * `POST /api/discover` — discover candidate URLs for a seed (PRD §6 Phase 5).
 *
 * Validates the request body into a resolved {@link DiscoverInput}, runs the
 * server-side discovery engine (sitemap + shallow crawl, robots-aware), and
 * returns the {@link DiscoverResult} (HTTP 200). Discovery is best-effort, so a
 * successful run can still carry `warnings`; only validation/unexpected errors
 * produce the structured {@link ApiErrorBody} envelope. Raw errors never leak.
 *
 * The returned `urls` (same-origin, deduped, capped at `maxPages` ≤ the batch
 * `MAX_URLS`) can be fed straight into `POST /api/audits`.
 */

import { apiError, badRequest, serverError } from "@/lib/api/errors";
import { discover } from "@/lib/crawl/discover";
import { parseDiscoverBody } from "@/lib/crawl/schema";

// Node runtime + always-dynamic: discovery performs arbitrary cross-origin
// fetches + cheerio parsing and must never be statically optimized/cached.
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

  const parsed = parseDiscoverBody(raw);
  if (!parsed.ok) {
    return badRequest(
      "invalid_request",
      "The request body failed validation.",
      parsed.issues,
    );
  }

  try {
    const result = await discover(parsed.value);
    return Response.json(result, { status: 200 });
  } catch (error) {
    // discover() is best-effort and shouldn't throw, but never leak internals.
    const message =
      error instanceof Error ? error.message : "Failed to discover URLs.";
    return serverError("discover_failed", message);
  }
}

// Reject unsupported methods with a structured 405 rather than Next's default.
export async function GET(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use POST to discover URLs.");
}
