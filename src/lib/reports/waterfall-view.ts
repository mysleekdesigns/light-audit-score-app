/**
 * Pure presentation logic for the request waterfall (ROADMAP Phase D).
 *
 * Vitest runs `environment: "node"` here — there is no jsdom and no
 * testing-library — so the house pattern is to keep everything *decidable*
 * out of the component and unit-test it directly. `RequestWaterfall`
 * (`src/components/audit/request-waterfall.tsx`) imports this module and does
 * nothing but map its results onto markup: the sort comparators, the bar
 * geometry, the number formatting and the row-mark predicates all live here.
 *
 * Every function is total. A stored report can be years old and a hostile page
 * can serve anything, so a `null` timing, a `data:` URL with no host, an
 * unfinished request and a zero-length timeline are all ordinary inputs that
 * must produce something renderable — never `NaN%`, never a throw.
 *
 * SECURITY: the `path`/`host`/`url` this module reads are attacker-controlled
 * (see the module note on `@/lib/reports/types`). Nothing here builds markup or
 * an href — it only measures, formats and reorders — so the escaping obligation
 * stays with the component, which renders every one of these strings as text.
 */

import type { WaterfallData, WaterfallRequest } from "@/lib/reports/types";

/* -------------------------------------------------------------------------- */
/* Sorting                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The columns a user can order the waterfall by. `index` is the LHR's own
 * request order — the default, and the only one that restores "what Lighthouse
 * saw", which is why it is a first-class key rather than an implicit reset.
 */
export type WaterfallSortKey =
  | "index"
  | "request"
  | "type"
  | "size"
  | "start"
  | "duration";

export type SortDirection = "asc" | "desc";

export interface WaterfallSort {
  key: WaterfallSortKey;
  direction: SortDirection;
}

/** The LHR's own order, ascending — how the waterfall first renders. */
export const DEFAULT_WATERFALL_SORT: WaterfallSort = {
  key: "index",
  direction: "asc",
};

/**
 * The direction a column takes when it is newly picked. Text and time columns
 * open ascending (A→Z, earliest first — a waterfall reads top-down in time);
 * `size` and `duration` open descending, because the only reason to sort by
 * either is to find the worst offender.
 */
export function defaultDirection(key: WaterfallSortKey): SortDirection {
  return key === "size" || key === "duration" ? "desc" : "asc";
}

/** Clicking a header: flip the active column, else adopt the new one's default. */
export function nextSort(prev: WaterfallSort, key: WaterfallSortKey): WaterfallSort {
  if (prev.key === key) {
    return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: defaultDirection(key) };
}

/**
 * The fields the comparators read. Declared as a `Pick` rather than the whole
 * {@link WaterfallRequest} so tests can build a three-field row, and so it is
 * obvious at a glance which parts of the frozen contract sorting depends on.
 */
export type SortableRequest = Pick<
  WaterfallRequest,
  "index" | "host" | "path" | "resourceType" | "transferSize" | "startTime" | "durationMs"
>;

/**
 * Compare two possibly-absent numbers. `null` means Lighthouse never recorded
 * the value, which is not "zero" and not "huge" — it is unknown, so those rows
 * sink to the bottom in BOTH directions rather than pretending to be extremes.
 */
function compareNullable(a: number | null, b: number | null, direction: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

/** Deterministic string order (no locale dependence, so tests can't drift). */
function compareText(a: string, b: string, direction: SortDirection): number {
  if (a === b) return 0;
  const ascending = a < b ? -1 : 1;
  return direction === "asc" ? ascending : -ascending;
}

/**
 * Order a request list. Non-mutating (`toSorted`), and **stable by construction**:
 * every comparator falls back to `index`, un-negated, so rows that tie keep the
 * LHR's order whichever direction the column is sorted in. That un-negated
 * tiebreak is the point — it means a row's identity survives every sort, and
 * flipping a column never silently reshuffles equal rows.
 */
export function sortRequests<T extends SortableRequest>(
  requests: readonly T[],
  sort: WaterfallSort,
): T[] {
  const { key, direction } = sort;
  return requests.toSorted((a, b) => {
    let primary = 0;
    switch (key) {
      case "index":
        primary = direction === "asc" ? a.index - b.index : b.index - a.index;
        break;
      // Host first, then path: grouping a third-party's requests together is
      // what makes this column worth sorting by at all.
      case "request":
        primary =
          compareText(a.host, b.host, direction) ||
          compareText(a.path, b.path, direction);
        break;
      case "type":
        primary = compareText(a.resourceType, b.resourceType, direction);
        break;
      case "size":
        primary = compareNullable(a.transferSize, b.transferSize, direction);
        break;
      case "start":
        primary = compareNullable(a.startTime, b.startTime, direction);
        break;
      case "duration":
        primary = compareNullable(a.durationMs, b.durationMs, direction);
        break;
    }
    return primary !== 0 ? primary : a.index - b.index;
  });
}

/* -------------------------------------------------------------------------- */
/* Bar geometry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Smallest bar we will draw, as a percentage of the timeline. A cache hit can
 * finish in well under a millisecond; on a 4-second timeline that is ~0.01% and
 * would render as literally nothing, so the row would look like a missing bar
 * rather than a fast request.
 */
export const MIN_BAR_PCT = 0.8;

/** Where one request's bar sits on the timeline, as CSS-ready percentages. */
export interface BarGeometry {
  /** Distance from the track's left edge, 0–100. */
  offsetPct: number;
  /** Bar length, always ≥ {@link MIN_BAR_PCT} and never past the right edge. */
  widthPct: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Round to 4 decimal places — far finer than a pixel on any track, and enough
 * to keep binary-float dust out of the numbers. Without it `100 − 99.2` lands
 * at `0.7999999999999972`, which both undershoots {@link MIN_BAR_PCT} and puts
 * seventeen digits into a `style` attribute.
 */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Place one request's bar on a timeline `timelineMs` long.
 *
 * Returns `null` — meaning "draw no bar" — when the geometry would be a lie:
 * no start time, or no usable timeline (absent, zero, negative, or non-finite,
 * any of which would divide into `Infinity`/`NaN` and emit `NaN%` into a style
 * attribute). An unfinished request keeps its start and gets the minimum width,
 * since "it began here, we never saw it end" is real information and stretching
 * the bar to the timeline's end would invent a duration Lighthouse never saw.
 *
 * The offset is capped at `100 − MIN_BAR_PCT` before the width is clamped, so
 * `offsetPct + widthPct` can never exceed 100 and a bar can never overflow its
 * track — including the pathological case of an `endTime` past `timelineMs`.
 */
export function barGeometry(
  request: Pick<WaterfallRequest, "startTime" | "endTime">,
  timelineMs: number | null,
): BarGeometry | null {
  if (timelineMs === null || !Number.isFinite(timelineMs) || timelineMs <= 0) return null;
  const { startTime } = request;
  if (startTime === null || !Number.isFinite(startTime)) return null;

  const end =
    request.endTime !== null && Number.isFinite(request.endTime)
      ? request.endTime
      : startTime;

  const offsetPct = round4(clamp((startTime / timelineMs) * 100, 0, 100 - MIN_BAR_PCT));
  // The offset is already capped below 100, so the remaining track is at least
  // MIN_BAR_PCT wide; `Math.max` only defends the invariant against float dust,
  // and keeps the upper bound from ever undercutting the lower one.
  const maxWidthPct = Math.max(round4(100 - offsetPct), MIN_BAR_PCT);
  const rawWidthPct = round4(((end - startTime) / timelineMs) * 100);
  const widthPct = clamp(rawWidthPct, MIN_BAR_PCT, maxWidthPct);
  return { offsetPct, widthPct };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const KB = 1024;
const MB = KB * KB;

/** What every formatter emits for a value Lighthouse did not record. */
export const ABSENT = "—";

/**
 * Bytes as a compact figure for a dense mono column: `0 B`, `812 B`, `4.2 KB`,
 * `1.3 MB`.
 *
 * The unit is chosen from the *rounded* value, not the raw one, so the boundary
 * cases read as `1.0 MB` rather than the 6-character-wider `1024.0 KB` — in a
 * `tabular-nums` column, a row that is suddenly two units wide is a visual bug.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return ABSENT;
  }
  if (bytes < KB) return `${Math.round(bytes)} B`;
  const kb = bytes / KB;
  if (Number(kb.toFixed(1)) < KB) return `${kb.toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * A duration for the same column: `0 ms`, `84 ms`, `1.24 s`. Same
 * round-then-pick-the-unit rule as {@link formatBytes}, so 999.6 ms shows as
 * `1.00 s` instead of `1000 ms`.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return ABSENT;
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Zero-pad a row number to the width of the largest one, so the leading column
 * stays a straight edge from `001` to `104` (the same padded-ordinal treatment
 * the results table's URL cell uses). One-based: the `#` a user reads is the
 * request's position, not its array offset.
 */
export function formatRowNumber(index: number, count: number): string {
  const width = String(Math.max(count, 1)).length;
  return String(index + 1).padStart(width, "0");
}

/**
 * Longest label put into the DOM for one row. Far more than a 672px cell can
 * show — the clamp is a ceiling on what reaches the document, not a design
 * choice about where to truncate, which CSS still does.
 */
export const MAX_LABEL = 240;

/**
 * Cut over-long text to `max` characters with an ellipsis.
 *
 * Needed because a `data:` URL is a legitimate waterfall row and can be
 * megabytes of base64. CSS `truncate` handles the visible cell, but neither a
 * `title` attribute nor a text node has any such limit, and both would
 * otherwise hand the browser the whole blob.
 */
export function clampText(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* -------------------------------------------------------------------------- */
/* Row derivation                                                              */
/* -------------------------------------------------------------------------- */

/** Hostname of a URL, or `""` when it will not parse (`data:`, `blob:`, junk). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The text a row shows for its request, plus whether it left the page's host. */
export interface RequestLabel {
  /** Bare path for a same-host request, `host + path` when it crossed hosts. */
  text: string;
  /** True when the request's host differs from the audited page's. */
  crossHost: boolean;
}

/**
 * What to print in the Request column.
 *
 * A same-host request shows only its path — repeating the page's own hostname
 * on 60 of 104 rows is noise that pushes the meaningful part out of a narrow
 * sheet. A cross-host request keeps its hostname, because *whose* CDN this is
 * is the first thing anyone reading a waterfall wants to know. This is a
 * display distinction only: `thirdParty` (Lighthouse's entity classification)
 * is what the row *marks*, and a page can serve first-party assets from a
 * different host, so the two must not be conflated.
 */
export function requestLabel(
  request: Pick<WaterfallRequest, "url" | "path" | "host">,
  finalHost: string,
): RequestLabel {
  // Clamped for the same reason the hover title is, and it was an oversight
  // that only the title was: CSS `truncate` hides an over-long label, it does
  // not shorten it, so the whole string still lands in a DOM text node. A
  // megabyte-scale `data:` URL would put a megabyte there, per row.
  const path = clampText(request.path || request.url, MAX_LABEL);
  if (request.host && finalHost && request.host !== finalHost) {
    return { text: clampText(`${request.host}${path}`, MAX_LABEL), crossHost: true };
  }
  return { text: path, crossHost: false };
}

/** The marks a row can carry. Both are rendered as text, never colour alone. */
export type RequestMarkId = "render-blocking" | "third-party";

/**
 * Which marks a row earns. Render-blocking first: it is the actionable one, and
 * a row carrying both should lead with the finding, not the provenance.
 */
export function requestMarks(
  request: Pick<WaterfallRequest, "renderBlocking" | "thirdParty">,
): RequestMarkId[] {
  const marks: RequestMarkId[] = [];
  if (request.renderBlocking) marks.push("render-blocking");
  if (request.thirdParty) marks.push("third-party");
  return marks;
}

/** How a row's timing bar is coloured — one tone per row, in priority order. */
export type BarTone = "blocking" | "third-party" | "first-party";

/**
 * The bar's tone. Render-blocking outranks third-party so the bars that explain
 * a bad First Contentful Paint stay legible even in a page full of trackers.
 * Colour is a *reinforcement* here: the same two facts are also printed as `RB`
 * and `3P` chips, so the waterfall still reads correctly in greyscale.
 */
export function barTone(
  request: Pick<WaterfallRequest, "renderBlocking" | "thirdParty">,
): BarTone {
  if (request.renderBlocking) return "blocking";
  if (request.thirdParty) return "third-party";
  return "first-party";
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

/** The one-line readout above the table — every figure already precomputed. */
export interface WaterfallSummary {
  requestCount: number;
  thirdPartyCount: number;
  /** Total transfer size, pre-formatted by {@link formatBytes}. */
  transferLabel: string;
  /** Timeline extent, pre-formatted by {@link formatDuration}. */
  timelineLabel: string;
}

/**
 * Project the header figures out of the payload. The extractor already summed
 * the bytes and counted the third parties, so this only picks and formats —
 * re-deriving them from `requests` would risk disagreeing with the contract.
 */
export function summarizeWaterfall(data: WaterfallData): WaterfallSummary {
  return {
    requestCount: data.requests.length,
    thirdPartyCount: data.thirdPartyCount,
    transferLabel: formatBytes(data.totalTransferSize),
    timelineLabel: formatDuration(data.timelineMs),
  };
}
