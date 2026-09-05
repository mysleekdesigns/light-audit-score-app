/**
 * Pure comparison/trend helpers for the Compare view (PRD §6 Phase 6).
 *
 * The single source of truth for how persisted runs are grouped per-URL, diffed
 * between two runs (score deltas + Core Web Vitals deltas), and unrolled into an
 * ordered time-series for the trend chart/sparklines. Kept free of React/DOM
 * imports so it is unit-testable and reusable.
 *
 * Conventions:
 *  - Only `status === "done"` runs are comparable (failed runs carry null
 *    scores/metrics) — every helper here filters to done runs.
 *  - "Time" for ordering/labels is `fetchTime ?? createdAt` (the LHR fetch time
 *    when present, else the persistence timestamp).
 *  - Category scores: HIGHER is better → a positive delta is an improvement.
 *  - Core Web Vitals: LOWER numericValue is better → a negative delta is an
 *    improvement (an increase is a regression).
 */

import type { HistoryRow } from "@/lib/db/persistence";
import {
  LIGHTHOUSE_CATEGORIES,
  METRIC_IDS,
  type CategoryScores,
  type CoreWebVitals,
  type LighthouseCategory,
  type MetricId,
  type MetricValue,
} from "@/lib/lighthouse/types";

/** The effective ordering/display time for a run: LHR fetchTime, else persistedAt. */
export function runTime(row: HistoryRow): string {
  return row.fetchTime ?? row.createdAt;
}

/** Direction of a category-score delta (higher score = improvement). */
export type ScoreDirection = "up" | "down" | "flat" | "none";

/** A URL with all of its comparable (done) runs, sorted ascending by time. */
export interface UrlGroup {
  url: string;
  runs: HistoryRow[];
}

/** One category's baseline → comparison score diff. */
export interface ScoreDiff {
  category: LighthouseCategory;
  baseline: number | null;
  comparison: number | null;
  /** comparison − baseline, or null when either side is missing. */
  delta: number | null;
  /**
   * `up` (improved), `down` (regressed), `flat` (no change), or `none`
   * (a value is missing). Higher score is better.
   */
  direction: ScoreDirection;
}

/** One metric's baseline → comparison diff (lower numericValue is better). */
export interface MetricDiff {
  id: MetricId;
  baseline: MetricValue | null;
  comparison: MetricValue | null;
  /** comparison − baseline numericValue, or null when either side is missing. */
  delta: number | null;
  /**
   * `true` when the metric improved (numericValue went down), `false` when it
   * regressed (went up), `null` when unchanged or a value is missing.
   */
  improved: boolean | null;
}

/** One point on the per-URL score trend (one per run, oldest → newest). */
export type ScoreTrendPoint = {
  /** Effective time (`fetchTime ?? createdAt`) — the chart's x dataKey. */
  t: string;
  /** Short, human-readable axis label for this point. */
  label: string;
  /** Originating run id (for keys / linking). */
  runId: string;
} & Record<LighthouseCategory, number | null>;

/** Ascending-by-time comparator over history rows (stable for equal times). */
function byTimeAsc(a: HistoryRow, b: HistoryRow): number {
  const cmp = runTime(a).localeCompare(runTime(b));
  if (cmp !== 0) return cmp;
  // Tie-break on createdAt then id so ordering is deterministic.
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Group comparable (done) runs by their requested `url`, each group's runs
 * sorted ascending by time. Groups are returned ordered by descending run count
 * (most-audited URL first), tie-broken alphabetically — so the default URL
 * selection (group[0]) is the one with the richest trend.
 */
export function groupRunsByUrl(rows: HistoryRow[]): UrlGroup[] {
  const map = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    if (row.status !== "done") continue;
    const bucket = map.get(row.url);
    if (bucket) bucket.push(row);
    else map.set(row.url, [row]);
  }

  const groups: UrlGroup[] = [];
  for (const [url, runs] of map) {
    groups.push({ url, runs: runs.toSorted(byTimeAsc) });
  }

  return groups.toSorted(
    (a, b) => b.runs.length - a.runs.length || a.url.localeCompare(b.url),
  );
}

/** Round-aware equality for scores, treating null/undefined as missing. */
function scoreDirection(
  baseline: number | null,
  comparison: number | null,
): { delta: number | null; direction: ScoreDirection } {
  if (baseline === null || comparison === null) {
    return { delta: null, direction: "none" };
  }
  const delta = comparison - baseline;
  if (delta > 0) return { delta, direction: "up" };
  if (delta < 0) return { delta, direction: "down" };
  return { delta, direction: "flat" };
}

/** Normalise a possibly-undefined category score to `number | null`. */
function normScore(value: number | null | undefined): number | null {
  return value === undefined ? null : value;
}

/**
 * Diff two sets of category scores. Returns one {@link ScoreDiff} per category
 * in {@link LIGHTHOUSE_CATEGORIES} order. Higher score = improvement (`up`).
 */
export function diffScores(
  baseline: CategoryScores,
  comparison: CategoryScores,
): ScoreDiff[] {
  return LIGHTHOUSE_CATEGORIES.map((category) => {
    const b = normScore(baseline[category]);
    const c = normScore(comparison[category]);
    const { delta, direction } = scoreDirection(b, c);
    return { category, baseline: b, comparison: c, delta, direction };
  });
}

/**
 * Diff two sets of Core Web Vitals. Returns one {@link MetricDiff} per metric in
 * {@link METRIC_IDS} order. LOWER numericValue = improvement (`improved: true`);
 * a missing side yields `delta: null, improved: null`.
 */
export function diffMetrics(
  baseline: CoreWebVitals | null,
  comparison: CoreWebVitals | null,
): MetricDiff[] {
  return METRIC_IDS.map((id) => {
    const b = baseline?.[id] ?? null;
    const c = comparison?.[id] ?? null;
    const bv = b?.numericValue ?? null;
    const cv = c?.numericValue ?? null;

    if (bv === null || cv === null) {
      return { id, baseline: b, comparison: c, delta: null, improved: null };
    }
    const delta = cv - bv;
    // Lower is better: a decrease (delta < 0) is an improvement.
    const improved = delta === 0 ? null : delta < 0;
    return { id, baseline: b, comparison: c, delta, improved };
  });
}

/**
 * Format an ISO time into a compact axis/point label; falls back to the raw
 * value.
 *
 * The locale is pinned rather than left ambient: these labels are baked into the
 * chart's data props during SSR, so a browser on a different locale would render
 * different text than the server did and fail hydration. The surrounding copy is
 * English-only. The chart's narrow-width tick also splits this on its comma, so
 * the day must come first.
 */
function trendLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Build the ordered (oldest → newest) score trend for a set of runs. Filters to
 * done runs, sorts ascending by time, and projects each run's category
 * scores into a chart-ready point. Pass a single URL's runs (already grouped).
 */
export function buildScoreTrend(rows: HistoryRow[]): ScoreTrendPoint[] {
  return rows
    .filter((row) => row.status === "done")
    .toSorted(byTimeAsc)
    .map((row) => {
      const t = runTime(row);
      return {
        t,
        label: trendLabel(t),
        runId: row.id,
        ...(Object.fromEntries(
          LIGHTHOUSE_CATEGORIES.map((category) => [
            category,
            normScore(row.scores[category]),
          ]),
        ) as Record<LighthouseCategory, number | null>),
      };
    });
}
