/**
 * Typed browser-side client for the Phase-2 audit API (PRD §6 Phase 3).
 *
 * The single seam UI code uses to talk to the route handlers — it owns request
 * shaping, response typing, and turning the structured {@link ApiErrorBody}
 * envelope into a throwable {@link ApiError}. Live progress is consumed
 * separately via the SSE hook (`useBatchStream`); this module covers the
 * request/response endpoints (`POST /api/audits`, `GET /api/audits/:id`) plus
 * report URL helpers.
 */

import type { AuditOptions } from "@/lib/lighthouse/types";
import type { ApiErrorBody, ApiErrorIssue, Batch } from "@/lib/queue/types";

/** Body accepted by {@link createBatch}; mirrors `POST /api/audits` (options/concurrency optional). */
export interface CreateBatchRequest {
  urls: string[];
  options?: Partial<AuditOptions>;
  concurrency?: number;
}

/** Thrown by every client call on a non-2xx response; carries the structured envelope. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: ApiErrorIssue[];

  constructor(
    status: number,
    code: string,
    message: string,
    issues: ApiErrorIssue[] = [],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

/** Parse a failed `Response` into an {@link ApiError}, tolerating non-JSON bodies. */
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

/** Create an audit batch and return its initial snapshot. Throws {@link ApiError} on failure. */
export async function createBatch(input: CreateBatchRequest): Promise<Batch> {
  const response = await fetch("/api/audits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as Batch;
}

/** Fetch the current snapshot of a batch. Throws {@link ApiError} (e.g. 404) on failure. */
export async function getBatch(id: string): Promise<Batch> {
  const response = await fetch(`/api/audits/${encodeURIComponent(id)}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as Batch;
}

/** URL of the raw Lighthouse Result JSON for a completed run. */
export function reportJsonUrl(runId: string): string {
  return `/api/reports/${encodeURIComponent(runId)}`;
}

/** URL of the rendered standalone Lighthouse HTML report for a completed run. */
export function reportHtmlUrl(runId: string): string {
  return `/api/reports/${encodeURIComponent(runId)}?format=html`;
}
