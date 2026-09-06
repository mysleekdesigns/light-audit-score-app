/**
 * CI contract (ROADMAP Phase F) — budgets, verdicts and the report shape.
 *
 * The whole feature is one sentence: **run some pages, compare their scores to a
 * bar, exit 1 if any page misses it.** Everything here exists to make that
 * sentence precise enough to be trusted in a pipeline, where nobody reads the
 * output until it goes red.
 *
 * Three decisions this contract encodes, each of which could reasonably have
 * gone the other way:
 *
 *  1. **The verdict is computed from what was PERSISTED, not from what the queue
 *     returned in memory.** The CLI submits a batch, waits for it to settle, then
 *     reads the runs back out of SQLite and judges those rows. That makes the
 *     plan's "runs must still persist to History" structurally true rather than
 *     merely asserted: if persistence broke, there would be no rows to judge and
 *     the run would fail loudly instead of passing green with an empty archive.
 *
 *  2. **A page that could not be measured FAILS.** An errored run, or a run
 *     missing a budgeted category's score, is a violation — not a skip. CI's job
 *     is to refuse to go green on the unknown, and this is the opposite of the
 *     rule the alert core follows (ROADMAP Phase C, where a missing score is
 *     silence). The difference is deliberate: an alert that fires on every flaky
 *     night trains people to ignore it, while a build that passes because the
 *     audit crashed is worse than useless. Both rules are "do not guess"; they
 *     just fail in opposite directions, and each is right for its own consumer.
 *
 *  3. **Only budgeted categories are judged.** A budget names the bars that
 *     matter; a category with no bar is reported and never fails the build. This
 *     is what stops `--budget 90` from being unusable the moment Lighthouse adds
 *     a sixth category (13.3 added `agentic-browsing`, and the batch summary's
 *     own `rowClearsThresholds` carries the same scar).
 */

import type {
  CategoryScores,
  CoreWebVitals,
  FormFactor,
  LighthouseCategory,
} from "@/lib/lighthouse/types";

/**
 * Per-category pass bars, 0–100.
 *
 * Deliberately the SAME shape the batch summary and the schedule alerts already
 * use (`Partial<Record<LighthouseCategory, number>>`), so a bar means the same
 * thing in the pipeline as it does on screen. An absent category is not a bar of
 * 0 — it is "not judged" (see decision 3).
 */
export type CiBudgets = Partial<Record<LighthouseCategory, number>>;

/** Why one page/category combination failed its budget. */
export type ViolationReason =
  /** The run scored the category, and the score is under the bar. */
  | "below"
  /** The run completed but carries no score for this category. */
  | "unscored"
  /** The run itself failed, so nothing was measured. */
  | "error";

/** One page failing one budgeted category. */
export interface BudgetViolation {
  /** The URL as requested. */
  url: string;
  /** The persisted run id — the join back to History, and to `/api/reports/:runId`. */
  runId: string;
  formFactor: FormFactor;
  category: LighthouseCategory;
  /** The measured score, or `null` when there was none to measure. */
  score: number | null;
  /** The bar it had to clear. */
  budget: number;
  reason: ViolationReason;
}

/** One audited page in the report — exactly one persisted run. */
export interface CiPage {
  runId: string;
  url: string;
  /** Final URL after redirects; `null` for a failed run. */
  finalUrl: string | null;
  formFactor: FormFactor;
  status: "done" | "error";
  /** Failure reason for `status: "error"`. UNTRUSTED — may echo page-derived text. */
  errorMessage: string | null;
  scores: CategoryScores;
  /** Present only in the expanded reporter; omitted from the compact one. */
  metrics?: CoreWebVitals | null;
  /** Budget failures attributable to this page, in `LIGHTHOUSE_CATEGORIES` order. */
  violations: BudgetViolation[];
}

/** The whole outcome of one CI invocation. */
export interface CiReport {
  /** The contract: `true` → exit 0, `false` → exit 1. Nothing else sets it. */
  ok: boolean;
  /** The batch these pages belong to, so History and the report agree. */
  batchId: string;
  /** The bars actually applied, after flag + config resolution. */
  budgets: CiBudgets;
  /** One entry per persisted run, in batch order. */
  pages: CiPage[];
  /** Every violation across every page, page order then category order. */
  violations: BudgetViolation[];
  totals: {
    /** Pages audited (persisted runs). */
    pages: number;
    /** Pages with no violations. */
    passed: number;
    /** Pages with at least one violation. */
    failed: number;
    /** Pages whose run errored (a subset of `failed` whenever budgets exist). */
    errored: number;
  };
  /** ISO timestamps bounding the run. */
  startedAt: string;
  finishedAt: string;
}

/** Output formats the `--reporter` flag accepts. */
export const CI_REPORTERS = ["json", "jsonExpanded", "csv", "html"] as const;
export type CiReporter = (typeof CI_REPORTERS)[number];

/**
 * Exit codes. Kept as named constants because they ARE the API — a pipeline
 * reads nothing else — and because 0/1 read identically at a call site whichever
 * way round they are.
 */
export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
/**
 * Reserved for "the run could not be attempted at all" — bad flags, an
 * unreadable config, no URLs. Distinct from `EXIT_FAIL` so a pipeline can tell
 * "the site regressed" from "you invoked me wrong"; conflating them is how a
 * typo in a config file reads as a performance regression.
 */
export const EXIT_USAGE = 2;
