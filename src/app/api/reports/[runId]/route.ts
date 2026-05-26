/**
 * `GET /api/reports/:runId` — fetch a completed run's Lighthouse report
 * (PRD §6 Phase 2).
 *
 * A `runId` is a job id (each job's id doubles as its report id). The queue
 * returns the full, lhr-bearing {@link AuditResult} for a finished job.
 *
 * Response formats:
 *  - default: the raw Lighthouse Result JSON (`result.median.lhr`) with
 *    `Content-Type: application/json`. This is what the Phase-2 Verify fetches.
 *  - `?format=html`: the rendered Lighthouse HTML report, generated best-effort
 *    by dynamically importing Lighthouse's report generator. Any failure there
 *    returns a structured 500 and never affects the JSON path or the build.
 */

import { notFound, serverError } from "@/lib/api/errors";
import { getAuditQueue } from "@/lib/queue/AuditQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;

  const result = getAuditQueue().getJobResult(runId);
  if (!result) {
    return notFound(
      "report_not_found",
      `No completed report found for run "${runId}".`,
    );
  }

  const lhr = result.median.lhr;
  const format = new URL(request.url).searchParams.get("format");

  if (format === "html") {
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
        lhr as unknown as Parameters<typeof ReportGenerator.generateReport>[0],
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
  return Response.json(lhr, { status: 200 });
}
