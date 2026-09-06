/**
 * The client report renderer (ROADMAP Phase H) — a {@link ClientReport} in, ONE
 * self-contained HTML document out.
 *
 * This is the "rendering" half of the seam described on `./report-model.ts`.
 * Assembly (`./report-data.ts`) reads SQLite and the stored LHRs; this module
 * knows nothing about disks, databases or React, which is what lets it be
 * unit-tested from a literal fixture and imported from anywhere.
 *
 * WHAT "SELF-CONTAINED" MEANS HERE, AND WHY IT IS ABSOLUTE
 * -------------------------------------------------------
 * The output is a FILE an auditor emails to a client. It will be opened on a
 * machine we have never seen, possibly offline, possibly years from now. So the
 * document makes ZERO network requests: the stylesheet is inlined from
 * `./report-css.ts`, every image is a `data:` URI that was already in the report,
 * the fonts are system stacks, and there is no `<link>`, no CDN and no webfont.
 * `report-html.test.ts` asserts all of that rather than trusting it.
 *
 * NO JAVASCRIPT AT ALL
 * --------------------
 * The document ships no `<script>`, so a hypothetical escaping miss has nothing
 * to execute — that is the whole point, and it is why the collapsible page
 * sections are `<details>`/`<summary>` rather than anything scripted. It also
 * means the file survives being opened from `file://`, from an email client's
 * preview pane, or with scripting disabled, all of which are ordinary here.
 *
 * ESCAPING IS UNCONDITIONAL
 * -------------------------
 * Read the SECURITY NOTE at the top of `./report-model.ts` first. A great deal of
 * what lands in this document was chosen by the AUDITED SITE: page URLs, final
 * URLs, error messages, every waterfall path and host, and an opportunity's
 * `displayValue`. Three rules, applied without exception:
 *
 *  1. every interpolated value goes through {@link escapeHtml}, INCLUDING inside
 *     attributes — there is no "this one is ours so it is fine" path;
 *  2. a page-derived URL is printed as TEXT and never becomes an `href`. The only
 *     hrefs in the document are intra-document `#run-…` anchors built from an id
 *     this module validated itself ({@link safeAnchorId});
 *  3. an image `src` is re-validated as a `data:image/…` URI here
 *     ({@link safeImageDataUri}) rather than trusted from the contract — a
 *     `javascript:` or `https:` value is DROPPED, and the slot says so.
 *
 * A locked-down CSP goes in a `<meta>` ({@link REPORT_META_CSP}) as defence in
 * depth BEHIND that escaping, never instead of it.
 *
 * EVERY FUNCTION IS TOTAL
 * -----------------------
 * Same discipline as `@/lib/reports/waterfall-view`: a report with no pages, a
 * page with no metrics, a filmstrip with no frames and a `null` timeline are all
 * ordinary inputs. Each renders a STATED empty state — never a crash, never a
 * misleading blank, and never `NaN%` in a style attribute. Caps applied during
 * assembly (`REPORT_CAPS`) are explained to the reader through `report.notes`,
 * which is why this module prints them verbatim rather than re-deriving them.
 */

import { LIGHTHOUSE_CATEGORIES, type LighthouseCategory } from "@/lib/lighthouse/types";
import {
  barGeometry,
  clampText,
  formatBytes,
  formatDuration,
  hostOf,
  MAX_LABEL,
} from "@/lib/reports/waterfall-view";
import { CATEGORY_LABELS, CATEGORY_SHORT_LABELS, scoreBand, type ScoreBand } from "@/lib/scores";

import { REPORT_CSS } from "./report-css";
import {
  ABSENT_VALUE,
  BRANDING_LIMITS,
  CLIENT_REPORT_VERSION,
  type ClientReport,
  type ReportBranding,
  type ReportFilmstrip,
  type ReportMetric,
  type ReportOpportunity,
  type ReportPage,
  type ReportProvenance,
  type ReportRequest,
  type ReportSummary,
  type ReportWaterfall,
  type TraceOmission,
} from "./report-model";

/* -------------------------------------------------------------------------- */
/* Escaping and URL validation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * HTML-escape a string for use in text content OR in a double- or single-quoted
 * attribute value.
 *
 * All five of `& < > " '` are replaced, not the usual three. The two quote forms
 * are the ones that matter for attributes: escaping only `< > &` is the classic
 * way an "escaped" value still breaks out of `alt='…'`. `&` goes first so the
 * ampersands introduced by the later replacements are not re-escaped.
 *
 * The parameter is typed `string`, but the coercion is deliberate: a
 * {@link ClientReport} can arrive from JSON on disk, and a security boundary that
 * throws on a non-string is a security boundary that can be turned off.
 */
export function escapeHtml(value: string): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The document's Content-Security-Policy, delivered in a `<meta http-equiv>`.
 *
 * Its header counterpart is `CLIENT_REPORT_CSP` in `@/lib/http/reportCsp`, which
 * is this policy plus `frame-ancestors 'none'` — the one directive a `<meta>`
 * policy silently ignores and only a header can carry. The two are deliberately
 * near-identical so the transport never advertises a capability the document
 * disclaims. (They were NOT identical at first: the route reused
 * `HTML_REPORT_CSP`, which grants `script-src 'unsafe-inline'` because
 * Lighthouse's own report is a scripted app. Phase H's review flagged the
 * mismatch and the export path now has its own constant.)
 *
 * This one is the load-bearing half, and it is worth being clear why: the file
 * is served `Content-Disposition: attachment`, so it spends its life on
 * `file://` on someone else's machine, where NO response header applies at all
 * and this `<meta>` is the only policy in play. So:
 *
 *  - there is NO `script-src` at all. `default-src 'none'` therefore denies every
 *    script, which is exactly right for a document that contains none;
 *  - `frame-ancestors` is omitted because it is ignored in a `<meta>` policy —
 *    listing it would only imply a protection the file does not have;
 *  - `img-src data:` covers the filmstrip and the logo, the only images here;
 *  - `connect-src 'none'` + `form-action 'none'` + `base-uri 'none'` mean nothing
 *    in this file can reach the network or be redirected somewhere that can.
 *
 * `style-src 'unsafe-inline'` is unavoidable and harmless: the entire stylesheet
 * is one inline `<style>`, because an external one would be a network request.
 */
export const REPORT_META_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Ids we are willing to put in an `id`/`href` — no dots, colons or spaces. */
const SAFE_ANCHOR_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The intra-document anchor for a run, or `null` when the run id is not a shape
 * we will interpolate.
 *
 * These are the ONLY hrefs in the document, so they are also the only place an
 * attacker-influenced value could reach one. A run id is ours (a uuid), but
 * "ours" is not something the renderer can verify at runtime — a report read back
 * from a JSON file could carry anything — so the id is validated against an
 * explicit allow-list of characters rather than escaped and hoped for. A run that
 * fails validation simply loses its anchor: the summary prints its URL as plain
 * text instead of a link, which costs a reader one scroll and nothing else.
 */
export function safeAnchorId(runId: string): string | null {
  if (typeof runId !== "string" || !SAFE_ANCHOR_ID.test(runId)) return null;
  return `run-${runId}`;
}

/**
 * `data:image/…` URIs only.
 *
 * The contract already promises this (`ReportBranding.logoDataUri`,
 * `ReportFrame.data`) and assembly already enforces it, and we check anyway: this
 * module is the last thing between a stored value and a document someone else
 * opens, and re-validating costs one regex. `javascript:alert(1)` and
 * `https://evil.test/logo.png` both fail — the first because it would be an XSS
 * sink in any element that took a URL, the second because a remote image would
 * phone home from the recipient's machine every time the file is opened and would
 * render as a broken image offline, which is worse than rendering nothing.
 *
 * `image/svg+xml` is REJECTED, and this layer used to be alone in allowing it.
 * The argument for allowing it is sound as far as it goes — an SVG referenced by
 * `<img src>` cannot run script or fetch subresources — but the settings store
 * (`@/lib/settings/branding`) and assembly (`@/lib/export/report-data`) both
 * refuse it, so permitting it here served no purpose except to make three layers
 * state three different policies about one value. Phase H's security review
 * called that out; the allow-list now comes from `BRANDING_LIMITS` so the three
 * cannot disagree again.
 *
 * `;base64,` is required rather than `[;,]`, so `data:image/png,x` — a legal
 * RFC 2397 form we never emit — is refused too. Filmstrip frames are unaffected:
 * `@/lib/reports/extract` pins them to `data:image/jpeg;base64,`.
 *
 * This stays a SHAPE check, not the full `sanitizeLogoDataUri`: it also guards
 * filmstrip frames, and applying the logo's 256 KB cap to those would be the
 * wrong rule in the wrong place. Branding gets the full validation one layer up.
 */
const IMAGE_DATA_URI = new RegExp(
  `^data:image/(?:${BRANDING_LIMITS.logoMimeTypes.join("|")});base64,`,
  "i",
);

export function safeImageDataUri(uri: string): string | null {
  if (typeof uri !== "string" || uri === "") return null;
  return IMAGE_DATA_URI.test(uri) ? uri : null;
}

/* -------------------------------------------------------------------------- */
/* Score bands                                                                 */
/* -------------------------------------------------------------------------- */

/** The band's class suffix — shared by `.ring--*`, `.chip--*` and `.metric--*`. */
function bandModifier(band: ScoreBand): string {
  return band;
}

/**
 * The WORD that goes with every band.
 *
 * This is the accessibility contract of the whole document: no reader is ever
 * asked to distinguish a score by colour alone, whether they are colour-blind,
 * reading a greyscale printout, or listening to it. The print palette separates
 * the three colours in luminance too, but that is reinforcement — this is the
 * actual signal.
 */
function bandLabel(band: ScoreBand): string {
  switch (band) {
    case "good":
      return "Good";
    case "average":
      return "Needs work";
    case "poor":
      return "Poor";
    case "none":
      return "No data";
  }
}

/**
 * The band for a 0–1 AUDIT score (a metric's or an opportunity's), as opposed to
 * a 0–100 category score.
 *
 * Lighthouse scores audits on 0–1 and categories on 0–1 which we normalise to
 * 0–100 (`CategoryScores`), so the two arrive here on different scales and
 * `scoreBand` only understands one of them. Multiplying by 100 lines the audit up
 * with the same 0.5/0.9 cut points Lighthouse itself uses, so a metric chip and a
 * category ring can never disagree about what "good" means.
 */
function auditBand(score: number | null): ScoreBand {
  return scoreBand(score === null || score === undefined ? null : score * 100);
}

/**
 * A 0–100 score as the document prints it. Deliberately not `formatScore` from
 * `@/lib/scores`: the contract declares {@link ABSENT_VALUE} as the em dash THIS
 * document uses for a missing value, and a renderer that reads a different
 * constant could drift from the file it is rendering.
 */
function formatScoreValue(score: number | null): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return ABSENT_VALUE;
  return String(Math.round(score));
}

/* -------------------------------------------------------------------------- */
/* Number and date formatting                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A percentage for an inline `style` attribute.
 *
 * Nothing untrusted reaches a style attribute — these numbers come from
 * {@link barGeometry} and from pass/fail counts — but a non-finite value would
 * still emit `NaN%`, which browsers drop, silently collapsing a bar to nothing.
 * Clamping to 0–100 here means a style attribute in this document is always a
 * valid length.
 */
function pct(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const clamped = value < 0 ? 0 : value > 100 ? 100 : value;
  return `${Math.round(clamped * 1e4) / 1e4}%`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Parse an ISO timestamp, or `null` when it will not parse.
 *
 * Every timestamp in a {@link ClientReport} is an ISO string produced by the app,
 * but a report file can be hand-edited or produced by an older version, so an
 * unparseable value is an ordinary input: the callers below fall back to printing
 * the raw string, escaped. Never a `Invalid Date`.
 */
function parseIso(iso: string): Date | null {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * A timestamp for the machine-facing lines (the footer, a run's fetch time):
 * `2026-09-06 14:22 UTC`.
 *
 * UTC, explicitly labelled, and formatted by hand rather than through
 * `toLocaleString`. The file is read on someone else's machine in someone else's
 * timezone, so a local-time rendering would silently mean something different to
 * the sender and the recipient; and a locale-dependent format would make this
 * module's output depend on the environment its tests run in.
 */
function formatTimestamp(iso: string): string {
  const date = parseIso(iso);
  if (!date) return iso;
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`
  );
}

/** The same instant for the human-facing branding block: `6 September 2026`. */
function formatDateLong(iso: string): string {
  const date = parseIso(iso);
  if (!date) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Zero-padded row ordinal, so the waterfall's leading column is a straight edge. */
function ordinal(index: number, total: number): string {
  const width = String(Math.max(total, 1)).length;
  return String(index + 1).padStart(width, "0");
}

/* -------------------------------------------------------------------------- */
/* Small markup helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Drop the empty strings a conditional section returns, then join with newlines. */
function joinBlocks(blocks: Array<string | null | undefined>): string {
  return blocks.filter((block): block is string => Boolean(block)).join("\n");
}

/** A band chip: the colour AND the word, always together. */
function chip(text: string, band: ScoreBand | "accent" | "neutral" = "neutral"): string {
  const modifier = band === "neutral" ? "" : ` chip--${band === "accent" ? "accent" : band}`;
  return `<span class="chip${modifier}">${escapeHtml(text)}</span>`;
}

/**
 * An abbreviated chip (`RB`, `3P`) that also carries its expansion for anyone not
 * reading the printed page — a screen reader announces the full phrase, and the
 * visually-hidden text costs nothing in ink.
 */
function abbrChip(short: string, expansion: string, band: ScoreBand | "accent"): string {
  return (
    `<span class="chip chip--${band}">${escapeHtml(short)}` +
    `<span class="visually-hidden"> ${escapeHtml(expansion)}</span></span>`
  );
}

/** A section heading with the hairline rule that runs to the page edge. */
function sectionHead(title: string, meta?: string): string {
  return joinBlocks([
    `<div class="section-head">`,
    `<h2>${escapeHtml(title)}</h2>`,
    `<span class="rule"></span>`,
    meta ? `<span class="section-meta">${escapeHtml(meta)}</span>` : null,
    `</div>`,
  ]);
}

/** The document's one "there is nothing here" treatment. */
function emptyState(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

/**
 * Wrap a wide table so it scrolls inside its own box rather than giving the whole
 * document a horizontal scrollbar. `tabindex="0"` is what makes a scroll region
 * reachable — without it a keyboard-only reader cannot scroll the waterfall at
 * all — and `@media print` unsets the overflow so nothing is clipped on paper.
 */
function scrollRegion(label: string, inner: string): string {
  return joinBlocks([
    `<div class="table-scroll" tabindex="0" role="group" aria-label="${escapeHtml(label)}">`,
    inner,
    `</div>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Score rings                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ring geometry, in SVG user units. ONE geometry for the whole document — the
 * summary's large gauges and the page cards' small ones are the same `viewBox`
 * rendered at different CSS widths, so a ring can never drift between contexts
 * the way two hand-tuned copies would.
 *
 * The radius leaves a half-stroke margin on each side so the arc's round cap is
 * never clipped by the viewBox, matching `ScoreRing`'s on-screen geometry.
 */
const RING_SIZE = 64;
const RING_STROKE = 6;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CENTER = RING_SIZE / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * One gauge: a faint full track, a band-coloured arc proportional to the score,
 * and the rounded number in the middle.
 *
 * A `null` score draws a DOTTED track and no arc, with {@link ABSENT_VALUE} in the
 * centre. That distinction is the point: an arc of length zero looks exactly like
 * a score of 0, and telling a client their accessibility score is zero when it was
 * never measured is the kind of error a report cannot come back from.
 *
 * The arc is rotated by an SVG `transform` attribute rather than a CSS transform
 * so it starts at twelve o'clock even in renderers that do not apply CSS
 * transforms to SVG geometry — printing is exactly where that would show up.
 */
function renderRing(score: number | null, caption: string, name: string): string {
  const band = scoreBand(score);
  const hasScore = score !== null && score !== undefined && Number.isFinite(score);
  const clamped = hasScore ? Math.min(100, Math.max(0, score)) : 0;
  const dashOffset = RING_CIRCUMFERENCE * (1 - clamped / 100);

  const label = hasScore
    ? `${name}: ${formatScoreValue(score)} out of 100 (${bandLabel(band)})`
    : `${name}: no score recorded`;

  const arc = hasScore
    ? `<circle class="ring-arc" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}" ` +
      `transform="rotate(-90 ${RING_CENTER} ${RING_CENTER})" ` +
      `stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(4)}" ` +
      `stroke-dashoffset="${dashOffset.toFixed(4)}"></circle>`
    : "";

  return joinBlocks([
    `<figure class="ring ring--${bandModifier(band)}">`,
    `<svg class="ring-gauge" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}" role="img" aria-label="${escapeHtml(label)}">`,
    `<circle class="ring-track" cx="${RING_CENTER}" cy="${RING_CENTER}" r="${RING_RADIUS}"></circle>`,
    arc,
    `<text class="ring-value" x="${RING_CENTER}" y="${RING_CENTER}">${escapeHtml(formatScoreValue(score))}</text>`,
    `</svg>`,
    `<figcaption class="ring-caption">${escapeHtml(caption)}</figcaption>`,
    `</figure>`,
  ]);
}

/** The categories a `CategoryScores` actually carries, in the app's own order. */
function presentCategories(scores: Partial<Record<LighthouseCategory, number | null>>): LighthouseCategory[] {
  return LIGHTHOUSE_CATEGORIES.filter((category) => category in scores);
}

/**
 * An "Overall" gauge followed by one per scored category. Used identically by the
 * batch summary and by each page card, which is what makes the two rows read as
 * the same instrument at two scales.
 */
function renderRingRow(
  overall: number | null,
  scores: Partial<Record<LighthouseCategory, number | null>>,
  overallName: string,
): string {
  const rings = presentCategories(scores).map((category) =>
    renderRing(scores[category] ?? null, CATEGORY_SHORT_LABELS[category], CATEGORY_LABELS[category]),
  );
  return joinBlocks([
    `<div class="rings">`,
    renderRing(overall, "Overall", overallName),
    ...rings,
    `</div>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Masthead: branding, identity, provenance                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether the optional branding block has anything to say.
 *
 * All four fields empty means the user never configured branding, and an empty
 * bordered box at the top of a client report looks like a bug rather than a
 * default. `showDate` counts, because "generated on 6 September 2026" is content.
 */
function hasBranding(branding: ReportBranding): boolean {
  return Boolean(
    branding.title || branding.subtitle || branding.logoDataUri || branding.showDate,
  );
}

function renderBranding(branding: ReportBranding, generatedAt: string): string {
  if (!hasBranding(branding)) return "";

  // Re-validated here, not trusted: a logo that is not a data: image is dropped
  // outright rather than emitted as a broken (or worse, live) URL.
  const logo = safeImageDataUri(branding.logoDataUri);
  // A logo with a title beside it is decorative — the title already names the
  // auditor, and repeating it as alt text makes a screen reader say it twice.
  const logoAlt = branding.title ? "" : "Auditor logo";

  return joinBlocks([
    `<div class="brand">`,
    logo
      ? `<img class="brand-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(logoAlt)}">`
      : null,
    branding.title || branding.subtitle
      ? joinBlocks([
          `<div class="brand-text">`,
          branding.title ? `<p class="brand-title">${escapeHtml(branding.title)}</p>` : null,
          branding.subtitle
            ? `<p class="brand-subtitle">${escapeHtml(branding.subtitle)}</p>`
            : null,
          `</div>`,
        ])
      : null,
    branding.showDate
      ? joinBlocks([
          `<div class="brand-date">`,
          `<p class="eyebrow">Prepared</p>`,
          `<p class="mono">${escapeHtml(formatDateLong(generatedAt))}</p>`,
          `</div>`,
        ])
      : null,
    `</div>`,
  ]);
}

/** `local` / `psi` as something a client can read. */
function sourceLabel(source: string): string {
  return source === "psi" ? "PageSpeed Insights" : "Local Lighthouse";
}

/**
 * The provenance line, as a definition list — "Throttling → Simulated" is
 * literally a term and its definition, and a `<dl>` prints as a clean key/value
 * strip where a sentence would wrap into mush.
 */
/**
 * The batch's lifecycle, in words a client understands rather than the queue's
 * own vocabulary.
 *
 * `completed_with_errors` is the one worth naming precisely: it means every page
 * was attempted and some failed, which is a materially different document from
 * one whose batch was stopped, and "Completed" alone would hide the failures the
 * per-page sections go on to show.
 */
function batchStatusLabel(status: ReportProvenance["status"], total: number): string {
  const pageCount = Number.isFinite(total) && total > 0 ? `${total} pages` : "";
  switch (status) {
    case "completed":
      return pageCount ? `Complete · ${pageCount}` : "Complete";
    case "completed_with_errors":
      return pageCount
        ? `Complete with errors · ${pageCount}`
        : "Complete with errors";
    case "cancelled":
      return pageCount ? `Cancelled · ${pageCount} planned` : "Cancelled";
    case "running":
      return pageCount ? `Still running · ${pageCount} planned` : "Still running";
    case "queued":
      return pageCount ? `Queued · ${pageCount} planned` : "Queued";
    default:
      return ABSENT_VALUE;
  }
}

function renderProvenance(provenance: ReportProvenance): string {
  const items: Array<[string, string]> = [
    ["Engine", sourceLabel(provenance.source)],
    ["Device", provenance.device || ABSENT_VALUE],
    ["Throttling", provenance.throttling || ABSENT_VALUE],
    ["Runs", `Median of ${Number.isFinite(provenance.runs) ? provenance.runs : ABSENT_VALUE}`],
  ];
  if (provenance.lighthouseVersion) {
    items.push(["Lighthouse", provenance.lighthouseVersion]);
  }
  items.push(["Batch created", formatTimestamp(provenance.createdAt)]);
  // The lifecycle sits in the masthead, beside the settings — not buried in the
  // notes — because a reader who only skims the top of the document is exactly
  // the reader who would otherwise take a cancelled batch for a finished audit.
  // `notes` carries the fuller sentence; this is the label that travels with the
  // scores. (ROADMAP Phase H security review.)
  items.push(["Status", batchStatusLabel(provenance.status, provenance.total)]);

  return joinBlocks([
    `<dl class="provenance">`,
    ...items.map(
      ([term, value]) =>
        `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    ),
    `</dl>`,
  ]);
}

function renderMasthead(report: ClientReport): string {
  return joinBlocks([
    `<header class="masthead">`,
    renderBranding(report.branding, report.generatedAt),
    `<div class="report-id">`,
    `<p class="eyebrow">LightAudit Score — client report</p>`,
    `<h1>Site Audit<span class="batch-id" translate="no">${escapeHtml(report.shortId)}</span></h1>`,
    renderProvenance(report.provenance),
    `</div>`,
    `</header>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Batch summary                                                               */
/* -------------------------------------------------------------------------- */

/** One stat tile: a big mono number, a mono label, and an optional footnote. */
function tile(value: string, label: string, note?: string): string {
  return joinBlocks([
    `<div class="tile">`,
    `<span class="tile-value">${escapeHtml(value)}</span>`,
    `<span class="tile-label">${escapeHtml(label)}</span>`,
    note ? `<span class="tile-note">${escapeHtml(note)}</span>` : null,
    `</div>`,
  ]);
}

/**
 * Per-category pass/fail against the user's own thresholds.
 *
 * Categories the batch never scored (`total === 0`) are skipped rather than shown
 * as `0 / 0`, which reads as a failure. The proportion bar is decoration on top of
 * the numbers and the verdict word, never the only way to read the row.
 */
function renderPassFail(summary: ReportSummary, thresholds: Record<LighthouseCategory, number>): string {
  const rows = LIGHTHOUSE_CATEGORIES.filter(
    (category) => (summary.passFail[category]?.total ?? 0) > 0,
  );
  if (rows.length === 0) {
    return emptyState("No category was scored across this batch, so there is nothing to grade.");
  }

  const body = rows.map((category) => {
    const tally = summary.passFail[category];
    const threshold = thresholds?.[category];
    const passPct = tally.total > 0 ? (tally.pass / tally.total) * 100 : 0;
    const verdict = tally.fail === 0 ? "All pass" : `${tally.fail} below`;
    const barLabel = `${tally.pass} of ${tally.total} pages pass`;
    return joinBlocks([
      `<tr>`,
      `<td>${escapeHtml(CATEGORY_LABELS[category])}</td>`,
      `<td class="col-num">${escapeHtml(
        typeof threshold === "number" ? String(threshold) : ABSENT_VALUE,
      )}</td>`,
      `<td class="col-num">${escapeHtml(String(tally.pass))}</td>`,
      `<td class="col-num">${escapeHtml(String(tally.fail))}</td>`,
      `<td>`,
      `<span class="passbar" role="img" aria-label="${escapeHtml(barLabel)}">`,
      `<span class="passbar-pass" style="width:${pct(passPct)}"></span>`,
      `<span class="passbar-fail" style="width:${pct(100 - passPct)}"></span>`,
      `</span>`,
      `</td>`,
      `<td>${chip(verdict, tally.fail === 0 ? "good" : "poor")}</td>`,
      `</tr>`,
    ]);
  });

  return scrollRegion(
    "Pass and fail counts per category",
    joinBlocks([
      `<table class="data">`,
      `<caption class="visually-hidden">Pages passing each category threshold</caption>`,
      `<thead><tr>`,
      `<th scope="col">Category</th>`,
      `<th scope="col" class="col-num">Threshold</th>`,
      `<th scope="col" class="col-num">Pass</th>`,
      `<th scope="col" class="col-num">Fail</th>`,
      `<th scope="col">Share</th>`,
      `<th scope="col">Verdict</th>`,
      `</tr></thead>`,
      `<tbody>`,
      ...body,
      `</tbody>`,
      `</table>`,
    ]),
  );
}

/**
 * The best and worst page, each linked to its own section.
 *
 * The URL is page-derived, so it is the link's TEXT; the `href` is the `#run-…`
 * anchor this module built and validated. A run whose id fails validation still
 * appears — as plain text, without a link.
 */
/**
 * @param printedIds Run ids that actually have a section in this document.
 *   Above `REPORT_CAPS.pages` the best/worst page is chosen over the WHOLE batch
 *   and may not be one of them, and an `<a href="#run-…">` to a section that was
 *   never rendered is a link that goes nowhere. `notes` explains the situation at
 *   the end of the document; the link itself should simply not be a link.
 */
function renderHighlights(
  summary: ReportSummary,
  printedIds: ReadonlySet<string>,
): string {
  const cards: string[] = [];
  const entries: Array<["best" | "worst", string, ReportSummary["best"]]> = [
    ["best", "Strongest page", summary.best],
    ["worst", "Weakest page", summary.worst],
  ];

  for (const [kind, label, highlight] of entries) {
    if (!highlight) continue;
    const anchor = printedIds.has(highlight.runId)
      ? safeAnchorId(highlight.runId)
      : null;
    const url = escapeHtml(highlight.url);
    cards.push(
      joinBlocks([
        `<div class="highlight highlight--${kind}">`,
        `<p class="eyebrow">${escapeHtml(label)}</p>`,
        `<p class="highlight-score">${escapeHtml(formatScoreValue(highlight.overall))}<span class="visually-hidden"> out of 100</span></p>`,
        anchor
          ? `<p class="url" translate="no"><a href="#${escapeHtml(anchor)}">${url}</a></p>`
          : `<p class="url" translate="no">${url}</p>`,
        `</div>`,
      ]),
    );
  }

  if (cards.length === 0) return "";
  return joinBlocks([`<div class="highlights">`, ...cards, `</div>`]);
}

function renderSummary(report: ClientReport): string {
  const { summary } = report;
  const measured = summary.pageCount - summary.errorCount;
  // Rows the pass/fail table below is computed over — the whole batch, failures
  // included. Every category's tally covers every row, so the max is that count
  // and stays right even if a category is missing from the record.
  const batchRows = Math.max(
    0,
    ...LIGHTHOUSE_CATEGORIES.map(
      (category) => summary.passFail[category]?.total ?? 0,
    ),
  );

  if (report.pages.length === 0) {
    return joinBlocks([
      `<section class="section">`,
      sectionHead("Batch Summary"),
      emptyState(
        "This batch contains no pages, so there is nothing to summarise. " +
          "Re-run the audit with at least one URL to produce a report with results.",
      ),
      `</section>`,
    ]);
  }

  return joinBlocks([
    `<section class="section">`,
    sectionHead("Batch summary", `${summary.pageCount} pages`),
    renderRingRow(summary.overall, summary.averageScores, "Overall average across the batch"),
    `<div class="tiles">`,
    // The tile counts PRINTED pages while the pass/fail table below counts the
    // whole batch, so above `REPORT_CAPS.pages` two denominators sit in one
    // section. The reconciliation exists, but only as a note at the very end of a
    // 60-page document — too far away to do the reader any good. Say it here.
    // (Phase H review.)
    //
    // `batchRows` comes from the pass/fail tallies, NOT from `clearing.total`:
    // clearing counts only pages that measured something, so a batch with two
    // failures would reconcile against the wrong number and print a smaller
    // denominator than the table beneath it. pass + fail is every row.
    tile(
      String(summary.pageCount),
      "Pages",
      batchRows > summary.pageCount
        ? `${summary.pageCount} shown of ${batchRows} · ${measured} measured, ${summary.errorCount} failed`
        : `${measured} measured, ${summary.errorCount} failed`,
    ),
    tile(
      `${summary.clearing.clearing}/${summary.clearing.total}`,
      "Clearing",
      "Pages meeting every threshold they were scored against",
    ),
    tile(
      formatScoreValue(summary.overall),
      "Mean overall",
      `Band: ${bandLabel(scoreBand(summary.overall))}`,
    ),
    `</div>`,
    renderPassFail(summary, report.thresholds),
    renderHighlights(summary, new Set(report.pages.map((page) => page.runId))),
    `</section>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Core Web Vitals                                                             */
/* -------------------------------------------------------------------------- */

function renderMetrics(metrics: ReportMetric[]): string {
  if (!metrics || metrics.length === 0) {
    return joinBlocks([
      `<div>`,
      `<h4>Core Web Vitals</h4>`,
      emptyState("This run recorded no metric values."),
      `</div>`,
    ]);
  }

  const cells = metrics.map((metric) => {
    const band = auditBand(metric.score);
    return joinBlocks([
      `<div class="metric metric--${bandModifier(band)}">`,
      `<div class="metric-top">`,
      `<span class="metric-abbr">${escapeHtml(metric.abbr)}</span>`,
      `<span class="metric-value">${escapeHtml(metric.displayValue || ABSENT_VALUE)}</span>`,
      `</div>`,
      `<span class="metric-label">${escapeHtml(metric.label)}</span>`,
      // The band word, not just the colour — this is the row's real verdict.
      `<span class="metric-band">${escapeHtml(bandLabel(band))}</span>`,
      `</div>`,
    ]);
  });

  return joinBlocks([`<div>`, `<h4>Core Web Vitals</h4>`, `<div class="cwv">`, ...cells, `</div>`, `</div>`]);
}

/* -------------------------------------------------------------------------- */
/* Opportunities                                                               */
/* -------------------------------------------------------------------------- */

function renderOpportunities(opportunities: ReportOpportunity[]): string {
  if (!opportunities || opportunities.length === 0) {
    return joinBlocks([
      `<div>`,
      `<h4>Top Opportunities</h4>`,
      emptyState("Lighthouse found no scored opportunities for this page."),
      `</div>`,
    ]);
  }

  const rows = opportunities.map((opportunity) => {
    const band = auditBand(opportunity.score);
    // `displayValue` is Lighthouse's own summary and is page-derived; the
    // formatted `savingsMs` is ours. Prefer theirs, fall back to ours.
    const saving = opportunity.displayValue || formatDuration(opportunity.savingsMs);
    return joinBlocks([
      `<tr>`,
      `<td>`,
      `<p class="opp-title">${escapeHtml(opportunity.title)}</p>`,
      opportunity.description
        ? `<p class="opp-desc">${escapeHtml(opportunity.description)}</p>`
        : "",
      `</td>`,
      `<td>${chip(bandLabel(band), band)}</td>`,
      `<td class="col-num">${escapeHtml(saving || ABSENT_VALUE)}</td>`,
      `</tr>`,
    ]);
  });

  return joinBlocks([
    `<div>`,
    `<h4>Top opportunities</h4>`,
    scrollRegion(
      "Top opportunities",
      joinBlocks([
        `<table class="data">`,
        `<caption class="visually-hidden">Highest-impact opportunities for this page</caption>`,
        `<thead><tr>`,
        `<th scope="col">Opportunity</th>`,
        `<th scope="col">Band</th>`,
        `<th scope="col" class="col-num">Est. saving</th>`,
        `</tr></thead>`,
        `<tbody>`,
        ...rows,
        `</tbody>`,
        `</table>`,
      ]),
    ),
    `</div>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Filmstrip                                                                   */
/* -------------------------------------------------------------------------- */

function renderFilmstrip(filmstrip: ReportFilmstrip): string {
  if (!filmstrip.frames || filmstrip.frames.length === 0) {
    return joinBlocks([
      `<div>`,
      `<h4>Loading Filmstrip</h4>`,
      emptyState("This run's report carried no screenshot frames."),
      `</div>`,
    ]);
  }

  const frames = filmstrip.frames.map((frame, index) => {
    const src = safeImageDataUri(frame.data);
    const timing = formatDuration(frame.timingMs);
    const alt = `Screenshot at ${timing}${frame.isLcp ? ", largest contentful paint" : ""}`;
    return joinBlocks([
      `<li class="frame${frame.isLcp ? " frame--lcp" : ""}">`,
      src
        ? // Eager and synchronous, against the usual below-the-fold advice: a
          // lazily-loaded frame can still be undecoded when the browser paints
          // a print job, and a filmstrip with blank cells in the PDF is worse
          // than one that costs a few extra milliseconds. There is no network
          // cost to weigh against it — every frame is already in the file.
          `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="eager" decoding="sync">`
        : // A frame whose data is not a data: image is dropped, and the gap says
          // so — a silently missing thumbnail would read as "the page was blank".
          `<span class="frame-missing">Frame ${escapeHtml(String(index + 1))} unavailable</span>`,
      `<span class="frame-caption">`,
      `<span>${escapeHtml(timing)}</span>`,
      frame.isLcp ? `<span class="frame-flag">LCP</span>` : "",
      `</span>`,
      `</li>`,
    ]);
  });

  const meta = joinBlocks([
    `<p class="page-fact">`,
    `<span>${escapeHtml(`${filmstrip.frames.length} frames`)}</span>`,
    `<span>${escapeHtml(`Strip extent ${formatDuration(filmstrip.timelineMs)}`)}</span>`,
    `<span>${escapeHtml(`LCP ${formatDuration(filmstrip.lcpMs)}`)}</span>`,
    `</p>`,
  ]);

  return joinBlocks([
    `<div>`,
    `<h4>Loading filmstrip</h4>`,
    meta,
    `<div class="filmstrip-box">`,
    `<ol class="filmstrip">`,
    ...frames,
    `</ol>`,
    `</div>`,
    `</div>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Waterfall                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The request column's text.
 *
 * Not `requestLabel` from `@/lib/reports/waterfall-view`, even though the rule is
 * the same one: that helper's signature needs `WaterfallRequest.url`, and the
 * report contract deliberately dropped `url` from {@link ReportRequest} (six
 * fields and a bar, per the contract's note). Only the shaping differs — the
 * reasoning is the on-screen one, so it is not restated here.
 *
 * `clampText` IS reused, and matters more in a file than on screen: a `data:` URL
 * is a legitimate waterfall row and can be megabytes, and CSS truncation hides an
 * over-long string without shortening it — every byte would still ship in the
 * exported document, per row.
 */
function renderRequestCell(request: ReportRequest, pageHost: string): string {
  const path = clampText(request.path || "", MAX_LABEL) || ABSENT_VALUE;
  const crossHost = Boolean(request.host) && Boolean(pageHost) && request.host !== pageHost;
  const host = crossHost
    ? `<span class="wf-host">${escapeHtml(clampText(request.host, MAX_LABEL))}</span>`
    : "";

  const marks: string[] = [];
  if (request.renderBlocking) marks.push(abbrChip("RB", "render-blocking", "poor"));
  if (request.thirdParty) marks.push(abbrChip("3P", "third party", "average"));

  return joinBlocks([
    `<td>`,
    `<span class="url" translate="no">${host}${escapeHtml(path)}</span>`,
    marks.length > 0 ? `<span class="wf-marks">${marks.join("")}</span>` : "",
    `</td>`,
  ]);
}

/** The bar's tone. Same priority as the on-screen waterfall: finding, then provenance. */
function barTone(request: ReportRequest): "blocking" | "third-party" | "first-party" {
  if (request.renderBlocking) return "blocking";
  if (request.thirdParty) return "third-party";
  return "first-party";
}

function renderWaterfall(waterfall: ReportWaterfall, page: ReportPage): string {
  const requests = waterfall.requests ?? [];
  if (requests.length === 0) {
    return joinBlocks([
      `<div>`,
      `<h4>Request Waterfall</h4>`,
      emptyState("This run's report recorded no network requests."),
      `</div>`,
    ]);
  }

  // Which host counts as "the page's own" — the audit's landing URL when it has
  // one, else the requested URL. Display only: `thirdParty` is Lighthouse's
  // entity classification and is what the row actually marks.
  const pageHost = hostOf(page.finalUrl || page.url);

  const rows = requests.map((request, index) => {
    // Reused verbatim from the on-screen waterfall rather than duplicated: it
    // returns plain CSS-ready percentages, not React-shaped values, and sharing
    // it is what guarantees MIN_BAR_PCT means the same thing in the app and in
    // the file — a 2 ms request stays a visible mark in both.
    const geometry = barGeometry(request, waterfall.timelineMs);
    const track = geometry
      ? `<span class="wf-track"><span class="wf-bar wf-bar--${barTone(request)}" ` +
        `style="left:${pct(geometry.offsetPct)};width:${pct(geometry.widthPct)}"></span></span>`
      : // No start time, or no usable timeline: say so rather than drawing a bar
        // at an arbitrary position, which would be an invented measurement.
        `<span class="wf-no-bar">${escapeHtml(ABSENT_VALUE)}</span>`;

    return joinBlocks([
      `<tr>`,
      `<td class="col-num">${escapeHtml(ordinal(index, requests.length))}</td>`,
      renderRequestCell(request, pageHost),
      `<td>${escapeHtml(request.resourceType || ABSENT_VALUE)}</td>`,
      `<td class="col-num">${escapeHtml(formatBytes(request.transferSize))}</td>`,
      `<td class="col-num">${escapeHtml(formatDuration(request.startTime))}</td>`,
      `<td class="col-track">${track}</td>`,
      `</tr>`,
    ]);
  });

  const shown =
    waterfall.totalRequests > requests.length
      ? `${requests.length} of ${waterfall.totalRequests} requests`
      : `${waterfall.totalRequests} requests`;

  return joinBlocks([
    `<div>`,
    `<h4>Request waterfall</h4>`,
    `<p class="page-fact">`,
    `<span>${escapeHtml(shown)}</span>`,
    `<span>${escapeHtml(`${formatBytes(waterfall.totalTransferSize)} transferred`)}</span>`,
    `<span>${escapeHtml(`${waterfall.thirdPartyCount} third-party`)}</span>`,
    `<span>${escapeHtml(`Timeline ${formatDuration(waterfall.timelineMs)}`)}</span>`,
    `</p>`,
    `<p class="wf-legend">`,
    abbrChip("RB", "render-blocking", "poor"),
    abbrChip("3P", "third party", "average"),
    `</p>`,
    scrollRegion(
      "Request waterfall",
      joinBlocks([
        `<table class="data wf">`,
        `<caption class="visually-hidden">Network requests in Lighthouse's own order</caption>`,
        `<thead><tr>`,
        `<th scope="col" class="col-num">#</th>`,
        `<th scope="col">Request</th>`,
        `<th scope="col">Type</th>`,
        `<th scope="col" class="col-num">Size</th>`,
        `<th scope="col" class="col-num">Start</th>`,
        `<th scope="col" class="col-track">Timeline</th>`,
        `</tr></thead>`,
        `<tbody>`,
        ...rows,
        `</tbody>`,
        `</table>`,
      ]),
    ),
    `</div>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Trace omission                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Why a page carries no waterfall or filmstrip, in the reader's words.
 *
 * Three reasons, three different sentences — as the contract's own note insists.
 * "The run failed", "the engine never captured a trace" and "we could not read the
 * file we stored" invite completely different follow-up questions from a client,
 * and collapsing them into one shrug ("trace unavailable") would be the report
 * quietly refusing to say which.
 */
function omissionSentence(reason: TraceOmission): string {
  switch (reason) {
    case "no-report":
      return (
        "No Lighthouse report was stored for this run, so there is no request " +
        "waterfall or filmstrip to show — the run either failed before a report " +
        "was written, was never saved, or its stored report has since been " +
        "removed."
      );
    case "unavailable":
      return (
        "This run's stored report contains neither network-request data nor " +
        "screenshot frames. PageSpeed Insights runs, and runs recorded before " +
        "trace capture was added, do not carry them."
      );
    case "unreadable":
      return (
        "This run's stored report was found but could not be read or parsed, so " +
        "its waterfall and filmstrip have been left out rather than guessed at."
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Page cards                                                                  */
/* -------------------------------------------------------------------------- */

/** Which categories missed the user's bar — the "why" behind `clears: false`. */
function failingCategories(
  page: ReportPage,
  thresholds: Record<LighthouseCategory, number>,
): LighthouseCategory[] {
  return presentCategories(page.scores).filter((category) => {
    const score = page.scores[category];
    const threshold = thresholds?.[category];
    if (score === null || score === undefined || typeof threshold !== "number") return false;
    return score < threshold;
  });
}

/**
 * One audited page.
 *
 * A `<details open>` rather than a plain section: a 60-page report is easier to
 * work through when a reader can fold away the pages they have dealt with, and
 * `<details>` is the only collapsible that needs no JavaScript. It ships OPEN so
 * the screen and the printed page show the same thing by default, and the print
 * sheet forces it open again in case a reader collapsed something first.
 */
function renderPage(page: ReportPage, index: number, total: number, report: ClientReport): string {
  const anchor = safeAnchorId(page.runId);
  const failing = failingCategories(page, report.thresholds);
  const hasScores = presentCategories(page.scores).length > 0;

  const flags: string[] = [
    chip(page.device === "desktop" ? "Desktop" : "Mobile"),
    chip(sourceLabel(page.source)),
  ];
  if (page.status === "error") {
    flags.push(chip("Failed", "poor"));
  } else if (page.clears) {
    flags.push(chip("Clears thresholds", "good"));
  } else if (failing.length > 0) {
    flags.push(chip(`Below: ${failing.map((c) => CATEGORY_SHORT_LABELS[c]).join(", ")}`, "poor"));
  }
  flags.push(chip(`Overall ${formatScoreValue(page.overall)}`, scoreBand(page.overall)));

  const facts: string[] = [];
  if (page.finalUrl && page.finalUrl !== page.url) {
    facts.push(`<span>Landed on <span class="url" translate="no">${escapeHtml(page.finalUrl)}</span></span>`);
  }
  if (page.runs !== null && page.runs !== undefined) {
    facts.push(`<span>${escapeHtml(`Median of ${page.runs}`)}</span>`);
  }
  if (page.fetchTime) {
    facts.push(`<span>${escapeHtml(`Fetched ${formatTimestamp(page.fetchTime)}`)}</span>`);
  }

  const body: string[] = [];

  if (page.status === "error") {
    body.push(
      joinBlocks([
        `<div class="error-box">`,
        `<p class="eyebrow">Run failed</p>`,
        `<p class="error-message">${escapeHtml(page.errorMessage || "No error message was recorded.")}</p>`,
        `</div>`,
      ]),
    );
  }

  if (hasScores) {
    body.push(renderRingRow(page.overall, page.scores, `Overall score for this page`));
  } else if (page.status !== "error") {
    body.push(emptyState("This run produced no category scores."));
  }

  if (page.status !== "error") {
    body.push(renderMetrics(page.metrics ?? []));
    body.push(renderOpportunities(page.opportunities ?? []));
  }

  if (page.filmstrip) body.push(renderFilmstrip(page.filmstrip));
  if (page.waterfall) body.push(renderWaterfall(page.waterfall, page));
  if (!page.filmstrip && !page.waterfall) {
    body.push(
      `<p class="omission">${escapeHtml(
        page.traceOmission
          ? omissionSentence(page.traceOmission)
          : // The contract says traceOmission is set exactly when both are null.
            // If a file says otherwise, say what we can see rather than nothing.
            "No request waterfall or filmstrip was included for this page.",
      )}</p>`,
    );
  }

  return joinBlocks([
    `<details class="page-card"${anchor ? ` id="${escapeHtml(anchor)}"` : ""} open>`,
    `<summary class="page-head">`,
    `<h3 class="page-title">`,
    `<span class="page-index">${escapeHtml(ordinal(index, total))}</span>`,
    // Page-derived URL: text only, no href, ever.
    `<span class="url" translate="no">${escapeHtml(page.url)}</span>`,
    `</h3>`,
    `<span class="page-flags">${flags.join("")}</span>`,
    `</summary>`,
    `<div class="page-body">`,
    facts.length > 0 ? `<p class="page-fact">${facts.join("")}</p>` : "",
    ...body,
    `</div>`,
    `</details>`,
  ]);
}

function renderPages(report: ClientReport): string {
  if (report.pages.length === 0) {
    return joinBlocks([
      `<section class="section">`,
      sectionHead("Pages"),
      emptyState(
        "No pages were included in this export. Nothing has been hidden — the batch itself has no runs to report.",
      ),
      `</section>`,
    ]);
  }

  return joinBlocks([
    `<section class="section">`,
    sectionHead("Pages", `${report.pages.length} audited`),
    `<div class="pages">`,
    ...report.pages.map((page, index) => renderPage(page, index, report.pages.length, report)),
    `</div>`,
    `</section>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Notes and footer                                                            */
/* -------------------------------------------------------------------------- */

function renderNotes(notes: string[]): string {
  if (!notes || notes.length === 0) return "";
  return joinBlocks([
    `<section class="section">`,
    sectionHead("Notes"),
    `<ul class="notes">`,
    ...notes.map((note) => `<li>${escapeHtml(note)}</li>`),
    `</ul>`,
    `</section>`,
  ]);
}

function renderFooter(report: ClientReport): string {
  return joinBlocks([
    `<footer class="footer">`,
    `<span>Generated by <strong>LightAudit Score</strong> on <span class="mono">${escapeHtml(
      formatTimestamp(report.generatedAt),
    )}</span></span>`,
    `<span class="mono">${escapeHtml(`Batch ${report.shortId} · report format v${CLIENT_REPORT_VERSION}`)}</span>`,
    `<span>This file is self-contained and makes no network requests.</span>`,
    `</footer>`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Document                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The document's `<title>` — what a browser tab and a saved-file dialog show.
 * Branded when the user has set a title, otherwise identified by batch.
 */
function documentTitle(report: ClientReport): string {
  const suffix = `Lighthouse report · ${report.shortId}`;
  return report.branding.title ? `${report.branding.title} — ${suffix}` : suffix;
}

/** Render a {@link ClientReport} as ONE self-contained HTML document. */
export function renderClientReport(report: ClientReport): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(REPORT_META_CSP)}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0c0f11">
<meta name="generator" content="LightAudit Score">
<meta name="referrer" content="no-referrer">
<!-- A client audit is not something anyone should find in a search index if the
     file ends up on a web server by accident. -->
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(documentTitle(report))}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="report">
${joinBlocks([
  renderMasthead(report),
  renderSummary(report),
  renderPages(report),
  renderNotes(report.notes ?? []),
  renderFooter(report),
])}
</div>
</body>
</html>
`;
}
