/**
 * `GET /api/reports/:runId/trace` — the request waterfall + loading filmstrip
 * for one completed run, as a compact {@link RunTrace} (ROADMAP Phase D).
 *
 * **Why this exists instead of reusing `GET /api/reports/:runId`.** That route
 * serves the stored LHR verbatim, and stored reports in this repo average ~690 KB
 * and reach 1.5 MB. Drawing a waterfall in the browser from one would mean
 * shipping the whole report over the wire and parsing it client-side, for two
 * audits' worth of data. So the projection runs HERE, server-side, and only the
 * ~20 KB `RunTrace` crosses the wire. That is the whole justification for
 * `@/lib/reports/types` existing as a separate contract.
 *
 * It is also what makes the detail sheet's Trace tab a LAZY read: `/history`
 * never touches a report file, and the tab pays for exactly one fetch when the
 * user opens it (the client caches the immutable result for the run).
 *
 * Degradation ladder, mirroring `GET /api/reports/:runId`:
 *  1. the persisted LHR on disk (`getRunReport(runId).jsonPath`), read through a
 *     never-throwing helper so an absent file falls through rather than 500ing;
 *  2. the in-memory queue result (`result.median.lhr`) — this is what makes the
 *     tab work for a run that just finished, or one that predates persistence;
 *  3. `404 report_not_found` when neither has an LHR.
 *
 * A report file that is PRESENT but unparseable is the one case that does not
 * fall through: an absent report is ordinary (a legacy or pruned run), a corrupt
 * one is a real fault worth surfacing, so it returns a structured
 * `500 report_unreadable` rather than being masked by an in-memory result that
 * only exists for the few minutes after a run.
 *
 * No request data is reflected into any error body (`.claude/rules/security.md`)
 * — including the run id, which is caller-supplied. The route needs no auth of
 * its own: `src/proxy.ts` gates every non-`_next` route.
 */

import { promises as fs } from "node:fs";

import { notFound, serverError } from "@/lib/api/errors";
import { getRunReport } from "@/lib/db/persistence";
import type { LighthouseResult } from "@/lib/lighthouse/types";
import { getAuditQueue } from "@/lib/queue/AuditQueue";
import { extractRunTrace } from "@/lib/reports/extract";
import type { RunTrace } from "@/lib/reports/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read a persisted report file, returning `null` (rather than throwing) when the
 * file is absent or unreadable — so the caller falls through to the in-memory
 * fallback instead of surfacing a 500 for a run that simply isn't on disk.
 */
async function readPersistedFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Refuse to read a report far larger than one can legitimately be. Observed max
 * in this repo is 1.5 MB, so 32 MB is not a limit anyone meets by accident — it
 * exists so a corrupt or hostile file on disk cannot be pulled into memory in
 * full before anything gets to reject it.
 */
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

/** Whether the file at `path` is small enough to read. Missing file → let the read fall through. */
async function withinSizeLimit(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).size <= MAX_REPORT_BYTES;
  } catch {
    return true;
  }
}

/**
 * Bounded memo of projections, keyed by run id.
 *
 * A finished run's report is immutable — the docblock above says so and
 * `useRunTrace` caches on exactly that basis — but the server was re-reading and
 * re-parsing a ~690 KB file on every request, and that parse is synchronous, so
 * it occupies the event loop. That matters more than a single user implies:
 * cookies ignore ports and `SameSite=Strict` is scoped to the site rather than
 * the port, so a page on ANOTHER loopback port can fire credentialed GETs at
 * this route. CORS stops it reading the response; it does not stop it causing
 * the work. Sixteen entries is comfortably more than a session opens and bounds
 * the memory at a few MB of projections.
 */
const TRACE_CACHE_LIMIT = 16;
const traceCache = new Map<string, RunTrace>();

function cacheGet(runId: string): RunTrace | undefined {
  const hit = traceCache.get(runId);
  // Re-insert so the eviction below is least-recently-USED, not merely oldest.
  if (hit !== undefined) {
    traceCache.delete(runId);
    traceCache.set(runId, hit);
  }
  return hit;
}

function cacheSet(runId: string, trace: RunTrace): void {
  traceCache.set(runId, trace);
  while (traceCache.size > TRACE_CACHE_LIMIT) {
    const oldest = traceCache.keys().next();
    if (oldest.done) break;
    traceCache.delete(oldest.value);
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;

  const persisted = getRunReport(runId);

  // A memo hit is honoured only while the run STILL RESOLVES. Deleting a run —
  // or "Clear history" — must actually remove it, and an in-process cache is
  // exactly how a deleted run's URLs keep being served for the life of the
  // process; ROADMAP Phase C's M2 (clearing history left audited URLs behind in
  // `schedule_alerts`) is the standing precedent. The cheap DB lookup above
  // stays authoritative for EXISTENCE; the memo only saves the expensive part,
  // which is the ~690 KB read and parse.
  const resolves =
    persisted?.jsonPath != null ||
    getAuditQueue().getJobResult(runId) !== undefined;
  if (!resolves) {
    traceCache.delete(runId);
    return notFound(
      "report_not_found",
      "No completed report found for that run.",
    );
  }

  const cached = cacheGet(runId);
  if (cached !== undefined) return Response.json(cached, { status: 200 });

  let lhr: LighthouseResult | null = null;

  // 1. The persisted LHR on disk.
  if (persisted?.jsonPath) {
    if (!(await withinSizeLimit(persisted.jsonPath))) {
      return serverError(
        "report_unreadable",
        "The stored report for that run is too large to read.",
      );
    }
    const json = await readPersistedFile(persisted.jsonPath);
    if (json !== null) {
      try {
        lhr = JSON.parse(json) as LighthouseResult;
      } catch {
        return serverError(
          "report_unreadable",
          "The stored report for that run could not be parsed.",
        );
      }
    }
  }

  // 2. The in-memory queue result, for an in-flight or never-persisted run.
  if (!lhr) {
    lhr = getAuditQueue().getJobResult(runId)?.median.lhr ?? null;
  }

  if (!lhr) {
    return notFound(
      "report_not_found",
      "No completed report found for that run.",
    );
  }

  // The extractors are contractually total — a report missing either audit
  // yields `unavailable: true` and empty collections rather than throwing. This
  // guard is the backstop for an LHR that is valid JSON but not a report at all
  // (a hand-edited file, a truncated write), which must still be a structured
  // 500 and never an unhandled rejection.
  try {
    // Echo the DB-round-tripped id, never the caller's string. A 200 is only
    // reachable for an id that already matched a row or a queue key, so the two
    // are equal in practice — but "no request data is reflected" should be true
    // of the success body as well, not just the error bodies.
    const trace = extractRunTrace(lhr, persisted?.id ?? runId);
    cacheSet(runId, trace);
    return Response.json(trace, { status: 200 });
  } catch {
    return serverError(
      "trace_extraction_failed",
      "The stored report for that run could not be read as a trace.",
    );
  }
}
