/**
 * Budget resolution and evaluation for `lightaudit-ci` (ROADMAP Phase F).
 *
 * The whole gate lives here: turn `--budget 90` and/or a config file into a
 * validated {@link CiBudgets}, then judge persisted runs against it and say
 * whether the build may go green. Everything is **pure** — no `node:fs`, no
 * SQLite, no Lighthouse import. The CLI reads the config file and hands the
 * parsed value over; this module decides what it means. That split is what lets
 * every rule below be exercised with plain literals in a unit test, with no
 * Chrome and no database, which matters because these rules are the only thing
 * standing between a pipeline and a false green.
 *
 * ## Precedence: the flag is the floor, the config is the exception list
 *
 * `--budget 90` sets EVERY category's bar; a config file then overrides
 * individual categories on top. So `--budget 90` plus `{"performance": 70}`
 * reads exactly as written: "90 everywhere, except performance only has to
 * reach 70". The usual CLI convention (an explicit flag beats a config file)
 * would make the pair useless — the blanket flag would flatten every
 * per-category line the user bothered to write — so it is deliberately inverted
 * here: the general bar first, the specific exceptions second. Neither is
 * required; with neither, budgets are `{}` and nothing can fail.
 *
 * ## A page that could not be measured FAILS
 *
 * This is decision 2 of {@link file://./types.ts} and the **opposite** of the
 * rule in `src/lib/alerts/compare.ts`, where a missing score is silence. Do not
 * "fix" one to match the other: an alert that fires on every flaky night gets
 * muted, while a build that passes because the audit crashed is worse than
 * useless. Both rules refuse to guess; they just fail in opposite directions,
 * and each is right for its own consumer. So an errored run violates every
 * budgeted category (`reason: "error"`), and a done run with no score for a
 * budgeted category violates that one (`reason: "unscored"`).
 *
 * ## Only budgeted categories are judged
 *
 * A category with no bar is reported and never fails the build (decision 3), and
 * the category list always comes from `LIGHTHOUSE_CATEGORIES` rather than a
 * hard-coded five — Lighthouse 13.3 added `agentic-browsing`, and both
 * `rowClearsThresholds` and this file would otherwise carry that scar.
 */

import type {
  BudgetViolation,
  CiBudgets,
  CiPage,
  CiReport,
} from "@/lib/ci/types";
import type { HistoryRow } from "@/lib/db/persistence";
import {
  LIGHTHOUSE_CATEGORIES,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";

/**
 * Bad input a user can fix: an unparseable `--budget`, an out-of-range bar, a
 * misspelt category. Separate from any other failure because the CLI maps it to
 * `EXIT_USAGE` (2) rather than `EXIT_FAIL` (1) — "you invoked me wrong" must not
 * read as "the site regressed".
 *
 * Messages are printed verbatim into a CI log where nothing else is visible, so
 * every one of them names the offending value AND what would have been accepted.
 */
export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

/** Lowest and highest bar a budget may express — a Lighthouse score is 0–100. */
const MIN_BUDGET = 0;
const MAX_BUDGET = 100;

/** The valid category keys, spelled out for error messages. */
const CATEGORY_LIST = LIGHTHOUSE_CATEGORIES.join(", ");

/** The wrapper key a config file may nest its budgets under. */
const BUDGETS_KEY = "budgets";

const CATEGORY_SET = new Set<string>(LIGHTHOUSE_CATEGORIES);

/** Longest untrusted value we will echo back into a log line. */
const MAX_ECHO = 40;

/**
 * Render an arbitrary value for an error message: short, unambiguous, and safe
 * to paste into a CI log. Config content is user-supplied, so strings are
 * quoted (a bare `90` and a `"90"` must not read alike — the second is exactly
 * the mistake being reported) and truncated rather than dumped whole.
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string": {
      const text =
        value.length > MAX_ECHO ? `${value.slice(0, MAX_ECHO)}…` : value;
      return JSON.stringify(text);
    }
    case "number":
      return Number.isNaN(value) ? "NaN" : String(value);
    case "boolean":
      return String(value);
    case "object":
      return "an object";
    default:
      return `a ${typeof value}`;
  }
}

/** A plain, non-array object — the only config shape worth reading. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A decimal number and nothing else.
 *
 * `Number("")` is 0, `Number("0x5a")` is 90 and `Number("1e9")` is a finite
 * nine-figure "score": all three would let a typo become a bar nobody intended,
 * so the flag has to look like a number a human would write.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * A budget value that is in range, or a {@link BudgetError} naming what was
 * wrong. `label` is the user's word for the thing (`--budget`, or a category
 * key) so one check can serve both entry points without blurring the message.
 */
function requireBudgetNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < MIN_BUDGET || value > MAX_BUDGET) {
    throw new BudgetError(
      `${label} must be a number from ${MIN_BUDGET} to ${MAX_BUDGET} (got ${describeValue(value)}).`,
    );
  }
  return value;
}

/** Parse the raw `--budget` string into a validated bar. */
function parseFlag(flag: string): number {
  const trimmed = flag.trim();
  if (trimmed === "" || !DECIMAL.test(trimmed)) {
    throw new BudgetError(
      `--budget must be a number from ${MIN_BUDGET} to ${MAX_BUDGET} (got ${describeValue(flag)}).`,
    );
  }
  return requireBudgetNumber(Number(trimmed), "--budget");
}

/**
 * Pull the budget map out of a parsed config file.
 *
 * Two shapes are accepted, because both are things a user will reasonably
 * write: `{"budgets": {"seo": 90}}` (a config file that also carries other CLI
 * settings) and a bare `{"seo": 90}` (a file that is nothing but budgets). The
 * wrapper wins when present, so unrelated top-level keys in a fuller config are
 * not mistaken for misspelt categories.
 */
function budgetMapFromConfig(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    throw new BudgetError(
      `Budget config must be an object mapping categories to numbers, or an object with a "${BUDGETS_KEY}" key (got ${describeValue(config)}).`,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(config, BUDGETS_KEY)) {
    return config;
  }

  const nested = config[BUDGETS_KEY];
  if (!isPlainObject(nested)) {
    throw new BudgetError(
      `Budget config "${BUDGETS_KEY}" must be an object mapping categories to numbers (got ${describeValue(nested)}).`,
    );
  }
  return nested;
}

/**
 * Resolve the bars to judge against from the CLI flag and/or a parsed config
 * file. Throws {@link BudgetError} for anything a user can fix.
 *
 * The flag applies to every category and the config overrides per category (see
 * the module docblock for why round that way). Validation is strict on purpose:
 * an unknown key is an ERROR rather than a silent skip, because a typo'd
 * `"perfomance": 90` that quietly judged nothing would make a build pass for a
 * reason nobody could ever see.
 *
 * The returned object's keys are always in `LIGHTHOUSE_CATEGORIES` order, never
 * in config-writing order, so a report serialised from it is byte-stable across
 * runs and across two configs that spell the same bars in a different sequence.
 */
export function resolveBudgets(input: {
  /** The `--budget <n>` value, as the raw string the CLI saw. Optional. */
  flag?: string;
  /** The parsed contents of a config file (unknown shape — validate it). Optional. */
  config?: unknown;
}): CiBudgets {
  const resolved = new Map<LighthouseCategory, number>();

  if (input.flag !== undefined) {
    const bar = parseFlag(input.flag);
    for (const category of LIGHTHOUSE_CATEGORIES) resolved.set(category, bar);
  }

  if (input.config !== undefined) {
    const map = budgetMapFromConfig(input.config);
    for (const [key, value] of Object.entries(map)) {
      if (!CATEGORY_SET.has(key)) {
        throw new BudgetError(
          `Unknown budget category ${describeValue(key)}. Valid categories: ${CATEGORY_LIST}.`,
        );
      }
      if (typeof value !== "number") {
        throw new BudgetError(
          `Budget for "${key}" must be a number from ${MIN_BUDGET} to ${MAX_BUDGET} (got ${describeValue(value)}).`,
        );
      }
      resolved.set(
        key as LighthouseCategory,
        requireBudgetNumber(value, `Budget for "${key}"`),
      );
    }
  }

  // Rebuilt in canonical order rather than insertion order: the report carries
  // this object, and CI diffs its own logs.
  const budgets: CiBudgets = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const bar = resolved.get(category);
    if (bar !== undefined) budgets[category] = bar;
  }
  return budgets;
}

/**
 * A score this module is willing to compare, or `null`.
 *
 * `CategoryScores` can carry an absent key (the category wasn't run), an
 * explicit `null` (it ran and produced nothing) or a `NaN`/`Infinity` from a
 * corrupted row. All of them mean *no data* — and none of them means zero, which
 * is why they become an `unscored` violation rather than a `below` one with a
 * fabricated score of 0.
 */
function usableScore(
  page: HistoryRow,
  category: LighthouseCategory,
): number | null {
  const value = page.scores[category];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Every budgeted category this run misses, in `LIGHTHOUSE_CATEGORIES` order.
 * Iterating the canonical category list (never `Object.keys(budgets)`) is what
 * makes the order a property of the engine rather than of however the config
 * happened to be written.
 */
function violationsFor(row: HistoryRow, budgets: CiBudgets): BudgetViolation[] {
  const violations: BudgetViolation[] = [];

  for (const category of LIGHTHOUSE_CATEGORIES) {
    const budget = budgets[category];
    if (budget === undefined) continue;

    const base = {
      url: row.url,
      runId: row.id,
      formFactor: row.formFactor,
      category,
      budget,
    };

    // The run itself failed: nothing was measured, so nothing cleared the bar.
    if (row.status === "error") {
      violations.push({ ...base, score: null, reason: "error" });
      continue;
    }

    const score = usableScore(row, category);
    if (score === null) {
      violations.push({ ...base, score: null, reason: "unscored" });
      continue;
    }

    // `>=` — the boundary value passes, matching `rowClearsThresholds`.
    if (score < budget) {
      violations.push({ ...base, score, reason: "below" });
    }
  }

  return violations;
}

/**
 * Judge persisted runs against budgets. Pure; no DB, no I/O.
 *
 * `rows` arrive in batch order and stay in it, so `pages` and the flattened
 * `violations` list are both deterministic: page order first, then
 * `LIGHTHOUSE_CATEGORIES` order within a page.
 *
 * `ok` is "no violations AND nothing errored", and it is the SINGLE source of
 * the exit code — `types.ts` says so, and the CLI must not add a second rule on
 * top of it.
 *
 * The `errored` half is what stops `ok` and the exit code disagreeing. With
 * `budgets = {}` there is nothing to judge, so an errored page produces no
 * violation; but the CLI has always exited non-zero when an audit failed to
 * run, and that is right — a build must not go green because Chrome fell over.
 * Reporting `ok: true` there would have made a JSON consumer read green while
 * the process exited 1, which is worse than either answer alone. It also stops
 * an errored page being counted in `passed`: it passed nothing.
 *
 * So a no-budget invocation is still a report rather than a gate for SCORES —
 * no score can fail it — while a page that could not be measured fails it
 * regardless, which is decision 2 in `types.ts` applied without an exception.
 */
export function evaluateBudgets(
  rows: HistoryRow[],
  budgets: CiBudgets,
): {
  pages: CiPage[];
  violations: BudgetViolation[];
  totals: CiReport["totals"];
  ok: boolean;
} {
  const pages: CiPage[] = [];
  const violations: BudgetViolation[] = [];
  let passed = 0;
  let failed = 0;
  let errored = 0;

  for (const row of rows) {
    const pageViolations = violationsFor(row, budgets);

    pages.push({
      runId: row.id,
      url: row.url,
      finalUrl: row.finalUrl,
      formFactor: row.formFactor,
      status: row.status,
      errorMessage: row.errorMessage,
      // Copied, not aliased: the report must not change under a caller that
      // keeps mutating the rows it read.
      scores: { ...row.scores },
      metrics: row.metrics,
      violations: pageViolations,
    });

    violations.push(...pageViolations);
    // An errored page is a failure whether or not a budget caught it: with no
    // budgets it has no violations, and counting it as `passed` would report a
    // page that measured nothing as one that cleared every bar.
    const pageFailed = pageViolations.length > 0 || row.status === "error";
    if (pageFailed) failed += 1;
    else passed += 1;
    if (row.status === "error") errored += 1;
  }

  return {
    pages,
    violations,
    totals: { pages: pages.length, passed, failed, errored },
    ok: violations.length === 0 && errored === 0,
  };
}
