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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;

  let lhr: LighthouseResult | null = null;

  // 1. The persisted LHR on disk.
  const persisted = getRunReport(runId);
  if (persisted?.jsonPath) {
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
    return Response.json(extractRunTrace(lhr, runId), { status: 200 });
  } catch {
    return serverError(
      "trace_extraction_failed",
      "The stored report for that run could not be read as a trace.",
    );
  }
}
