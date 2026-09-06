/**
 * Typed browser-side client for the Phase-5 site-discovery API (PRD §6 Phase 5).
 *
 * Sibling to {@link import("./auditClient")} — same request/response seam, same
 * error discipline. The "Crawl site" UI calls {@link discoverSite} to turn a seed
 * URL + crawl options into a {@link DiscoverResult} (sitemap + shallow same-origin
 * crawl). It deliberately reuses {@link ApiError} from `auditClient` so every
 * client call in the app throws the *same* structured-envelope error type, which
 * the UI already knows how to render (`err.issues[0]?.message ?? err.message`).
 *
 * Why a thin wrapper and not `fetch` inline in the component: keeping request
 * shaping + envelope parsing here means the panel stays a pure view, the network
 * contract lives next to the audit client it mirrors, and the route handler can
 * change its error body without touching UI. Discovery itself is server-only
 * (cross-origin fetches + robots.txt), so this file only crosses the wire — it
 * imports nothing node-specific and is safe in a `"use client"` tree.
 */

import { ApiError } from "@/lib/client/auditClient";
import type { DiscoverRequest, DiscoverResult } from "@/lib/crawl/types";
import type { ApiErrorBody } from "@/lib/queue/types";

/**
 * Parse a failed `Response` into an {@link ApiError}, tolerating non-JSON bodies.
 *
 * Mirrors `auditClient.toApiError` (which is module-private there, so we can't
 * import it) against the same `ApiErrorBody` envelope shape: `{ error: { code,
 * message, issues } }`. Kept tiny and local so the two clients stay independent.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON / empty body — fall through to a generic message.
  }
  const err = body?.error;
  return new ApiError(
    response.status,
    err?.code ?? "request_failed",
    err?.message ?? `Request failed (${response.status}).`,
    err?.issues ?? [],
  );
}

/**
 * Discover same-origin URLs for a seed site (sitemap + shallow crawl).
 *
 * POSTs the {@link DiscoverRequest} to `/api/discover` and returns the engine's
 * {@link DiscoverResult}. Throws {@link ApiError} on any non-2xx so callers can
 * surface a toast with the structured message. The route validates/clamps the
 * request, so the client sends options as-is (the panel normalizes the seed URL
 * scheme before calling — the server only accepts absolute http/https URLs).
 *
 * `input.auth` (ROADMAP Phase B) rides along like any other field, and is the
 * one field that is a **secret**: it carries the basic-auth pair, cookies or
 * preview header that let discovery walk a protected staging site. It is
 * strictly request-scoped — this client never stores it (no `localStorage`, no
 * module-level cache), the caller passes it in per call, and the server neither
 * persists it nor echoes it back in the {@link DiscoverResult}. Anything that
 * wants it to survive a reload belongs in the server's `.env`, which discovery
 * already merges underneath the request (`resolveDiscoveryCredentials`).
 */
export async function discoverSite(
  input: DiscoverRequest,
): Promise<DiscoverResult> {
  const response = await fetch("/api/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as DiscoverResult;
}
