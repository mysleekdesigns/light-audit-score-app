/**
 * `GET /api/reports/:runId` — fetch a completed run's Lighthouse report
 * (PRD §6 Phase 2 & 4).
 *
 * A `runId` is a job id (each job's id doubles as its report id). Reports are
 * served from disk: the queue persists each successful run's raw LHR JSON and a
 * rendered standalone HTML report under `./data/reports/` (see
 * `@/lib/db/persistence`), and we stream those files straight back. For runs
 * that are still in-flight (or that ran before persistence existed and were
 * never written to disk) we fall back to the in-memory {@link AuditResult} held
 * by the queue.
 *
 * Response formats:
 *  - default: the raw Lighthouse Result JSON with `Content-Type:
 *    application/json` — read verbatim from the persisted file when present,
 *    else `result.median.lhr` from the in-memory result.
 *  - `?format=html`: the standalone Lighthouse HTML report — read verbatim from
 *    the persisted file when present, else generated best-effort by dynamically
 *    importing Lighthouse's report generator. Any generation failure returns a
 *    structured 500 and never affects the JSON path or the build.
 */

import { promises as fs } from "node:fs";

import { notFound, serverError } from "@/lib/api/errors";
import { getRunReport } from "@/lib/db/persistence";
import { getAuditQueue } from "@/lib/queue/AuditQueue";

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
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;

  const persisted = getRunReport(runId);
  const format = new URL(request.url).searchParams.get("format");

  if (format === "html") {
    // 1. Serve the persisted standalone HTML report when it exists on disk.
    if (persisted?.htmlPath) {
      const html = await readPersistedFile(persisted.htmlPath);
      if (html !== null) {
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // 2. Fall back to the in-memory result, generating HTML inline.
    const result = getAuditQueue().getJobResult(runId);
    if (!result) {
      return notFound(
        "report_not_found",
        `No completed report found for run "${runId}".`,
      );
    }

    try {
      // Dynamic import keeps Lighthouse's heavy report generator out of the
      // module graph unless HTML is actually requested. Lighthouse v13 exports
      // `ReportGenerator` as a named export; `generateReport(lhr, "html")`
      // returns the standalone HTML string.
      const { ReportGenerator } = await import(
        "lighthouse/report/generator/report-generator.js"
      );
      // `lhr` is a loose `LighthouseResult` (Record<string, unknown>) in our
      // engine contract; cast to the generator's expected LHResult shape.
      const html = ReportGenerator.generateReport(
        result.median.lhr as unknown as Parameters<
          typeof ReportGenerator.generateReport
        >[0],
        "html",
      ) as string;
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch {
      return serverError(
        "report_generation_failed",
        "Failed to generate the HTML report.",
      );
    }
  }

  // Default: raw Lighthouse Result JSON.
  // 1. Serve the persisted LHR JSON verbatim when it exists on disk.
  if (persisted?.jsonPath) {
    const json = await readPersistedFile(persisted.jsonPath);
    if (json !== null) {
      return new Response(json, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // 2. Fall back to the in-memory result's median LHR.
  const result = getAuditQueue().getJobResult(runId);
  if (!result) {
    return notFound(
      "report_not_found",
      `No completed report found for run "${runId}".`,
    );
  }

  return Response.json(result.median.lhr, { status: 200 });
}
