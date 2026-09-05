/**
 * Pure batch-summary helpers (PRD §6 Phase 6 — Comparison & trends).
 *
 * The single source of truth for how a batch's persisted runs are aggregated for
 * the `/batches` summary view: grouping runs by batch, averaging category scores,
 * deriving a per-run "overall" score, picking best/worst pages, and counting
 * pass/fail against user-configurable per-category thresholds.
 *
 * Kept free of React/DOM imports so it can be unit-tested in isolation and reused
 * by any UI piece. Mirrors the conventions in `@/lib/scores`: null/undefined/NaN
 * scores are treated as "missing" and excluded from every aggregate.
 */

import type { HistoryRow } from "@/lib/db/persistence";
import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";

/** Per-category pass/fail tally against a threshold. */
export interface CategoryPassFail {
  /** Runs at or above the threshold for this category. */
  pass: number;
  /** Runs below the threshold (incl. failed runs — see {@link passFail}). */
  fail: number;
  /** Runs that contribute to this category (pass + fail). */
  total: number;
}

/** Pass/fail tallies keyed by Lighthouse category. */
export type PassFailByCategory = Record<LighthouseCategory, CategoryPassFail>;

/** The best- and worst-scoring done run in a batch, by overall score. */
export interface BestWorstPages {
  best: HistoryRow | null;
  worst: HistoryRow | null;
}

/** A run is "done" when it completed with scores (failed runs carry no scores). */
function isDone(row: HistoryRow): boolean {
  return row.status === "done";
}

/** Treat null/undefined/NaN as missing, matching `@/lib/scores` semantics. */
function isPresent(score: number | null | undefined): score is number {
  return score !== null && score !== undefined && !Number.isNaN(score);
}

/**
 * Group runs by their `batchId`, preserving input order within each group.
 * Callers pass `listHistory()` output (newest-first), so each group stays
 * newest-first too.
 */
export function groupRunsByBatch(rows: HistoryRow[]): Map<string, HistoryRow[]> {
  const groups = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.batchId);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(row.batchId, [row]);
    }
  }
  return groups;
}

/**
 * Mean score per category over **done** runs, ignoring missing (null) values.
 * A category is `null` when no done run in the batch has a score for it. Only
 * categories that appear in at least one done run are returned as keys.
 */
export function averageScores(rows: HistoryRow[]): CategoryScores {
  const sums = new Map<LighthouseCategory, { sum: number; count: number }>();

  for (const row of rows) {
    if (!isDone(row)) continue;
    for (const category of LIGHTHOUSE_CATEGORIES) {
      const score = row.scores[category];
      if (!isPresent(score)) continue;
      const acc = sums.get(category);
      if (acc) {
        acc.sum += score;
        acc.count += 1;
      } else {
        sums.set(category, { sum: score, count: 1 });
      }
    }
  }

  const result: CategoryScores = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const acc = sums.get(category);
    if (acc) result[category] = acc.sum / acc.count;
  }
  return result;
}

/**
 * A run's "overall" score: the mean of its available (non-null) category scores.
 * Returns `null` when the run has no scored categories.
 */
export function overallScore(scores: CategoryScores): number | null {
  let sum = 0;
  let count = 0;
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const score = scores[category];
    if (!isPresent(score)) continue;
    sum += score;
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

/**
 * Best- and worst-scoring **done** runs by overall score. Ties resolve to the
 * first run encountered (input order). Returns `{ best: null, worst: null }`
 * when no done run has an overall score.
 */
export function bestWorstPages(rows: HistoryRow[]): BestWorstPages {
  let best: HistoryRow | null = null;
  let bestScore = -Infinity;
  let worst: HistoryRow | null = null;
  let worstScore = Infinity;

  for (const row of rows) {
    if (!isDone(row)) continue;
    const overall = overallScore(row.scores);
    if (overall === null) continue;
    if (overall > bestScore) {
      bestScore = overall;
      best = row;
    }
    if (overall < worstScore) {
      worstScore = overall;
      worst = row;
    }
  }

  return { best, worst };
}

/**
 * Per-category pass/fail counts against `thresholds` (a page passes a category
 * when its score is `>= threshold` — the boundary value passes). When a category
 * has no configured threshold, {@link GOOD_THRESHOLD_FALLBACK} (90) is used.
 *
 * Failed runs (status `error`) and done runs missing a category's score are
 * counted as **fail** for that category, and contribute to its `total`. This is
 * deliberate: the summary answers "how many of the batch's pages meet the bar?",
 * so a page that errored or was never scored has not met it. (Tested explicitly.)
 */
export function passFail(
  rows: HistoryRow[],
  thresholds: Partial<Record<LighthouseCategory, number>>,
): PassFailByCategory {
  const result = {} as PassFailByCategory;

  for (const category of LIGHTHOUSE_CATEGORIES) {
    const threshold = thresholds[category] ?? GOOD_THRESHOLD_FALLBACK;
    let pass = 0;
    let fail = 0;

    for (const row of rows) {
      const score = isDone(row) ? row.scores[category] : null;
      if (isPresent(score) && score >= threshold) {
        pass += 1;
      } else {
        fail += 1;
      }
    }

    result[category] = { pass, fail, total: pass + fail };
  }

  return result;
}

/** How many scored pages clear every one of their thresholds at once. */
export interface ClearingTally {
  /** Pages whose every present category score met that category's threshold. */
  clearing: number;
  /** Pages carrying at least one category score (i.e. the pages that could clear). */
  total: number;
}

/**
 * Cross-category counterpart to {@link passFail}: rather than "how many pages met
 * the SEO bar", it answers "how many pages met *all* of their bars at once" — the
 * single number a summary readout can carry without repeating the per-category grid.
 *
 * A page clears when every category it actually scored sits at or above that
 * category's threshold. Categories the batch never ran are ignored rather than
 * failed (a Performance-only batch would otherwise always read 0 clearing), and
 * pages with no scores at all — errors, cancelled runs — stay out of `total`
 * entirely, so the ratio is "of the pages we measured".
 */
/**
 * Whether ONE run clears its thresholds: every category the run actually scored
 * sits at or above that category's bar (missing bars fall back to
 * {@link GOOD_THRESHOLD_FALLBACK}). A run that measured nothing — an error, or a
 * row with no scores — never clears.
 *
 * Judging on the categories PRESENT, not on all of them, is what keeps a schema
 * migration from re-judging history: when Lighthouse 13.3's `agentic-browsing`
 * column arrived, every previously-persisted run carried `null` there, and a
 * rule requiring all five present would have flipped the entire back catalogue
 * to failing without a single page having changed.
 *
 * Exported so the History page's Needs-work gate and the Batch Summary's
 * clearing tally are the SAME predicate rather than two copies that drifted —
 * they previously disagreed, and the fifth category made the disagreement
 * visible.
 */
export function rowClearsThresholds(
  row: HistoryRow,
  thresholds: Partial<Record<LighthouseCategory, number>> = {},
): boolean {
  if (!isDone(row)) return false;

  const scored = LIGHTHOUSE_CATEGORIES.filter((category) =>
    isPresent(row.scores[category]),
  );
  // A run with nothing measured has cleared nothing — it is not vacuously a pass.
  if (scored.length === 0) return false;

  return scored.every((category) => {
    const score = row.scores[category] as number;
    return score >= (thresholds[category] ?? GOOD_THRESHOLD_FALLBACK);
  });
}

export function pagesClearingThresholds(
  rows: HistoryRow[],
  thresholds: Partial<Record<LighthouseCategory, number>>,
): ClearingTally {
  let clearing = 0;
  let total = 0;

  for (const row of rows) {
    if (!isDone(row)) continue;
    // Pages with nothing measured stay out of `total` entirely (see the docblock),
    // which is the one case `rowClearsThresholds` cannot express in a boolean.
    const hasAnyScore = LIGHTHOUSE_CATEGORIES.some((category) =>
      isPresent(row.scores[category]),
    );
    if (!hasAnyScore) continue;

    total += 1;
    if (rowClearsThresholds(row, thresholds)) clearing += 1;
  }

  return { clearing, total };
}

/** Fallback pass threshold (mirrors `@/lib/scores` GOOD_THRESHOLD) when none is set. */
export const GOOD_THRESHOLD_FALLBACK = 90;
