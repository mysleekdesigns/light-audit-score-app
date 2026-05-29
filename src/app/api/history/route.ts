/**
 * `GET /api/history` — list every persisted run, newest first (PRD §5/§6
 * Phase 4).
 *
 * Backs the History page: each successful or failed run the queue has persisted
 * (see `@/lib/db/persistence`) is returned as a flattened {@link HistoryRow},
 * with median scores as columns and flags for whether stored JSON/HTML reports
 * exist (fetchable via `GET /api/reports/:runId`). Reads degrade to an empty
 * list on any DB error — the listing never throws.
 */

import { apiError } from "@/lib/api/errors";
import { clearHistory, listHistory } from "@/lib/db/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ runs: listHistory() }, { status: 200 });
}

/**
 * `DELETE /api/history` — clear ALL persisted history (every run + batch and
 * their stored report files). Returns the counts removed. Schedules are left
 * untouched.
 */
export async function DELETE(): Promise<Response> {
  const cleared = await clearHistory();
  return Response.json({ cleared }, { status: 200 });
}

// Reject unsupported methods with a structured 405 rather than Next's default.
export async function POST(): Promise<Response> {
  return apiError(405, "method_not_allowed", "Use GET to list history.");
}
