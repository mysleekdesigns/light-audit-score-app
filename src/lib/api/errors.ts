/**
 * Structured error envelope for the Phase-2 API layer (PRD §5).
 *
 * Every route handler funnels its failure responses through {@link apiError} (or
 * one of the small status-specific helpers below) so that:
 *  - the JSON body always matches the {@link ApiErrorBody} contract
 *    (`{ error: { message, code, issues? } }`), and
 *  - no raw stack traces / internal details ever leak to the client.
 *
 * Keep this module free of Next.js / queue imports: it only constructs Web
 * `Response`s, so it stays trivially unit-testable.
 */

import type { ApiErrorBody, ApiErrorIssue } from "@/lib/queue/types";

/**
 * Build a JSON error `Response` whose body matches {@link ApiErrorBody}.
 *
 * @param status  HTTP status code (e.g. 400, 404, 500).
 * @param code    Stable machine-readable error code (e.g. `"batch_not_found"`).
 * @param message Human-readable description (safe to surface to the user).
 * @param issues  Optional per-field validation issues (for 400 responses).
 */
/**
 * Headers every error response carries.
 *
 * `no-store` because a bare 4xx is heuristically cacheable under RFC 9111, and
 * these are the wrong responses to cache: a `404 report_not_found` for a run id
 * that exists a moment later (a run still finishing, a report being written) is
 * a correctness bug, not merely a security nicety. Set here rather than per
 * route so it holds for every handler at once — the success paths that need it
 * (`/trace`, `/diff`) set their own, since they carry rather more than a code.
 *
 * Raised by ROADMAP Phase E's security review (S2), which observed that
 * `nosniff` already applies globally via `next.config.ts` but `no-store` reached
 * only the 200s.
 */
const ERROR_HEADERS = { "Cache-Control": "no-store" } as const;

export function apiError(
  status: number,
  code: string,
  message: string,
  issues?: ApiErrorIssue[],
): Response {
  const body: ApiErrorBody = {
    error: {
      message,
      code,
      // Only attach `issues` when there are some, to keep the envelope clean.
      ...(issues && issues.length > 0 ? { issues } : {}),
    },
  };
  return Response.json(body, { status, headers: ERROR_HEADERS });
}

/** 400 Bad Request — malformed/invalid input. Pass `issues` for field errors. */
export function badRequest(
  code: string,
  message: string,
  issues?: ApiErrorIssue[],
): Response {
  return apiError(400, code, message, issues);
}

/** 404 Not Found — the addressed resource (batch/report) does not exist. */
export function notFound(code: string, message: string): Response {
  return apiError(404, code, message);
}

/** 500 Internal Server Error — an unexpected failure; never leaks internals. */
export function serverError(code: string, message: string): Response {
  return apiError(500, code, message);
}
