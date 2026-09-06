/**
 * `POST /api/export/batch/:batchId` — the client-ready HTML report (ROADMAP Phase H).
 *
 * Assembles one finished batch into a **single self-contained HTML document** —
 * summary, per-URL scores, Core Web Vitals, top opportunities, and Phase D's
 * waterfall + filmstrip — and hands it back as a download. The document renders
 * with the network disabled and prints to a clean PDF from the browser, which is
 * why no PDF library and no headless-render step exist anywhere in this path.
 *
 * The work splits three ways and this route is only the seam between them:
 * `@/lib/export/report-data` reads SQLite and the stored LHRs, `@/lib/settings/branding`
 * supplies the auditor's own header block, and `@/lib/export/report-html`
 * renders. Nothing here knows how any of that is done.
 *
 * **Why POST for what is plainly a read.** The pass thresholds a report is
 * judged against live in the BROWSER — `localStorage`, under
 * `SETTINGS_STORAGE_KEY`, read through `useAuditDefaults` — because they are a
 * per-machine display preference, not audit data. The server has no way to look
 * them up, so the client has to send them, and a batch's worth of per-category
 * bars is a body rather than a query string. The alternative — exporting against
 * the factory 90s — would produce a report whose pass/fail tallies disagreed with
 * the Batch Summary the user was looking at when they clicked Export, which is
 * precisely the mismatch the phase's Gate forbids.
 *
 * A missing, malformed or partial `thresholds` is not an error: `sanitizeThresholds`
 * rebuilds the record from `LIGHTHOUSE_CATEGORIES` and fills every gap from
 * `DEFAULT_THRESHOLDS`, so the export always produces a defensible report rather
 * than a 400 the user cannot act on.
 *
 * SECURITY. The response is an HTML document built from data the AUDITED SITE
 * chose — its URLs, its resource paths, the text in its failures. Three
 * independent things keep that from mattering:
 *
 *  1. `renderClientReport` escapes every interpolated value and emits no href for
 *     a page-derived URL (see the SECURITY NOTE in `@/lib/export/report-model`);
 *  2. the document itself carries a `<meta>` CSP granting no `script-src` at all,
 *     so it is inert wherever it is later opened — including from the client's
 *     own machine, days later, outside anything we control;
 *  3. `Content-Disposition: attachment` means the browser downloads rather than
 *     renders it, so it never executes on the app's origin even momentarily.
 *
 * `next.config.ts` additionally applies {@link CLIENT_REPORT_CSP} to
 * `/api/export/:path*`, for the same reason it applies the Lighthouse report's
 * policy to `/api/reports/:path*`: a header set in the Next config OVERRIDES one
 * a route puts on its own response, so declaring it only here would silently
 * lose it to the baseline policy. The route sets it too — both read the same
 * constant, so they cannot disagree. Note it is NOT the Lighthouse report's
 * policy: that one grants `script-src 'unsafe-inline'` for an interactive
 * document, and this one ships no script at all.
 *
 * No request data is reflected into any error body (`.claude/rules/security.md`),
 * the batch id included. The route needs no auth of its own: `src/proxy.ts` gates
 * every non-`_next` route.
 */

import { notFound, serverError } from "@/lib/api/errors";
import { buildClientReport } from "@/lib/export/report-data";
import { renderClientReport } from "@/lib/export/report-html";
import { reportFileName } from "@/lib/export/report-model";
import { CLIENT_REPORT_CSP } from "@/lib/http/reportCsp";
import { getReportBranding } from "@/lib/settings/branding";
import { sanitizeThresholds } from "@/lib/settings/defaults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A filesystem-safe timestamp slug for the filename (`2026-09-06T13-40-05`).
 *
 * Deliberately a local copy of `timestampSlug` from `@/lib/export/download`
 * rather than an import: that module is `"use client"` and touches `document`,
 * and pulling it into a Node route handler to reuse eight characters of string
 * slicing would drag the DOM layer into the server bundle.
 */
function timestampSlug(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, "-");
}

/**
 * Read the optional `{ thresholds }` body without ever failing on it.
 *
 * A body that is absent, empty, not JSON, or not an object all mean the same
 * thing here — "the caller sent no thresholds" — and every one of them is
 * answered with the defaults rather than a 400. See the module docblock.
 */
async function readThresholds(request: Request): Promise<unknown> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) return undefined;
    return (body as { thresholds?: unknown }).thresholds;
  } catch {
    return undefined;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const { batchId } = await params;
  const thresholds = sanitizeThresholds(await readThresholds(request));

  let html: string;
  let filename: string;
  try {
    const report = await buildClientReport({
      batchId,
      thresholds,
      // The header block is the user's own non-secret preference, read here so
      // the assembler stays free of the settings store entirely. Its own reader
      // degrades to `EMPTY_BRANDING` rather than throwing, so an unreadable
      // preference costs the report its letterhead, never the report.
      branding: getReportBranding(),
    });

    if (report === null) {
      return notFound(
        "batch_not_found",
        "No batch found with that id.",
      );
    }

    html = renderClientReport(report);
    filename = reportFileName(report.shortId, timestampSlug(new Date()));
  } catch (err) {
    // The assembler reads up to sixty stored reports; a corrupt or truncated one
    // is a structured 500 here rather than an unhandled rejection, matching the
    // posture `/api/reports/:runId/trace` takes for the same class of failure.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[export] could not build the batch report: ${message}`);
    return serverError(
      "report_build_failed",
      "The report could not be built. One of this batch's stored reports may be unreadable.",
    );
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The filename is ours — `lighthouse-report-<shortId>-<stamp>.html`, where
      // shortId is a slice of a nanoid — so it needs no quoting dance. Nothing
      // caller-supplied reaches this header.
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Security-Policy": CLIENT_REPORT_CSP,
      // The report embeds filmstrip screenshots of the audited pages, which may
      // be logged-in or staging ones (Phase B). That belongs in no disk cache
      // and no intermediary — the same reasoning the trace route states.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
