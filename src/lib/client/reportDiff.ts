/**
 * Browser-side client for the audit-level run-diff endpoint (ROADMAP Phase E).
 *
 * A sibling of `@/lib/client/reportTrace` for the same reason that one is a
 * sibling of `auditClient`: the thing behind this endpoint is too big to send.
 * A diff reads TWO stored reports (~690 KB–1.5 MB each here) and returns a
 * bounded {@link RunDiff}, so the projection has to stay server-side and the
 * client only ever holds the result.
 *
 * Conventions match its siblings: the same {@link ApiError} on any non-2xx, the
 * same `{ error: { code, message } }` envelope parsing, `encodeURIComponent` on
 * every id, and default (same-origin) credentials so the local request gate's
 * session cookie rides along.
 */

import { ApiError } from "@/lib/client/auditClient";
import type { ApiErrorBody } from "@/lib/queue/types";
import type { RunDiff } from "@/lib/reports/diff-types";

/**
 * Parse a failed `Response` into an {@link ApiError}, tolerating non-JSON bodies.
 *
 * A local twin of the identical private helper in `auditClient`/`reportTrace` —
 * neither exports it, and this is a sibling module, not an edit to them.
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
 * URL of the audit-level diff of `comparisonRunId` against `baselineRunId`.
 *
 * The path segment names the COMPARISON — the run the answer is about — which
 * is what makes "what changed in this run?" a single URL.
 */
export function runDiffUrl(baselineRunId: string, comparisonRunId: string): string {
  return `/api/reports/${encodeURIComponent(comparisonRunId)}/diff?baseline=${encodeURIComponent(
    baselineRunId,
  )}`;
}

/**
 * Fetch the {@link RunDiff} for a pair of completed runs. Throws
 * {@link ApiError} on failure (400 for a missing/self baseline, 404 when either
 * run has no stored report, 500 for an unreadable one).
 *
 * `signal` is optional so a caller that unmounts — or changes its run selection
 * — can drop an in-flight read; see `useRunDiff`.
 */
export async function getRunDiff(
  baselineRunId: string,
  comparisonRunId: string,
  signal?: AbortSignal,
): Promise<RunDiff> {
  const response = await fetch(runDiffUrl(baselineRunId, comparisonRunId), {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as RunDiff;
}
