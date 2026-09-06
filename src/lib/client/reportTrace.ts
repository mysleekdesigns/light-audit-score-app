/**
 * Browser-side client for the stored-report trace endpoint (ROADMAP Phase D).
 *
 * A sibling of `@/lib/client/auditClient` rather than a section of it: the trace
 * is the one endpoint whose whole reason for existing is that the thing behind it
 * is too big to send (a ~690 KB–1.5 MB stored report, projected server-side down
 * to a ~20 KB {@link RunTrace}), and keeping it in its own module means the
 * waterfall/filmstrip UI imports only what it uses.
 *
 * Conventions match `auditClient`: same {@link ApiError} thrown on any non-2xx,
 * same `{ error: { code, message } }` envelope parsing, same `encodeURIComponent`
 * URL building, same default (same-origin) credentials so the local request
 * gate's session cookie rides along.
 */

import { ApiError } from "@/lib/client/auditClient";
import type { ApiErrorBody } from "@/lib/queue/types";
import type { RunTrace } from "@/lib/reports/types";

/**
 * Parse a failed `Response` into an {@link ApiError}, tolerating non-JSON bodies.
 *
 * A local twin of `auditClient`'s identical private helper — that module does not
 * export it, and this one is a sibling, not an edit to it.
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

/** URL of the compact waterfall + filmstrip projection for a completed run. */
export function runTraceUrl(runId: string): string {
  return `/api/reports/${encodeURIComponent(runId)}/trace`;
}

/**
 * Fetch the {@link RunTrace} for a completed run. Throws {@link ApiError} on
 * failure (404 for a run with no stored report, 500 for an unreadable one).
 *
 * `signal` is optional so a caller that unmounts — or flips to another run —
 * can drop an in-flight read; see `useRunTrace`.
 */
export async function getRunTrace(
  runId: string,
  signal?: AbortSignal,
): Promise<RunTrace> {
  const response = await fetch(runTraceUrl(runId), {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as RunTrace;
}
