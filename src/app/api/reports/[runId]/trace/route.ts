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
 * The read itself — the degradation ladder (disk → in-memory queue → 404), the
 * DB-resolved path so caller input never reaches `path.join`, the peak-memory
 * ceiling, and the rule that a PRESENT but corrupt report is a 500 rather than a
 * fall-through — lives in `@/lib/reports/loadReport`. It was extracted there when
 * ROADMAP Phase E's diff route needed the same posture for two runs at once;
 * this route's behaviour is unchanged.
 *
 * No request data is reflected into any error body (`.claude/rules/security.md`)
 * — including the run id, which is caller-supplied. The route needs no auth of
 * its own: `src/proxy.ts` gates every non-`_next` route.
 */

import { notFound, serverError } from "@/lib/api/errors";
import { extractRunTrace } from "@/lib/reports/extract";
import { loadRunLhr, runReportResolves } from "@/lib/reports/loadReport";
import type { RunTrace } from "@/lib/reports/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A trace embeds the filmstrip — actual screenshots of the audited page, which
 * may be a logged-in or staging one (ROADMAP Phase B made authenticated audits
 * a first-class case). That should not sit in a disk cache or an intermediary,
 * so the header is explicit rather than inherited from whatever a
 * `force-dynamic` route handler happens to emit.
 */
const TRACE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

/** A `RunTrace` as a JSON 200 with the headers above. */
function traceResponse(trace: RunTrace): Response {
  return new Response(JSON.stringify(trace), { status: 200, headers: TRACE_HEADERS });
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
 * the work. Confirmed by experiment, not inferred: a page served on
 * 127.0.0.1:3412 issuing a `no-cors`, `credentials: "include"` fetch at the app
 * on 127.0.0.1:3411 was answered 200, cookie attached.
 *
 * Sixteen entries is comfortably more than a session opens, and bounds the
 * memory at a few MB of projections.
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

  // A memo hit is honoured only while the run STILL RESOLVES. Deleting a run —
  // or "Clear history" — must actually remove it, and an in-process cache is
  // exactly how a deleted run's URLs keep being served for the life of the
  // process; ROADMAP Phase C's M2 (clearing history left audited URLs behind in
  // `schedule_alerts`) is the standing precedent. The cheap DB lookup stays
  // authoritative for EXISTENCE; the memo only saves the expensive part, which
  // is the ~690 KB read and parse.
  if (!runReportResolves(runId)) {
    traceCache.delete(runId);
    return notFound(
      "report_not_found",
      "No completed report found for that run.",
    );
  }

  const cached = cacheGet(runId);
  if (cached !== undefined) return traceResponse(cached);

  const loaded = await loadRunLhr(runId);
  if (loaded.status === "error") {
    if (loaded.reason === "not_found") {
      return notFound(
        "report_not_found",
        "No completed report found for that run.",
      );
    }
    return serverError(
      "report_unreadable",
      loaded.reason === "too_large"
        ? "The stored report for that run is too large to read."
        : "The stored report for that run could not be parsed.",
    );
  }

  // The extractors are contractually total — a report missing either audit
  // yields `unavailable: true` and empty collections rather than throwing. This
  // guard is the backstop for an LHR that is valid JSON but not a report at all
  // (a hand-edited file, a truncated write), which must still be a structured
  // 500 and never an unhandled rejection.
  try {
    // Echo the id `loadRunLhr` resolved, not the raw parameter: the DB
    // round-trip when the report came from disk, and — for the queue fallback,
    // where there is no row to round-trip through — a string that reached us
    // only by matching an existing nanoid job key exactly. A 200 is unreachable
    // otherwise, so the two are equal in practice, but "no request data is
    // reflected" should hold on the success body too, not just the errors.
    const trace = extractRunTrace(loaded.lhr, loaded.runId);
    cacheSet(runId, trace);
    return traceResponse(trace);
  } catch {
    return serverError(
      "trace_extraction_failed",
      "The stored report for that run could not be read as a trace.",
    );
  }
}
