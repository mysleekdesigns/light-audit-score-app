/**
 * CI reporters (ROADMAP Phase F) — one finished {@link CiReport}, four renderings.
 *
 * Pure by construction: no `node:fs`, no DB, no React, no `lighthouse`. Every
 * reporter takes the report and returns a **string**; the CLI alone decides
 * stdout versus a path. That is what makes any of this testable, and it is why
 * the interesting properties below (escaping, clamping, determinism) can be
 * asserted directly rather than inferred from a written file.
 *
 * The four formats are not four styles of the same thing — they answer to
 * different readers, and that split drives every trade-off in this file:
 *
 *  - `json` — what a **pipeline parses**. The report minus the heavy per-page
 *    `metrics`. Full fidelity: nothing is clamped or stripped, because a program
 *    reading this wants the value that was measured, not a legible version of it.
 *  - `jsonExpanded` — the same document plus per-page `metrics`. *Nothing else
 *    changes shape*, so one parser reads both (`CiPage.metrics` is already
 *    optional in the contract). Choosing the expanded reporter must never mean
 *    writing a second consumer.
 *  - `csv` — what a **human opens in a spreadsheet**, days later, from a build
 *    archive. House conventions from `@/lib/export/exporters`: header row, CRLF
 *    lines, and every cell through `csvCell` — which also defuses formula
 *    injection, the attack this phase finally makes live (see that docblock).
 *  - `html` — what a **human opens from a build page**, offline. Self-contained:
 *    one inline stylesheet, no script, no image, no font, no request of any kind.
 *
 * ## Untrusted input
 *
 * `CiPage.finalUrl` is chosen by whatever the audited site redirected to and
 * `CiPage.errorMessage` can carry page-derived text. The HTML reporter builds
 * markup by hand with no framework escaping behind it, so **every interpolated
 * value goes through {@link escapeHtml}** — no exceptions, including values we
 * generate ourselves, because a uniform rule cannot be reasoned wrong later.
 * The document also emits **no `href` at all**: ROADMAP Phase C's L1 finding (a
 * hostile audited site forging an alert line) and Phase D's deliberate decision
 * to ship the waterfall with no links are the standing precedents here, and a CI
 * artifact has even less claim to navigable attacker-chosen URLs than a modal
 * does. URLs are text.
 *
 * ## Fidelity versus legibility
 *
 * A URL or an error message is unbounded, so the two human-facing formats clamp
 * what they render and the HTML one additionally strips the control/bidi class
 * (see {@link displaySafe}). The JSON reporters do neither. That split is the
 * whole policy: **JSON is the format of record; CSV and HTML are bounded views
 * of it.** Anyone who needs the untruncated value has a reporter that gives it.
 */

import type {
  BudgetViolation,
  CiBudgets,
  CiPage,
  CiReport,
  CiReporter,
} from "@/lib/ci/types";
import {
  type CategoryScores,
  type CoreWebVitals,
  type LighthouseCategory,
  LIGHTHOUSE_CATEGORIES,
  METRIC_IDS,
} from "@/lib/lighthouse/types";
import { clampText } from "@/lib/reports/waterfall-view";
import {
  AVERAGE_THRESHOLD,
  CATEGORY_LABELS,
  CATEGORY_SHORT_LABELS,
  GOOD_THRESHOLD,
  scoreBand,
  type ScoreBand,
} from "@/lib/scores";
import { csvCell } from "@/lib/export/exporters";

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Render bounds for the two human-facing formats.
 *
 * These exist so one hostile page cannot turn a build artifact into a 50 MB
 * file: a redirect target and an error message are both attacker-influenced and
 * both unbounded. With these applied, an artifact is linear in the page count at
 * roughly a kilobyte a page, whatever the audited sites do.
 */
export const MAX_URL_CHARS = 300;
/** @see MAX_URL_CHARS */
export const MAX_ERROR_CHARS = 400;
/** @see MAX_URL_CHARS */
export const MAX_VIOLATION_CHARS = 240;

/* -------------------------------------------------------------------------- */
/* Text safety                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * HTML-escape one interpolated value: `&` first (so the replacements below are
 * not themselves re-escaped), then the three markup characters and both quote
 * styles.
 *
 * Both quotes matter even though this file quotes its attributes with `"`:
 * escaping only what the current markup happens to need is how an attribute
 * breakout survives the next edit to that markup.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strip the characters that let an audited site FORGE a line of this report
 * rather than merely occupy one: C0/C1 controls, and the invisible/bidi set
 * whose RTL override can make `…/gnp.exe` read as `…/exe.png`.
 *
 * Escaping already stops these strings from becoming markup; this stops them
 * from lying about their own content, which escaping does not address. Same
 * threat and the same character class as `displaySafe` in
 * `@/lib/reports/extract`, deliberately re-stated rather than imported: that one
 * is a private helper of the report reader, and coupling a CI reporter to the
 * trace-extraction module to borrow six lines would be the worse trade.
 *
 * Applied to the HTML reporter only. CSV keeps every original character rather
 * than substituting any (the shape of the argument `csvCell` makes for defusing
 * formula injection with a prefix — note its own docblock is explicit that the
 * prefix is not lossless), and JSON is the format of record.
 */
function displaySafe(value: string): string {
  // Written as explicit escapes so the class survives a copy-paste or a
  // formatter — these characters written literally are invisible in a diff.
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/g,
    "",
  );
}

/** The full HTML text pipeline for one untrusted value: strip, clamp, escape. */
function htmlText(value: string, max: number): string {
  return escapeHtml(clampText(displaySafe(value), max));
}

/* -------------------------------------------------------------------------- */
/* Shared projections                                                          */
/* -------------------------------------------------------------------------- */

/** An em dash stands in for every absent value, in all three visual formats. */
const ABSENT = "—";

/**
 * Category scores in canonical `LIGHTHOUSE_CATEGORIES` order, carrying only the
 * categories actually present.
 *
 * Both halves are load-bearing. The canonical order makes output byte-stable
 * even when two equivalent reports were built with different key insertion
 * orders — CI diffs these artifacts, so "equivalent" has to mean "identical".
 * Keeping absent keys absent preserves the contract's own distinction: a
 * category with no entry was not run, which is not the same claim as a category
 * that ran and scored nothing.
 */
function orderedScores(scores: CategoryScores): CategoryScores {
  const ordered: CategoryScores = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    // `hasOwnProperty`, not `in`: `in` walks the prototype chain, which is how
    // ROADMAP Phase C's L3 finding got `describeCounts` reporting inherited
    // keys. A report parsed from JSON is exactly the object that makes that
    // reachable.
    if (Object.prototype.hasOwnProperty.call(scores, category)) {
      ordered[category] = scores[category] ?? null;
    }
  }
  return ordered;
}

/** Budgets in canonical category order — same reasoning as {@link orderedScores}. */
function orderedBudgets(budgets: CiBudgets): CiBudgets {
  const ordered: CiBudgets = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const budget = budgets[category];
    if (budget !== undefined) ordered[category] = budget;
  }
  return ordered;
}

/** Core Web Vitals in `METRIC_IDS` order — same reasoning as {@link orderedScores}. */
function orderedMetrics(metrics: CoreWebVitals): CoreWebVitals {
  const ordered = {} as CoreWebVitals;
  for (const id of METRIC_IDS) {
    ordered[id] = metrics[id] ?? null;
  }
  return ordered;
}

/**
 * One violation as a single line of prose, used by the CSV cell and the HTML
 * list so the two never drift.
 *
 * Each reason gets its own phrasing because they are genuinely different
 * failures: a score under the bar is a regression, an unscored category and an
 * errored run are both "we do not know", and a build that cannot tell those
 * apart sends someone to read the wrong logs.
 */
export function describeViolation(violation: BudgetViolation): string {
  const { category, score, budget, reason } = violation;
  const label = CATEGORY_LABELS[category] ?? category;
  switch (reason) {
    case "below":
      return `${label} ${score ?? ABSENT} < ${budget}`;
    case "unscored":
      return `${label} not scored (budget ${budget})`;
    case "error":
      return `${label} not measured — run failed (budget ${budget})`;
  }
}

/** Round a score for display; `null`/`NaN` render as {@link ABSENT}. */
function displayScore(score: number | null | undefined): string {
  if (score === null || score === undefined || Number.isNaN(score)) return ABSENT;
  return String(Math.round(score));
}

/* -------------------------------------------------------------------------- */
/* JSON reporters                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Project one page for a JSON reporter, with `metrics` included only for the
 * expanded one.
 *
 * The key order is written out by hand rather than spread from the input, which
 * is what makes `json` and `jsonExpanded` byte-comparable up to the one field
 * that differs between them, and what keeps a re-render byte-identical. The
 * `metrics` key is **omitted entirely** in the compact form rather than set to
 * `null`: `CiPage.metrics` is optional, so an absent key is the shape the
 * contract already describes, and a consumer written against `jsonExpanded`
 * reads a compact document without a second code path.
 */
function jsonPage(page: CiPage, includeMetrics: boolean): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    runId: page.runId,
    url: page.url,
    finalUrl: page.finalUrl,
    formFactor: page.formFactor,
    status: page.status,
    errorMessage: page.errorMessage,
    scores: orderedScores(page.scores),
  };
  if (includeMetrics) {
    projected.metrics = page.metrics ? orderedMetrics(page.metrics) : null;
  }
  projected.violations = page.violations;
  return projected;
}

/**
 * Serialize the report as JSON, two-space indented to match `rowsToJson`.
 *
 * No trailing newline: the CLI owns that, exactly as it owns stdout-versus-path.
 */
function renderJson(report: CiReport, includeMetrics: boolean): string {
  return JSON.stringify(
    {
      ok: report.ok,
      batchId: report.batchId,
      budgets: orderedBudgets(report.budgets),
      totals: report.totals,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      pages: report.pages.map((page) => jsonPage(page, includeMetrics)),
      violations: report.violations,
    },
    null,
    2,
  );
}

/* -------------------------------------------------------------------------- */
/* CSV reporter                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ordered CSV columns: one row per page.
 *
 * Category scores sit in `LIGHTHOUSE_CATEGORIES` order between the identifying
 * fields and the verdict, so a sixth Lighthouse category appends a column
 * instead of shifting everyone's existing ones — the same rule the History
 * export follows, and the same scar `agentic-browsing` left there.
 */
export const CI_CSV_COLUMNS: readonly string[] = [
  "url",
  "finalUrl",
  "device",
  "status",
  "runId",
  ...LIGHTHOUSE_CATEGORIES,
  "passed",
  "violations",
  "errorMessage",
];

/**
 * One CSV row per page, header first, CRLF lines — `rowsToCsv`'s conventions.
 *
 * Every cell goes through `csvCell`, which is doing two jobs here: RFC 4180
 * quoting, and defusing the formula injection that `finalUrl` and
 * `errorMessage` can carry. This reporter is precisely the path that attack
 * needs — a pipeline archives the file and a human opens it in a spreadsheet —
 * so nothing may reach the output that has not been through it.
 */
function renderCsv(report: CiReport): string {
  const lines = report.pages.map((page) => {
    const cells: (string | number | null)[] = [
      clampText(page.url, MAX_URL_CHARS),
      page.finalUrl === null ? null : clampText(page.finalUrl, MAX_URL_CHARS),
      page.formFactor,
      page.status,
      page.runId,
      ...LIGHTHOUSE_CATEGORIES.map((category) => page.scores[category] ?? null),
      String(page.violations.length === 0),
      page.violations.length === 0
        ? null
        : clampText(
            page.violations.map(describeViolation).join("; "),
            MAX_VIOLATION_CHARS,
          ),
      page.errorMessage === null
        ? null
        : clampText(page.errorMessage, MAX_ERROR_CHARS),
    ];
    return cells.map(csvCell).join(",");
  });
  return [CI_CSV_COLUMNS.join(","), ...lines].join("\r\n");
}

/* -------------------------------------------------------------------------- */
/* HTML reporter                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The whole stylesheet, inline.
 *
 * Design notes, because a standalone file cannot inherit the app's tokens and
 * will otherwise drift from it:
 *
 *  - **Everything is monospace.** Not a compromise forced by having no network —
 *    a committed choice. This is an instrument readout printed to a file, and
 *    letting one typeface carry it with weight, size, tracking and colour doing
 *    all the hierarchy is both truer to the product's "precision instrument"
 *    identity and immune to the generic-sans fallback a `system-ui` heading
 *    would have collapsed into. `JetBrains Mono` and `Archivo` lead their stacks
 *    so a machine that already has the app's faces installed uses them; nothing
 *    is fetched either way.
 *  - **Colour is semantic only.** The score bands (green ≥90, amber ≥50, red
 *    below) and a single signal-cyan for structure — the same division of labour
 *    the dark theme makes, where cyan is deliberately kept clear of the score
 *    hues. Values are hex rather than the app's `oklch()` because this file is
 *    opened by whatever a build page hands it, with no build step to fall back on.
 *  - **Never colour alone.** Every band-coloured figure sits beside its number,
 *    a status word, or a written violation line.
 *  - **No motion.** A CI artifact is read, not toured.
 */
const HTML_STYLE = `
:root {
  --bg: #0e1114;
  --panel: #14181c;
  --panel-2: #191e23;
  --line: rgba(255,255,255,0.09);
  --line-strong: rgba(255,255,255,0.16);
  --fg: #eef1f4;
  --muted: #98a3ac;
  --signal: #5ad1e3;
  --good: #2fb98a;
  --average: #dfa036;
  --poor: #e75f4c;
  --mono: "JetBrains Mono", "Archivo", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html { color-scheme: dark; }
body {
  margin: 0;
  padding: 40px 24px 72px;
  background: var(--bg);
  /* Faint console rule-lines: atmosphere with no asset and no request. */
  background-image: repeating-linear-gradient(
    to bottom,
    rgba(255,255,255,0.017) 0 1px,
    transparent 1px 4px
  );
  color: var(--fg);
  font: 400 13px/1.55 var(--mono);
  -webkit-font-smoothing: antialiased;
}
.sheet { max-width: 1120px; margin: 0 auto; }
.eyebrow {
  font-size: 10px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--muted);
}
.masthead { border-bottom: 1px solid var(--line-strong); padding-bottom: 28px; }
.verdict { display: flex; align-items: baseline; gap: 18px; margin-top: 14px; flex-wrap: wrap; }
.verdict__word {
  font-size: 56px;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1;
}
.verdict--pass .verdict__word { color: var(--good); }
.verdict--fail .verdict__word { color: var(--poor); }
.verdict__line { color: var(--muted); font-size: 13px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 32px; margin-top: 22px; }
.meta__item { display: flex; flex-direction: column; gap: 3px; }
.meta__value { font-size: 12px; word-break: break-all; }
section { margin-top: 34px; }
.section__title {
  font-size: 10px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--signal);
  margin: 0 0 14px;
  font-weight: 500;
}
.totals { display: flex; flex-wrap: wrap; gap: 1px; background: var(--line); border: 1px solid var(--line); }
.stat { flex: 1 1 140px; background: var(--panel); padding: 16px 18px; }
.stat__value { font-size: 30px; font-weight: 600; line-height: 1.1; }
.stat--failed .stat__value { color: var(--poor); }
.stat--passed .stat__value { color: var(--good); }
.stat__label { margin-top: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  border: 1px solid var(--line-strong);
  background: var(--panel);
  padding: 6px 11px;
  font-size: 11px;
  letter-spacing: 0.06em;
}
.chip__bar { color: var(--signal); }
.empty { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); }
caption { text-align: left; padding-bottom: 10px; color: var(--muted); font-size: 11px; }
th, td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 500;
  background: var(--panel-2);
  white-space: nowrap;
}
tbody tr:last-child td { border-bottom: none; }
th[scope="col"].num, td.num { text-align: right; width: 74px; }
abbr { text-decoration: none; border-bottom: 1px dotted var(--line-strong); }
.page { background: var(--panel); }
.page__url { word-break: break-all; font-size: 12.5px; }
.page__final { color: var(--muted); font-size: 11px; margin-top: 4px; word-break: break-all; }
.device { color: var(--muted); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap; }
.score { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
/* The gauge: a hairline whose length IS the score, under the figure it belongs to. */
.gauge { height: 2px; margin-top: 6px; background: var(--line-strong); }
.gauge__fill { display: block; height: 2px; }
.band-good { color: var(--good); }
.band-good .gauge__fill, .gauge__fill.band-good { background: var(--good); }
.band-average { color: var(--average); }
.band-average .gauge__fill, .gauge__fill.band-average { background: var(--average); }
.band-poor { color: var(--poor); }
.band-poor .gauge__fill, .gauge__fill.band-poor { background: var(--poor); }
.band-none { color: var(--muted); }
.status { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap; }
.status--ok { color: var(--good); }
.status--fail { color: var(--poor); }
.status--error { color: var(--poor); }
.notes { background: var(--panel-2); }
.notes td { padding-top: 0; }
.violations { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.violations li { font-size: 12px; color: var(--poor); }
.violations li::before { content: "\\2717\\00a0\\00a0"; }
.error { font-size: 12px; color: var(--average); word-break: break-word; margin-top: 6px; }
footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
@media (max-width: 720px) {
  body { padding: 24px 14px 48px; }
  .verdict__word { font-size: 40px; }
  table, thead, tbody, tr, th, td { display: block; }
  thead { display: none; }
  th[scope="col"].num, td.num { text-align: left; width: auto; }
  td { border-bottom: none; }
  .page { border-bottom: 1px solid var(--line-strong); }
}
`;

/** Band class name for a score, so colour and figure can never disagree. */
function bandClass(band: ScoreBand): string {
  return `band-${band}`;
}

/** One `<td>`: the figure, then a hairline gauge whose length is the score. */
function scoreCell(score: number | null | undefined): string {
  const band = scoreBand(score);
  const value = displayScore(score);
  if (band === "none") {
    return `<td class="num"><div class="score band-none">${escapeHtml(value)}</div></td>`;
  }
  // Clamped and rounded, so the only thing reaching a style attribute is an
  // integer 0–100 that this function computed.
  const pct = Math.max(0, Math.min(100, Math.round(Number(score))));
  return (
    `<td class="num"><div class="score ${bandClass(band)}">${escapeHtml(value)}</div>` +
    `<div class="gauge"><span class="gauge__fill ${bandClass(band)}" style="width:${pct}%"></span></div></td>`
  );
}

/** One page row, plus a second row for its violations / error when it has any. */
function pageRows(page: CiPage): string {
  const passed = page.violations.length === 0;
  const finalUrl =
    page.finalUrl !== null && page.finalUrl !== page.url
      ? `<div class="page__final">→ ${htmlText(page.finalUrl, MAX_URL_CHARS)}</div>`
      : "";
  // Three states, and the word and the colour must agree on which one it is: an
  // errored run reads "Error", a measured run that missed a bar reads "Fail",
  // and only a clean one is green. Keying the colour off `page.status` while
  // keying the word off the verdict is how a failing page ends up printed in
  // the pass colour.
  const [statusWord, statusClass] =
    page.status === "error"
      ? ["Error", "status--error"]
      : passed
        ? ["Pass", "status--ok"]
        : ["Fail", "status--fail"];

  const main =
    `<tr class="page">` +
    `<td><div class="page__url">${htmlText(page.url, MAX_URL_CHARS)}</div>${finalUrl}</td>` +
    `<td><span class="device">${escapeHtml(page.formFactor)}</span></td>` +
    LIGHTHOUSE_CATEGORIES.map((category) => scoreCell(page.scores[category])).join("") +
    `<td><span class="status ${statusClass}">${escapeHtml(statusWord)}</span></td>` +
    `</tr>`;

  if (passed && page.errorMessage === null) return main;

  const violations = passed
    ? ""
    : `<ul class="violations">${page.violations
        .map((v) => `<li>${htmlText(describeViolation(v), MAX_VIOLATION_CHARS)}</li>`)
        .join("")}</ul>`;
  const error =
    page.errorMessage === null
      ? ""
      : `<div class="error">${htmlText(page.errorMessage, MAX_ERROR_CHARS)}</div>`;

  // colspan covers URL + device + every category + status, so the notes row
  // stays aligned when Lighthouse adds a sixth category.
  const span = LIGHTHOUSE_CATEGORIES.length + 3;
  return `${main}<tr class="notes"><td colspan="${span}">${violations}${error}</td></tr>`;
}

/** Whole-seconds wall time between two ISO stamps; `null` if either is unusable. */
function durationSeconds(startedAt: string, finishedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

/**
 * The self-contained HTML summary.
 *
 * The CSP `<meta>` is defence in depth, not the control: escaping is what keeps
 * the payload out, and `default-src 'none'` is what makes "no network requests
 * of any kind" a property of the document rather than a claim in a comment —
 * it also means an injection that somehow got past the escaping still could not
 * run or phone home. `style-src 'unsafe-inline'` is the one allowance, for the
 * stylesheet above and the gauge widths.
 *
 * Timestamps print as their ISO strings. No `Date.now()`, no `toLocaleString()`,
 * no ambient anything: the same report renders byte-identical on any machine,
 * which is the only way a pipeline can usefully diff two artifacts.
 */
function renderHtml(report: CiReport): string {
  const { totals } = report;
  const verdict = report.ok ? "PASS" : "FAIL";
  const verdictClass = report.ok ? "verdict--pass" : "verdict--fail";
  const summary = report.ok
    ? `${totals.pages} ${totals.pages === 1 ? "page" : "pages"} met every budget.`
    : `${totals.failed} of ${totals.pages} ${totals.pages === 1 ? "page" : "pages"} missed a budget · ` +
      `${report.violations.length} ${report.violations.length === 1 ? "violation" : "violations"}.`;

  const budgetEntries = Object.entries(orderedBudgets(report.budgets)) as [
    LighthouseCategory,
    number,
  ][];
  const budgets =
    budgetEntries.length === 0
      ? `<p class="empty">No budgets applied — every page is reported, none is judged.</p>`
      : `<div class="chips">${budgetEntries
          .map(
            ([category, budget]) =>
              `<span class="chip">${escapeHtml(CATEGORY_LABELS[category] ?? category)} ` +
              `<span class="chip__bar">&ge; ${escapeHtml(String(budget))}</span></span>`,
          )
          .join("")}</div>`;

  const stat = (value: number, label: string, modifier = ""): string =>
    `<div class="stat ${modifier}"><div class="stat__value">${escapeHtml(String(value))}</div>` +
    `<div class="stat__label eyebrow">${escapeHtml(label)}</div></div>`;

  const meta = (label: string, value: string): string =>
    `<div class="meta__item"><span class="eyebrow">${escapeHtml(label)}</span>` +
    `<span class="meta__value">${escapeHtml(value)}</span></div>`;

  const seconds = durationSeconds(report.startedAt, report.finishedAt);

  const pages =
    report.pages.length === 0
      ? `<p class="empty">No pages were audited.</p>`
      : `<table><caption>One row per persisted run, in batch order.</caption>` +
        `<thead><tr>` +
        `<th scope="col">Page</th><th scope="col">Device</th>` +
        LIGHTHOUSE_CATEGORIES.map(
          (category) =>
            `<th scope="col" class="num"><abbr title="${escapeHtml(
              CATEGORY_LABELS[category] ?? category,
            )}">${escapeHtml(CATEGORY_SHORT_LABELS[category] ?? category)}</abbr></th>`,
        ).join("") +
        `<th scope="col">Result</th>` +
        `</tr></thead><tbody>${report.pages.map(pageRows).join("")}</tbody></table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>LightAudit CI — ${escapeHtml(verdict)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<main class="sheet">
<header class="masthead">
<p class="eyebrow">LightAudit Score · CI report</p>
<div class="verdict ${verdictClass}">
<span class="verdict__word">${escapeHtml(verdict)}</span>
<span class="verdict__line">${escapeHtml(summary)}</span>
</div>
<div class="meta">
${meta("Batch", report.batchId)}
${meta("Started", report.startedAt)}
${meta("Finished", report.finishedAt)}
${meta("Duration", seconds === null ? ABSENT : `${seconds}s`)}
</div>
</header>
<section>
<h2 class="section__title">Totals</h2>
<div class="totals">
${stat(totals.pages, "Pages")}
${stat(totals.passed, "Passed", "stat--passed")}
${stat(totals.failed, "Failed", "stat--failed")}
${stat(totals.errored, "Errored")}
</div>
</section>
<section>
<h2 class="section__title">Budgets</h2>
${budgets}
</section>
<section>
<h2 class="section__title">Pages</h2>
${pages}
</section>
<footer>Scores band at ${GOOD_THRESHOLD}+ (good) and ${AVERAGE_THRESHOLD}+ (average). URLs are shown as text and are never links. Generated by LightAudit Score.</footer>
</main>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** Render a finished report in one of the four formats. Pure: returns a string. */
export function renderCiReport(report: CiReport, format: CiReporter): string {
  switch (format) {
    case "json":
      return renderJson(report, false);
    case "jsonExpanded":
      return renderJson(report, true);
    case "csv":
      return renderCsv(report);
    case "html":
      return renderHtml(report);
  }
}
