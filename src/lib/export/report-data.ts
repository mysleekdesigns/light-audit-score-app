/**
 * Client-report assembly (ROADMAP Phase H).
 *
 * The Node-only half of the seam `./report-model.ts` describes: it reads the
 * SQLite archive and the stored LHRs and produces one {@link ClientReport}, the
 * literal value `./report-html.ts` renders. Nothing here knows what the document
 * looks like, and nothing in the renderer knows what a disk is.
 *
 * Three rules shape everything below.
 *
 * **The numbers are the app's numbers.** Every aggregate comes from
 * `@/lib/batch-summary/summary` — the same functions the on-screen Batch Summary
 * calls, with the same rows and the same thresholds — and every per-page score
 * comes from the `HistoryRow` the History and Batch views read. That is not
 * laziness: a report a client can hold beside the dashboard has to agree with it
 * to the digit, and a second implementation of "mean of the present categories"
 * is how two surfaces end up disagreeing about a page that scored 89.5. It also
 * means the tie-breaking matches: {@link bestWorstPages} resolves a tie to the
 * FIRST row it sees, so the rows are kept in the app's own order (newest run
 * first, exactly what `listHistory()` yields) rather than reversed into
 * oldest-first. Reversing them would silently pick a different "best page" from
 * the card the user just looked at.
 *
 * **The caps truncate the DOCUMENT, not the summary.** `REPORT_CAPS.pages` bounds
 * how many pages are printed; the batch-level aggregates still describe the whole
 * batch, because `ReportSummary.averageScores`'s contract is "the Batch Summary's
 * own numbers" and a report whose header silently re-averaged a subset would be a
 * different claim about the site. What the caps leave out is stated in
 * {@link ClientReport.notes} instead — a sentence, in our words, only when
 * something was actually dropped.
 *
 * **Reports are read one at a time.** A stored LHR averages ~690 KB here and
 * reaches 1.5 MB, and `loadRunLhr` holds the text, the parsed object graph and
 * the projection live at once. Sixty of those in a `Promise.all` is a
 * several-hundred-megabyte spike on a machine that is also running Chrome; the
 * sequential loop in {@link buildClientReport} costs a few seconds and bounds the
 * peak to one report.
 *
 * **The document is going to leave this machine, so URLs are redacted.** Every
 * request path, the audited URL and its redirect target run through
 * `redactForExport` (`@/lib/redactUrl`) before they are capped: `user:pass@` is
 * dropped, and the VALUE of any credential-, signature- or session-shaped query
 * parameter becomes `[redacted]` while the parameter's NAME survives. Keeping the
 * name is the point — the auditor needs to see that a token was in that URL so
 * they can re-audit without it, rather than send a file that merely looks clean.
 * Ordinary parameters are untouched, because in a waterfall the query IS data:
 * `app.js?v=3` and `app.js?v=4` are two different rows and must stay that way.
 *
 * This is a net, not a guarantee — parameter names are an unbounded space, and
 * `code`/`state` are deliberately excluded as too noisy on ordinary sites (see
 * `CREDENTIAL_PARAM_NAME`). What closes the gap is disclosure rather than
 * filtering: the docs chapter and the export itself tell the user the file
 * carries the audited pages' request URLs and screenshots of them, so a run
 * against an authenticated or internal target gets a look before it is sent.
 *
 * SECURITY: this module is where the contract's "already flattened" promise is
 * kept. Everything the audited page could have chosen — its URL, its redirect
 * target, a Chrome error message that quotes it, every request path and host, an
 * opportunity's display value — goes through `safeText` from
 * `@/lib/text/displaySafe` with a per-field ceiling before it reaches a
 * {@link ClientReport}. The renderer escapes as well; this is the layer that
 * stops a control character or an RTL override from reaching the file at all,
 * and the ceilings are what stop one page's pathological URL from being a
 * megabyte of the document. Credentials never enter: `HistoryRow.options` can
 * carry Phase B auth (`extraHeaders`, `cookies`, `basicAuth`), so no part of it
 * is copied into the report — only `BatchInfo.options`' non-secret run shape
 * (device, throttling, runs) is read, one scalar at a time.
 */

import {
  averageScores,
  bestWorstPages,
  GOOD_THRESHOLD_FALLBACK,
  overallScore,
  pagesClearingThresholds,
  passFail,
  rowClearsThresholds,
} from "@/lib/batch-summary/summary";
import {
  listBatches,
  listHistory,
  type BatchInfo,
  type HistoryRow,
} from "@/lib/db/persistence";
import type { BatchStatus } from "@/lib/queue/types";
import {
  ABSENT_VALUE,
  CLIENT_REPORT_VERSION,
  EMPTY_BRANDING,
  REPORT_CAPS,
  sanitizeLogoDataUri,
  type ClientReport,
  type ReportBranding,
  type ReportFilmstrip,
  type ReportHighlight,
  type ReportMetric,
  type ReportOpportunity,
  type ReportPage,
  type ReportProvenance,
  type ReportRequest,
  type ReportSummary,
  type ReportWaterfall,
  type TraceOmission,
} from "@/lib/export/report-model";
import { throttlingMethodLabel } from "@/lib/lighthouse/environment-format";
import { parseLhr } from "@/lib/lighthouse/parseLhr";
import {
  LIGHTHOUSE_CATEGORIES,
  type FormFactor,
  type LighthouseCategory,
  type Opportunity,
} from "@/lib/lighthouse/types";
import { extractFilmstrip, extractWaterfall } from "@/lib/reports/extract";
import { loadRunLhr } from "@/lib/reports/loadReport";
import type {
  FilmstripData,
  FilmstripFrame,
  WaterfallData,
  WaterfallRequest,
} from "@/lib/reports/types";
import { redactForExport } from "@/lib/redactUrl";
import { METRIC_DISPLAY_ORDER, METRIC_META } from "@/lib/scores";
import type { CategoryThresholds } from "@/lib/settings/defaults";
import { safeText } from "@/lib/text/displaySafe";

/**
 * Per-field character ceilings for the strings the audited page controls.
 *
 * Flattening alone is not enough: a page is free to serve a 40 KB URL, and forty
 * waterfall rows of those is a megabyte of document for no information. The
 * numbers are generous enough that a real value is never clipped (the longest
 * request path across this repo's stored reports is under 200 characters) and
 * small enough that a hostile one cannot dominate the file. `safeText` appends an
 * ellipsis when it clips, so a truncated value reads as truncated.
 */
const TEXT_CAPS = {
  url: 300,
  errorMessage: 400,
  requestPath: 200,
  host: 120,
  resourceType: 40,
  /** Lighthouse's own strings, capped for layout rather than for safety. */
  opportunityId: 64,
  opportunityTitle: 160,
  opportunityDescription: 400,
  opportunityDisplayValue: 80,
  metricDisplayValue: 40,
  lighthouseVersion: 32,
  /** The auditor's own settings — flattened so a stray newline can't split the header. */
  brandingTitle: 120,
  brandingSubtitle: 200,
} as const;

// --- Batch-level display values ---------------------------------------------

/**
 * Fill a partial threshold map out to the full record the report prints.
 *
 * Values the caller supplied are passed through UNCHANGED — not clamped, not
 * rounded. The report has to be judged against the same bars the app judged
 * against (the caller reads them from the user's settings, where they were
 * already sanitised), and quietly rounding 89.5 to 90 here would flip a page
 * from fail to pass in the exported file only. A missing or non-finite entry
 * falls back to {@link GOOD_THRESHOLD_FALLBACK}, the same 90 the Batch Summary
 * uses when a category has no configured bar.
 */
export function resolveThresholds(
  thresholds: Partial<Record<LighthouseCategory, number>> = {},
): CategoryThresholds {
  return LIGHTHOUSE_CATEGORIES.reduce((resolved, category) => {
    const value = thresholds[category];
    resolved[category] =
      typeof value === "number" && Number.isFinite(value)
        ? value
        : GOOD_THRESHOLD_FALLBACK;
    return resolved;
  }, {} as CategoryThresholds);
}

/**
 * The device line for the provenance block, derived from the RUNS rather than
 * from `batch.options.formFactor`.
 *
 * The options only record a single representative device, so a `"both"` batch —
 * every URL audited on mobile AND desktop (PRD §6 Phase 12) — would be labelled
 * with whichever one happened to be resolved, and the report would claim half of
 * what it shows. The Batch Summary card derives its own label the same way, from
 * the rows. The `fallback` covers a batch with no persisted runs at all.
 */
export function deviceLabel(rows: HistoryRow[], fallback: FormFactor): string {
  const mobile = rows.some((row) => row.formFactor === "mobile");
  const desktop = rows.some((row) => row.formFactor === "desktop");
  if (mobile && desktop) return "Mobile + Desktop";
  if (desktop) return "Desktop";
  if (mobile) return "Mobile";
  return fallback === "desktop" ? "Desktop" : "Mobile";
}

/**
 * The throttling line, preferring what Lighthouse actually applied.
 *
 * A run's `environment.throttlingMethod` is read back out of the LHR's resolved
 * config, so it reflects the run rather than the request — the same value the
 * environment badge shows, formatted by the same helper. Only when no run
 * recorded one (legacy rows, a batch that failed outright) does this fall back to
 * the batch's requested option, in the form's own words.
 */
export function throttlingLabel(batch: BatchInfo, rows: HistoryRow[]): string {
  const applied = rows.find((row) => row.environment?.throttlingMethod)?.environment
    ?.throttlingMethod;
  if (applied) return throttlingMethodLabel(applied);
  return batch.options.throttling === "applied" ? "Applied" : "Simulated";
}

/**
 * Flatten the auditor's own header block and enforce the one invariant the
 * contract puts on it: a logo is a `data:` image or it is nothing.
 *
 * The report must render with the network disabled — an `http(s)` logo would be
 * a broken image in the first thing a client looks at, and would phone home from
 * the recipient's machine every time the file is opened. The renderer checks
 * again rather than trusting its input; this is the check that decides.
 */
export function sanitizeBranding(branding: ReportBranding): ReportBranding {
  return {
    title: safeText(branding.title, TEXT_CAPS.brandingTitle),
    subtitle: safeText(branding.subtitle, TEXT_CAPS.brandingSubtitle),
    // The SAME function the settings store and the Settings panel call, so all
    // three state one policy about this value instead of three. They previously
    // did not: this layer tested only the 22-character prefix while its docblock
    // called itself "the check that decides", so a caller handing
    // `buildClientReport` its own branding — a future CLI or MCP export path —
    // got neither the size cap nor the base64-canonicality check. Phase H's
    // security review demonstrated it with
    // `data:image/png;base64,"><img src=x onerror=alert(1)>` passing through
    // byte-for-byte. Escaped on render, so a broken image rather than an
    // injection, but not what the comment promised.
    //
    // The renderer must keep whatever survives here in an `<img>` — never an
    // `href`, an `<object>` or an `<iframe>`.
    logoDataUri: sanitizeLogoDataUri(branding.logoDataUri),
    showDate: branding.showDate,
  };
}

// --- Per-page projections ----------------------------------------------------

/**
 * Sample a filmstrip down to `cap` frames across its FULL extent, always keeping
 * the first frame, the last frame and the LCP frame.
 *
 * Taking the first N frames instead would be both simpler and wrong: Lighthouse
 * captures thumbnails at a fixed cadence, so the first eight of a thirty-frame
 * strip are the first fraction of the load — a blank page eight times over — and
 * the part a client actually asks about (what the page looked like when it
 * finally settled) is exactly what gets dropped.
 *
 * The even sample is `round(i × (n−1) / (cap−1))`, which puts endpoints in by
 * construction and, because the step exceeds 1 whenever `n > cap`, never
 * collides. The LCP frame is then swapped in over the nearest INTERIOR pick, so
 * gaining it never costs the strip an end.
 */
export function sampleFrames(
  frames: FilmstripFrame[],
  cap: number = REPORT_CAPS.frames,
): FilmstripFrame[] {
  if (cap <= 0 || frames.length === 0) return [];
  if (frames.length <= cap) return [...frames];

  const last = frames.length - 1;
  const lcpIndex = frames.findIndex((frame) => frame.isLcp);

  // Degenerate cap: one frame can only be the one that matters most.
  if (cap === 1) return [frames[lcpIndex >= 0 ? lcpIndex : 0]];

  const kept = new Set<number>();
  for (let i = 0; i < cap; i += 1) {
    kept.add(Math.round((i * last) / (cap - 1)));
  }

  if (lcpIndex >= 0 && !kept.has(lcpIndex)) {
    const interior = [...kept].filter((index) => index !== 0 && index !== last);
    // `cap >= 3` always leaves an interior slot; at cap 2 the two endpoints are
    // the whole budget and keeping them beats marking the LCP.
    if (interior.length > 0) {
      const nearest = interior.reduce((best, index) =>
        Math.abs(index - lcpIndex) < Math.abs(best - lcpIndex) ? index : best,
      );
      kept.delete(nearest);
      kept.add(lcpIndex);
    }
  }

  return [...kept].sort((a, b) => a - b).map((index) => frames[index]);
}

/**
 * Narrow Phase D's filmstrip projection to the report's. The frame `data` is
 * passed through untouched: `extractFilmstrip` admits only strings that start
 * `data:image/jpeg;base64,`, and running it through a text cap would corrupt
 * every thumbnail into a broken image.
 */
export function toReportFilmstrip(data: FilmstripData): ReportFilmstrip {
  const frames = sampleFrames(data.frames).map((frame) => ({
    timingMs: frame.timingMs,
    data: frame.data,
    isLcp: frame.isLcp,
  }));
  return {
    frames,
    lcpMs: data.lcpMs,
    // Equal to the source strip's extent, because the sample always keeps the
    // last frame — read off the kept frames so the bars and the axis cannot drift.
    timelineMs: frames.length === 0 ? null : frames[frames.length - 1].timingMs,
  };
}

/** Narrow one waterfall row to the six fields and a bar a printed page carries. */
export function toReportRequest(request: WaterfallRequest): ReportRequest {
  return {
    // Redacted BEFORE the cap, so a truncation can never leave half a token
    // visible. See the module docblock: 43% of the requests in this repo's own
    // archive carry a query string, and the file this row lands in gets emailed.
    path: safeText(redactForExport(request.path), TEXT_CAPS.requestPath),
    host: safeText(request.host, TEXT_CAPS.host),
    resourceType: safeText(request.resourceType, TEXT_CAPS.resourceType),
    transferSize: request.transferSize,
    startTime: request.startTime,
    endTime: request.endTime,
    renderBlocking: request.renderBlocking,
    thirdParty: request.thirdParty,
  };
}

/**
 * Cap the waterfall to {@link REPORT_CAPS.requests} rows in Lighthouse's own
 * order, while the totals keep describing EVERY request.
 *
 * That asymmetry is the point of the contract's wording: "40 of 312 requests,
 * 4.1 MB" is a true sentence about the page, whereas totals recomputed over the
 * surviving forty rows would understate the weight of the site by whatever the
 * cap happened to remove — a number a client would then quote back.
 */
export function toReportWaterfall(data: WaterfallData): ReportWaterfall {
  return {
    requests: data.requests.slice(0, REPORT_CAPS.requests).map(toReportRequest),
    totalRequests: data.requests.length,
    totalTransferSize: data.totalTransferSize,
    thirdPartyCount: data.thirdPartyCount,
    timelineMs: data.timelineMs,
  };
}

/**
 * Biggest estimated saving first, with unmeasured savings last.
 *
 * `parseLhr` already sorts, but its comparator reads a `null` saving as `0`,
 * which orders an unmeasured opportunity ahead of a real 0 ms one. On a printed
 * "top 5" that is the difference between a row that says how much it is worth
 * and a row that does not, so the ordering is restated here explicitly. Ties keep
 * Lighthouse's own order — `Array.prototype.sort` is stable.
 */
function compareBySavings(a: Opportunity, b: Opportunity): number {
  if (a.savingsMs === null && b.savingsMs === null) return 0;
  if (a.savingsMs === null) return 1;
  if (b.savingsMs === null) return -1;
  return b.savingsMs - a.savingsMs;
}

/** The page's top opportunities, sorted, capped and flattened. */
/**
 * Reduce a Lighthouse description's markdown links to nothing.
 *
 * Nearly every Lighthouse description ends in a `[Learn more about the Time to
 * First Byte metric](https://developer.chrome.com/docs/…)` markdown link. Left
 * alone it reaches the exported document VERBATIM — brackets, parentheses, raw
 * URL and all — because this renderer deliberately emits no anchors for anything
 * that came out of a report. On screen in the app that never showed, since
 * nothing rendered these descriptions; in a file an auditor emails to a client,
 * it is the first thing a reader's eye catches, and it reads like a bug.
 *
 * The three options were: render it as a real link, print `text (url)`, or drop
 * the link markup and keep its sentence. The first is out — the document grants
 * no `script-src` and emits no page-derived hrefs, and a client-facing file that
 * navigates somewhere when clicked is exactly what the security note forbids.
 * The second spends 100–130 characters of a 400-character budget on a
 * documentation URL nobody can click. So: keep the prose, drop the markup.
 *
 * `@/lib/analysis/extract`'s `condenseDescription` made this same call for the
 * same strings and the same reason (its budget is a prompt's rather than a
 * page's). Duplicated rather than imported: that one is a private helper inside
 * the analysis extractor, and this module has no business importing the AI
 * layer to borrow eight characters of regex.
 *
 * Stripping runs BEFORE the cap, so a truncation can never land inside a URL and
 * leave half of one on the page.
 */
export function condenseDescription(value: string): string {
  return value.replace(/\s*\[[^\]]*\]\(\s*https?:\/\/[^)]*\)\s*\.?/g, "");
}

export function toReportOpportunities(
  opportunities: Opportunity[],
): ReportOpportunity[] {
  return [...opportunities]
    .sort(compareBySavings)
    .slice(0, REPORT_CAPS.opportunities)
    .map((opportunity) => ({
      // The id is Lighthouse's own audit key, not page-authored, and the
      // renderer may use it as an anchor — flattened anyway, because it costs
      // nothing on a kebab-case ASCII id and removes the need to trust that.
      id: safeText(opportunity.id, TEXT_CAPS.opportunityId),
      title: safeText(opportunity.title, TEXT_CAPS.opportunityTitle),
      description: safeText(
        condenseDescription(opportunity.description),
        TEXT_CAPS.opportunityDescription,
      ),
      savingsMs: opportunity.savingsMs,
      displayValue: safeText(
        opportunity.displayValue,
        TEXT_CAPS.opportunityDisplayValue,
      ),
      score: opportunity.score,
    }));
}

/**
 * The page's Core Web Vitals, in the app's display order.
 *
 * A measured page emits ALL six metrics — an absent one as {@link ABSENT_VALUE}
 * with null numbers — so every page in the document has the same shape and the
 * renderer can lay out one grid rather than a ragged one. (Lighthouse 13 drops
 * TTI, so that row is a dash on every modern run; the renderer is free to hide a
 * metric that is absent on every page.) A failed run measured nothing at all and
 * returns no metrics, so a failure prints as a failure rather than as six dashes.
 */
export function toReportMetrics(row: HistoryRow): ReportMetric[] {
  const metrics = row.metrics;
  if (metrics === null) return [];

  return METRIC_DISPLAY_ORDER.map((id) => {
    const value = metrics[id] ?? null;
    const displayValue =
      value === null ? "" : safeText(value.displayValue, TEXT_CAPS.metricDisplayValue);
    return {
      id,
      abbr: METRIC_META[id].abbr,
      label: METRIC_META[id].label,
      displayValue: displayValue === "" ? ABSENT_VALUE : displayValue,
      numericValue: value?.numericValue ?? null,
      score: value?.score ?? null,
    };
  });
}

/**
 * What one run's stored report contributed — or the reason it contributed
 * nothing, in the contract's vocabulary.
 *
 * Opportunities and the trace travel together because they come from the same
 * file: if the LHR could not be read there are no opportunities either, and a
 * page that shows a "top opportunities" list but no waterfall would be claiming
 * to have read something it did not.
 */
export type PageTrace =
  | {
      status: "ok";
      opportunities: Opportunity[];
      waterfall: WaterfallData;
      filmstrip: FilmstripData;
      /** `lighthouseVersion` from this LHR; `""` when it recorded none. */
      lighthouseVersion: string;
    }
  | { status: "omitted"; omission: TraceOmission };

/** A run whose report was never looked for, or was not there. */
const NO_REPORT: PageTrace = { status: "omitted", omission: "no-report" };

/**
 * Turn one persisted run plus its stored report into a report page.
 *
 * The `traceOmission` logic is the fiddly part, and it follows the contract
 * exactly: the field is set when BOTH projections are null, and the three
 * reasons are genuinely different sentences to a client. A report we could not
 * read (`unreadable`) is a fault worth mentioning; a report that predates Phase D
 * or came from PSI (`unavailable`) is simply a run with no trace in it; a run
 * that failed or never stored a report (`no-report`) has nothing to have read.
 * A mixed report — a waterfall but no filmstrip — keeps the half it has and
 * carries no omission, because the document is not omitting the page's trace.
 */
export function assemblePage(
  row: HistoryRow,
  trace: PageTrace,
  thresholds: CategoryThresholds,
): ReportPage {
  const waterfall =
    trace.status === "ok" && !trace.waterfall.unavailable
      ? toReportWaterfall(trace.waterfall)
      : null;
  const filmstrip =
    trace.status === "ok" && !trace.filmstrip.unavailable
      ? toReportFilmstrip(trace.filmstrip)
      : null;

  let traceOmission: TraceOmission | null = null;
  if (waterfall === null && filmstrip === null) {
    traceOmission = trace.status === "ok" ? "unavailable" : trace.omission;
  }

  const failed = row.status === "error";

  return {
    runId: row.id,
    // The audited URL itself is the likeliest place for a magic-link or preview
    // token, because it is the one a human typed into the audit form — and
    // `redactForExport` also strips `user:pass@`, which ROADMAP Phase B made a
    // realistic thing to find here.
    url: safeText(redactForExport(row.url), TEXT_CAPS.url),
    // `""` covers both "unknown" and "same as requested": a redirect is worth
    // printing, an echo of the URL above it is noise. Compared BEFORE redaction,
    // so two URLs differing only in a redacted value still collapse to "same".
    finalUrl:
      row.finalUrl === null || row.finalUrl === row.url
        ? ""
        : safeText(redactForExport(row.finalUrl), TEXT_CAPS.url),
    device: row.formFactor,
    source: row.source,
    status: row.status,
    errorMessage:
      row.errorMessage === null
        ? null
        : safeText(row.errorMessage, TEXT_CAPS.errorMessage),
    runs: failed ? null : row.runs,
    fetchTime: failed ? null : row.fetchTime,
    // The History and Batch views read these same fields, so the three surfaces
    // cannot disagree about a page's score.
    scores: { ...row.scores },
    overall: overallScore(row.scores),
    clears: rowClearsThresholds(row, thresholds),
    metrics: toReportMetrics(row),
    opportunities:
      trace.status === "ok" ? toReportOpportunities(trace.opportunities) : [],
    waterfall,
    filmstrip,
    traceOmission,
  };
}

// --- Batch-level assembly ----------------------------------------------------

/** The best/worst page reduced to what the summary prints. */
function toHighlight(row: HistoryRow | null): ReportHighlight | null {
  if (row === null) return null;
  return {
    runId: row.id,
    url: safeText(row.url, TEXT_CAPS.url),
    overall: overallScore(row.scores),
  };
}

/**
 * The batch readout, computed over ALL of the batch's rows.
 *
 * `pageCount` and `errorCount` describe the pages actually printed (the contract
 * says so); everything else is the Batch Summary's own aggregate over the whole
 * batch, so the header of the exported file and the card in the app state the
 * same thing. {@link buildNotes} is what reconciles the two when a cap bites.
 */
export function assembleSummary(
  rows: HistoryRow[],
  pages: ReportPage[],
  thresholds: CategoryThresholds,
): ReportSummary {
  const averages = averageScores(rows);
  const { best, worst } = bestWorstPages(rows);

  return {
    averageScores: averages,
    overall: overallScore(averages),
    passFail: passFail(rows, thresholds),
    clearing: pagesClearingThresholds(rows, thresholds),
    best: toHighlight(best),
    worst: toHighlight(worst),
    pageCount: pages.length,
    errorCount: pages.filter((page) => page.status === "error").length,
  };
}

/** What the caps left out, counted while the pages were assembled. */
export interface TruncationTally {
  /** Pages printed vs. pages in the batch. */
  pages: { shown: number; total: number };
  /** Pages whose waterfall was cut, and the requests they made in total. */
  requests: { pages: number; total: number };
  /** Pages whose filmstrip was sampled, and the frames they captured in total. */
  frames: { pages: number; total: number };
  /** Pages with more opportunities than the cap prints. */
  opportunityPages: number;
  /** True when the best/worst page fell outside the printed pages. */
  highlightOutsidePages: boolean;
  /**
   * The batch's own completeness: its lifecycle state, and how many of the jobs
   * it was created with actually produced a run.
   *
   * Separate from {@link TruncationTally.pages}, which is about the CAP. A
   * cancelled batch is not truncated — those pages were never audited at all,
   * and the two need different sentences.
   */
  batch: { status: BatchStatus; ran: number; total: number };
}

/** `3 pages` / `1 page`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Plain-English notes about what the caps removed — ours, never page-derived,
 * and only ever present when something was genuinely left out.
 *
 * A client-facing document that silently draws forty of three hundred requests
 * is making a claim about the site that is not true. One sentence fixes that,
 * and an empty `notes` array means the document is complete as printed.
 */
export function buildNotes(tally: TruncationTally): string[] {
  const notes: string[] = [];

  // FIRST, because it qualifies every number below it. A batch that never
  // finished is not a smaller audit — it is an incomplete one, and a client
  // reading "5 pages" with no other signal will take it for the whole site.
  // `total` counts JOBS, so a "both" batch (each URL on mobile AND desktop)
  // compares correctly against the run count rather than against a URL count.
  const { status, ran, total } = tally.batch;
  if (status === "cancelled") {
    notes.push(
      total > ran
        ? `This batch was cancelled after ${ran} of its ${total} pages — the rest were never audited, and this report covers only the ${plural(ran, "page")} that ran.`
        : `This batch was cancelled before it finished; it covers only the ${plural(ran, "page")} that ran.`,
    );
  } else if (status === "queued" || status === "running") {
    notes.push(
      `This batch was still ${status === "queued" ? "queued" : "running"} when the report was generated — ${ran} of ${total} pages had finished, so the figures below are provisional.`,
    );
  } else if (ran < total) {
    // A terminal batch that produced fewer runs than jobs: pages were deleted
    // from History, or never persisted. Either way the summary is over what
    // survived, and saying so beats implying the batch was this size.
    notes.push(
      `${ran} of this batch's ${total} pages are in the archive; the rest are no longer stored, so this report covers the ${plural(ran, "page")} still held.`,
    );
  }

  if (tally.pages.shown < tally.pages.total) {
    notes.push(
      `Showing ${tally.pages.shown} of ${tally.pages.total} pages. The summary covers all ${tally.pages.total}.`,
    );
  }
  if (tally.requests.pages > 0) {
    notes.push(
      `Showing ${REPORT_CAPS.requests} of ${tally.requests.total} requests for ${plural(tally.requests.pages, "page")}.`,
    );
  }
  if (tally.frames.pages > 0) {
    notes.push(
      `Sampled ${REPORT_CAPS.frames} of ${tally.frames.total} filmstrip frames for ${plural(tally.frames.pages, "page")}.`,
    );
  }
  if (tally.opportunityPages > 0) {
    notes.push(
      `Showing the top ${REPORT_CAPS.opportunities} opportunities for ${plural(tally.opportunityPages, "page")}.`,
    );
  }
  if (tally.highlightOutsidePages) {
    notes.push("The best or worst page is not among the pages listed below.");
  }

  return notes;
}

/** Everything {@link assembleReport} needs, with no I/O left in it. */
export interface AssembleReportInput {
  batch: BatchInfo;
  /** Every persisted run of the batch, in the app's own order (newest first). */
  rows: HistoryRow[];
  /** Trace payload by run id; a run with no entry reads as `no-report`. */
  traces: Map<string, PageTrace>;
  thresholds: CategoryThresholds;
  branding: ReportBranding;
  generatedAt: Date;
}

/**
 * Build the whole {@link ClientReport} from values already in memory.
 *
 * Pure by design, and exported for that reason: it is the entire shape of the
 * document, testable from literal fixtures with no SQLite and no report files.
 * {@link buildClientReport} is the thin wrapper that fetches its arguments.
 */
export function assembleReport(input: AssembleReportInput): ClientReport {
  const { batch, rows, traces, thresholds, branding, generatedAt } = input;

  const printed = rows.slice(0, REPORT_CAPS.pages);
  const pages = printed.map((row) =>
    assemblePage(row, traces.get(row.id) ?? NO_REPORT, thresholds),
  );
  const summary = assembleSummary(rows, pages, thresholds);

  const tally: TruncationTally = {
    pages: { shown: pages.length, total: rows.length },
    requests: { pages: 0, total: 0 },
    frames: { pages: 0, total: 0 },
    opportunityPages: 0,
    highlightOutsidePages: false,
    // `rows` is what the archive holds for this batch; `batch.total` is what it
    // was created to run. The gap is the honest part.
    batch: { status: batch.status, ran: rows.length, total: batch.total },
  };
  let lighthouseVersion = "";

  for (const row of printed) {
    const trace = traces.get(row.id);
    if (trace === undefined || trace.status !== "ok") continue;

    if (lighthouseVersion === "") lighthouseVersion = trace.lighthouseVersion;
    if (trace.waterfall.requests.length > REPORT_CAPS.requests) {
      tally.requests.pages += 1;
      tally.requests.total += trace.waterfall.requests.length;
    }
    if (trace.filmstrip.frames.length > REPORT_CAPS.frames) {
      tally.frames.pages += 1;
      tally.frames.total += trace.filmstrip.frames.length;
    }
    if (trace.opportunities.length > REPORT_CAPS.opportunities) {
      tally.opportunityPages += 1;
    }
  }

  // Best/worst are chosen over the whole batch (the app's numbers), so above the
  // page cap they can name a run the document does not print — and the summary's
  // anchor into it would then lead nowhere. Say so rather than drop the highlight.
  const printedIds = new Set(pages.map((page) => page.runId));
  tally.highlightOutsidePages = [summary.best, summary.worst].some(
    (highlight) => highlight !== null && !printedIds.has(highlight.runId),
  );

  const provenance: ReportProvenance = {
    source: batch.source,
    device: deviceLabel(rows, batch.options.formFactor),
    throttling: throttlingLabel(batch, rows),
    runs: batch.options.runs,
    lighthouseVersion,
    createdAt: batch.createdAt,
    status: batch.status,
    total: batch.total,
  };

  return {
    version: CLIENT_REPORT_VERSION,
    batchId: batch.id,
    // The 8-char form the Batch Summary card prints, so the file and the app
    // name the same batch.
    shortId: batch.id.slice(0, 8),
    generatedAt: generatedAt.toISOString(),
    branding: sanitizeBranding(branding),
    provenance,
    thresholds,
    summary,
    pages,
    notes: buildNotes(tally),
  };
}

// --- Node-side assembly ------------------------------------------------------

/**
 * Read one run's stored LHR and project it, or say why there is nothing to
 * project. The mapping onto {@link TraceOmission} is the contract's:
 *
 *  - a failed run is never even looked up — it stored no report (`no-report`);
 *  - `not_found` is the ordinary "this run predates persistence, or was pruned"
 *    (`no-report`);
 *  - `too_large` / `unparseable` are real faults — the file was there and we
 *    could not use it (`unreadable`).
 *
 * A report that IS readable but carries no `network-requests` /
 * `screenshot-thumbnails` audit is neither: `extractWaterfall` /
 * `extractFilmstrip` return `unavailable: true` for it, which
 * {@link assemblePage} turns into `unavailable`.
 */
export async function readPageTrace(row: HistoryRow): Promise<PageTrace> {
  if (row.status === "error") return NO_REPORT;

  const loaded = await loadRunLhr(row.id);
  if (loaded.status === "error") {
    return {
      status: "omitted",
      omission: loaded.reason === "not_found" ? "no-report" : "unreadable",
    };
  }

  const parsed = parseLhr(loaded.lhr, row.formFactor);
  return {
    status: "ok",
    opportunities: parsed.opportunities,
    waterfall: extractWaterfall(loaded.lhr),
    filmstrip: extractFilmstrip(loaded.lhr),
    lighthouseVersion: safeText(
      parsed.lighthouseVersion,
      TEXT_CAPS.lighthouseVersion,
    ),
  };
}

/** Arguments for {@link buildClientReport}. */
export interface BuildClientReportArgs {
  batchId: string;
  /** Per-category pass bars; missing entries fall back to 90 per category. */
  thresholds?: Partial<Record<LighthouseCategory, number>>;
  /**
   * The auditor's header block. The CALLER reads it from settings — this module
   * stays out of the settings layer entirely — and it defaults to no header.
   */
  branding?: ReportBranding;
  /** Injectable clock, so a test can assert a stable `generatedAt`. */
  generatedAt?: Date;
}

/**
 * Assemble the client report for one batch, or `null` when no batch has that id
 * (which the route turns into a 404).
 *
 * There is no `getBatch`, so the batch is filtered out of `listBatches()` the
 * same way `/batches` does. The per-run reports are then read ONE AT A TIME —
 * see the module docblock: sixty concurrent multi-megabyte LHRs is a memory
 * spike, not a speed-up, on a machine that is also running Chrome. Only the
 * pages that will actually be printed are read, so the page cap bounds the I/O
 * as well as the document.
 */
export async function buildClientReport(
  args: BuildClientReportArgs,
): Promise<ClientReport | null> {
  const batch = listBatches().find((candidate) => candidate.id === args.batchId);
  if (batch === undefined) return null;

  // `listHistory()` is newest-first and stays that way: the aggregates below are
  // order-sensitive at the margins (best/worst ties), and the report must break
  // them exactly as the Batch Summary card does.
  const rows = listHistory().filter((row) => row.batchId === batch.id);

  const traces = new Map<string, PageTrace>();
  for (const row of rows.slice(0, REPORT_CAPS.pages)) {
    traces.set(row.id, await readPageTrace(row));
  }

  return assembleReport({
    batch,
    rows,
    traces,
    thresholds: resolveThresholds(args.thresholds),
    branding: args.branding ?? EMPTY_BRANDING,
    generatedAt: args.generatedAt ?? new Date(),
  });
}
