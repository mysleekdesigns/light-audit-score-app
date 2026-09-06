import { describe, expect, it } from "vitest";

import { BudgetError, evaluateBudgets, resolveBudgets } from "@/lib/ci/budgets";
import type { CiBudgets } from "@/lib/ci/types";
import type { HistoryRow } from "@/lib/db/persistence";
import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
} from "@/lib/lighthouse/types";

/** Build a minimal {@link HistoryRow}, defaulting everything we don't assert on. */
function makeRow(overrides: Partial<HistoryRow> & { id: string }): HistoryRow {
  return {
    id: overrides.id,
    batchId: overrides.batchId ?? "b1",
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    finalUrl: overrides.finalUrl ?? null,
    status: overrides.status ?? "done",
    errorMessage: overrides.errorMessage ?? null,
    formFactor: overrides.formFactor ?? "mobile",
    source: overrides.source ?? "local",
    runs: overrides.runs ?? 3,
    options: overrides.options ?? {
      formFactor: "mobile",
      throttling: "simulated",
      categories: ["performance", "accessibility", "best-practices", "seo"],
      runs: 3,
      warmCache: true,
    },
    scores: overrides.scores ?? {},
    metrics: overrides.metrics ?? null,
    field: overrides.field ?? null,
    environment: overrides.environment ?? null,
    hasJsonReport: overrides.hasJsonReport ?? true,
    hasHtmlReport: overrides.hasHtmlReport ?? true,
    fetchTime: overrides.fetchTime ?? null,
    createdAt: overrides.createdAt ?? "2026-09-06T00:00:00.000Z",
  };
}

/** All five categories at one value, for "every category was judged" assertions. */
const allFive = (score: number | null): CategoryScores => ({
  performance: score,
  accessibility: score,
  "best-practices": score,
  seo: score,
  "agentic-browsing": score,
});

/** Compact view of a violation for order/identity assertions. */
function shape(violation: {
  url: string;
  category: string;
  score: number | null;
  budget: number;
  reason: string;
}) {
  return {
    url: violation.url,
    category: violation.category,
    score: violation.score,
    budget: violation.budget,
    reason: violation.reason,
  };
}

/** The message of the {@link BudgetError} `run` throws (fails the test if it doesn't). */
function budgetErrorMessage(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(BudgetError);
    return (err as BudgetError).message;
  }
  throw new Error("expected a BudgetError, but nothing was thrown");
}

describe("resolveBudgets — flag only", () => {
  it("applies one bar to every category", () => {
    expect(resolveBudgets({ flag: "90" })).toEqual({
      performance: 90,
      accessibility: 90,
      "best-practices": 90,
      seo: 90,
      "agentic-browsing": 90,
    });
  });

  it("covers every category in LIGHTHOUSE_CATEGORIES, not a hard-coded five", () => {
    const budgets = resolveBudgets({ flag: "75" });
    expect(Object.keys(budgets)).toEqual([...LIGHTHOUSE_CATEGORIES]);
  });

  it("accepts the boundary values 0 and 100, and a decimal", () => {
    expect(resolveBudgets({ flag: "0" }).performance).toBe(0);
    expect(resolveBudgets({ flag: "100" }).performance).toBe(100);
    expect(resolveBudgets({ flag: "89.5" }).performance).toBe(89.5);
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveBudgets({ flag: " 90 " }).seo).toBe(90);
  });
});

describe("resolveBudgets — config only", () => {
  it("reads a bare category map", () => {
    expect(resolveBudgets({ config: { performance: 70, seo: 95 } })).toEqual({
      performance: 70,
      seo: 95,
    });
  });

  it("reads a nested `budgets` key, ignoring the config's other settings", () => {
    expect(
      resolveBudgets({
        config: {
          urls: ["https://example.com"],
          concurrency: 2,
          budgets: { performance: 70 },
        },
      }),
    ).toEqual({ performance: 70 });
  });

  it("treats an empty config as no budgets at all", () => {
    expect(resolveBudgets({ config: {} })).toEqual({});
    expect(resolveBudgets({ config: { budgets: {} } })).toEqual({});
  });

  it("returns {} when neither a flag nor a config is given", () => {
    expect(resolveBudgets({})).toEqual({});
  });

  it("emits keys in LIGHTHOUSE_CATEGORIES order, not config-writing order", () => {
    const written = resolveBudgets({
      config: { seo: 80, performance: 90, "agentic-browsing": 40 },
    });
    const reversed = resolveBudgets({
      config: { "agentic-browsing": 40, performance: 90, seo: 80 },
    });
    expect(Object.keys(written)).toEqual([
      "performance",
      "seo",
      "agentic-browsing",
    ]);
    expect(JSON.stringify(written)).toBe(JSON.stringify(reversed));
  });
});

describe("resolveBudgets — flag and config together", () => {
  it("uses the flag as the floor and lets the config override per category", () => {
    expect(
      resolveBudgets({ flag: "90", config: { performance: 70 } }),
    ).toEqual({
      performance: 70,
      accessibility: 90,
      "best-practices": 90,
      seo: 90,
      "agentic-browsing": 90,
    });
  });

  it("keeps the flag's bar for categories the config does not mention", () => {
    const budgets = resolveBudgets({
      flag: "80",
      config: { budgets: { "agentic-browsing": 30 } },
    });
    expect(budgets["agentic-browsing"]).toBe(30);
    expect(budgets.performance).toBe(80);
    expect(budgets.seo).toBe(80);
  });

  it("lets the config raise a bar as well as lower it", () => {
    expect(resolveBudgets({ flag: "50", config: { seo: 100 } }).seo).toBe(100);
  });
});

describe("resolveBudgets — flag validation", () => {
  it("rejects a non-numeric flag, naming the value and the range", () => {
    expect(budgetErrorMessage(() => resolveBudgets({ flag: "high" }))).toBe(
      '--budget must be a number from 0 to 100 (got "high").',
    );
  });

  it("rejects an empty flag", () => {
    expect(budgetErrorMessage(() => resolveBudgets({ flag: "" }))).toBe(
      '--budget must be a number from 0 to 100 (got "").',
    );
  });

  it("rejects a trailing-garbage flag rather than parsing a prefix", () => {
    expect(budgetErrorMessage(() => resolveBudgets({ flag: "90abc" }))).toBe(
      '--budget must be a number from 0 to 100 (got "90abc").',
    );
  });

  it("rejects hex and exponent spellings that Number() would silently accept", () => {
    expect(budgetErrorMessage(() => resolveBudgets({ flag: "0x5a" }))).toBe(
      '--budget must be a number from 0 to 100 (got "0x5a").',
    );
    expect(budgetErrorMessage(() => resolveBudgets({ flag: "1e2" }))).toBe(
      '--budget must be a number from 0 to 100 (got "1e2").',
    );
  });

  it("rejects a flag above 100", () => {
    expect(budgetErrorMessage(() => resolveBudgets({ flag: "120" }))).toBe(
      "--budget must be a number from 0 to 100 (got 120).",
    );
  });

  it("rejects a negative flag", () => {
    expect(budgetErrorMessage(() => resolveBudgets({ flag: "-1" }))).toBe(
      "--budget must be a number from 0 to 100 (got -1).",
    );
  });

  it("rejects Infinity", () => {
    expect(budgetErrorMessage(() => resolveBudgets({ flag: "Infinity" }))).toBe(
      '--budget must be a number from 0 to 100 (got "Infinity").',
    );
  });

  it("truncates an absurdly long value instead of dumping it into the log", () => {
    const message = budgetErrorMessage(() =>
      resolveBudgets({ flag: "n".repeat(500) }),
    );
    expect(message.length).toBeLessThan(120);
    expect(message).toContain("…");
  });
});

describe("resolveBudgets — config validation", () => {
  it("rejects a config that is not an object", () => {
    expect(budgetErrorMessage(() => resolveBudgets({ config: null }))).toBe(
      'Budget config must be an object mapping categories to numbers, or an object with a "budgets" key (got null).',
    );
    expect(budgetErrorMessage(() => resolveBudgets({ config: [90] }))).toBe(
      'Budget config must be an object mapping categories to numbers, or an object with a "budgets" key (got an array).',
    );
    expect(budgetErrorMessage(() => resolveBudgets({ config: "90" }))).toBe(
      'Budget config must be an object mapping categories to numbers, or an object with a "budgets" key (got "90").',
    );
  });

  it("rejects a `budgets` key that is not an object", () => {
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { budgets: 90 } })),
    ).toBe(
      'Budget config "budgets" must be an object mapping categories to numbers (got 90).',
    );
  });

  it("rejects an unknown category, naming it and every valid key", () => {
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { perfomance: 90 } })),
    ).toBe(
      'Unknown budget category "perfomance". Valid categories: performance, accessibility, best-practices, seo, agentic-browsing.',
    );
  });

  it("rejects an unknown category inside a nested `budgets` block too", () => {
    expect(
      budgetErrorMessage(() =>
        resolveBudgets({ config: { budgets: { pwa: 90 } } }),
      ),
    ).toContain('Unknown budget category "pwa".');
  });

  it("rejects a numeric string, which is exactly the mistake worth reporting", () => {
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { seo: "90" } })),
    ).toBe('Budget for "seo" must be a number from 0 to 100 (got "90").');
  });

  it("rejects null, booleans and nested objects as budget values", () => {
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { seo: null } })),
    ).toBe('Budget for "seo" must be a number from 0 to 100 (got null).');
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { seo: true } })),
    ).toBe('Budget for "seo" must be a number from 0 to 100 (got true).');
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { seo: { min: 90 } } })),
    ).toBe('Budget for "seo" must be a number from 0 to 100 (got an object).');
  });

  it("rejects an out-of-range or non-finite number", () => {
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { seo: 101 } })),
    ).toBe('Budget for "seo" must be a number from 0 to 100 (got 101).');
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { seo: -5 } })),
    ).toBe('Budget for "seo" must be a number from 0 to 100 (got -5).');
    expect(
      budgetErrorMessage(() => resolveBudgets({ config: { seo: NaN } })),
    ).toBe('Budget for "seo" must be a number from 0 to 100 (got NaN).');
  });

  it("throws BudgetError, which the CLI maps to EXIT_USAGE", () => {
    expect(() => resolveBudgets({ config: { nope: 1 } })).toThrow(BudgetError);
    expect(() => resolveBudgets({ config: { nope: 1 } })).toThrow(Error);
  });
});

describe("evaluateBudgets — the pass/fail rule", () => {
  const budgets: CiBudgets = { performance: 90, seo: 80 };

  it("passes a page that clears every budgeted category", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r1", scores: { performance: 95, seo: 85 } })],
      budgets,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.pages[0].violations).toEqual([]);
  });

  it("passes a score exactly equal to the budget (matching rowClearsThresholds)", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r1", scores: { performance: 90, seo: 80 } })],
      budgets,
    );
    expect(result.ok).toBe(true);
  });

  it("fails a score one point under the budget, with reason `below`", () => {
    const result = evaluateBudgets(
      [
        makeRow({
          id: "r1",
          url: "https://a.example",
          scores: { performance: 89, seo: 85 },
        }),
      ],
      budgets,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map(shape)).toEqual([
      {
        url: "https://a.example",
        category: "performance",
        score: 89,
        budget: 90,
        reason: "below",
      },
    ]);
  });

  it("carries the runId so a violation joins back to History", () => {
    const result = evaluateBudgets(
      [
        makeRow({
          id: "run-42",
          formFactor: "desktop",
          scores: { performance: 10 },
        }),
      ],
      { performance: 90 },
    );
    expect(result.violations[0].runId).toBe("run-42");
    expect(result.violations[0].formFactor).toBe("desktop");
  });

  it("never fails a category with no budget", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r1", scores: allFive(1) })],
      { seo: 0 },
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("evaluateBudgets — a page that could not be measured FAILS", () => {
  it("fails every budgeted category for an errored run, with reason `error`", () => {
    const budgets = resolveBudgets({ flag: "90" });
    const result = evaluateBudgets(
      [
        makeRow({
          id: "r1",
          url: "https://down.example",
          status: "error",
          errorMessage: "NO_FCP",
          scores: {},
        }),
      ],
      budgets,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(LIGHTHOUSE_CATEGORIES.length);
    expect(result.violations.map((v) => v.category)).toEqual([
      ...LIGHTHOUSE_CATEGORIES,
    ]);
    expect(result.violations.every((v) => v.reason === "error")).toBe(true);
    expect(result.violations.every((v) => v.score === null)).toBe(true);
  });

  it("fails only the BUDGETED categories of an errored run", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r1", status: "error" })],
      { seo: 50 },
    );
    expect(result.violations.map((v) => v.category)).toEqual(["seo"]);
  });

  it("reports `error` (not `unscored`) even when an errored row carries scores", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r1", status: "error", scores: { performance: 99 } })],
      { performance: 90 },
    );
    expect(result.violations.map(shape)[0]).toMatchObject({
      reason: "error",
      score: null,
    });
  });

  it("fails a done run missing a budgeted category's score, with reason `unscored`", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r1", scores: { performance: 95 } })],
      { performance: 90, seo: 80 },
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map(shape)).toEqual([
      {
        url: "https://example.com/r1",
        category: "seo",
        score: null,
        budget: 80,
        reason: "unscored",
      },
    ]);
  });

  it("treats an explicit null, and a corrupted NaN, as unscored rather than zero", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r1", scores: { performance: null, seo: NaN } })],
      { performance: 90, seo: 80 },
    );
    expect(result.violations.map((v) => v.reason)).toEqual([
      "unscored",
      "unscored",
    ]);
    expect(result.violations.every((v) => v.score === null)).toBe(true);
  });
});

describe("evaluateBudgets — no budgets is a report, not a gate", () => {
  it("still fails when a run errored, even with no budgets to miss", () => {
    // No budgets means no SCORE can fail the build — but a page that never ran
    // is not a page that cleared every bar. `ok` covers both, because it is the
    // single source of the exit code: reporting `ok: true` here while the CLI
    // exited 1 (which it has always done for a failed audit) would make a
    // pipeline parsing this JSON read green for a red build.
    const result = evaluateBudgets(
      [
        makeRow({ id: "r1", scores: allFive(1) }),
        makeRow({ id: "r2", status: "error", errorMessage: "boom" }),
      ],
      {},
    );
    expect(result.ok).toBe(false);
    // Nothing was JUDGED — there are no budgets — so there are no violations.
    // The failure is the error itself, which `totals` carries.
    expect(result.violations).toEqual([]);
    expect(result.totals).toEqual({
      pages: 2,
      passed: 1,
      failed: 1,
      errored: 1,
    });
  });

  it("is a report, not a gate, for SCORES when no budgets are set", () => {
    // The other half of the rule above: with no budgets, a page scoring 1/100
    // across the board still passes, because nothing asked it to clear a bar.
    const result = evaluateBudgets([makeRow({ id: "r1", scores: allFive(0.01) })], {});
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.totals).toEqual({ pages: 1, passed: 1, failed: 0, errored: 0 });
  });

  it("returns ok and empty totals for no rows at all", () => {
    const result = evaluateBudgets([], { performance: 90 });
    expect(result.ok).toBe(true);
    expect(result.pages).toEqual([]);
    expect(result.totals).toEqual({
      pages: 0,
      passed: 0,
      failed: 0,
      errored: 0,
    });
  });
});

describe("evaluateBudgets — totals", () => {
  it("counts pages, passes, failures and errors", () => {
    const result = evaluateBudgets(
      [
        makeRow({ id: "pass", scores: { performance: 95, seo: 90 } }),
        makeRow({ id: "below", scores: { performance: 10, seo: 90 } }),
        makeRow({ id: "unscored", scores: { performance: 95 } }),
        makeRow({ id: "errored", status: "error" }),
      ],
      { performance: 90, seo: 80 },
    );
    expect(result.totals).toEqual({
      pages: 4,
      passed: 1,
      failed: 3,
      errored: 1,
    });
    // passed + failed always accounts for every page.
    expect(result.totals.passed + result.totals.failed).toBe(
      result.totals.pages,
    );
  });

  it("counts a page once however many categories it misses", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r1", scores: allFive(1) })],
      resolveBudgets({ flag: "90" }),
    );
    expect(result.violations).toHaveLength(LIGHTHOUSE_CATEGORIES.length);
    expect(result.totals.failed).toBe(1);
  });
});

describe("evaluateBudgets — deterministic ordering", () => {
  it("orders violations by page, then by LIGHTHOUSE_CATEGORIES order", () => {
    const result = evaluateBudgets(
      [
        makeRow({ id: "r1", url: "https://a.example", scores: allFive(10) }),
        makeRow({ id: "r2", url: "https://b.example", scores: allFive(10) }),
      ],
      resolveBudgets({ flag: "90" }),
    );
    expect(result.violations.map((v) => `${v.url} ${v.category}`)).toEqual([
      ...LIGHTHOUSE_CATEGORIES.map((c) => `https://a.example ${c}`),
      ...LIGHTHOUSE_CATEGORIES.map((c) => `https://b.example ${c}`),
    ]);
  });

  it("is byte-stable across two configs that spell the same bars in a different order", () => {
    const rows = [
      makeRow({ id: "r1", url: "https://a.example", scores: allFive(50) }),
      makeRow({ id: "r2", url: "https://b.example", status: "error" }),
    ];
    const one = evaluateBudgets(
      rows,
      resolveBudgets({ config: { seo: 90, performance: 80 } }),
    );
    const two = evaluateBudgets(
      rows,
      resolveBudgets({ config: { performance: 80, seo: 90 } }),
    );
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it("keeps pages in the order the rows arrived (batch order)", () => {
    const result = evaluateBudgets(
      [makeRow({ id: "r3" }), makeRow({ id: "r1" }), makeRow({ id: "r2" })],
      {},
    );
    expect(result.pages.map((p) => p.runId)).toEqual(["r3", "r1", "r2"]);
  });

  it("hands each page its own violations, matching the flat list", () => {
    const result = evaluateBudgets(
      [
        makeRow({ id: "r1", scores: { performance: 10 } }),
        makeRow({ id: "r2", scores: { performance: 95 } }),
      ],
      { performance: 90 },
    );
    expect(result.pages[0].violations).toHaveLength(1);
    expect(result.pages[1].violations).toEqual([]);
    expect(result.violations).toEqual(result.pages[0].violations);
  });
});

describe("evaluateBudgets — the page projection", () => {
  it("carries the row's identity, status and scores through", () => {
    const row = makeRow({
      id: "r1",
      url: "https://a.example",
      finalUrl: "https://a.example/home",
      status: "error",
      errorMessage: "ERRORED_DOCUMENT_REQUEST",
      formFactor: "desktop",
      scores: { performance: 42 },
    });
    const [page] = evaluateBudgets([row], {}).pages;
    expect(page).toMatchObject({
      runId: "r1",
      url: "https://a.example",
      finalUrl: "https://a.example/home",
      status: "error",
      errorMessage: "ERRORED_DOCUMENT_REQUEST",
      formFactor: "desktop",
      scores: { performance: 42 },
    });
  });

  it("copies the scores rather than aliasing the caller's row", () => {
    const row = makeRow({ id: "r1", scores: { performance: 95 } });
    const [page] = evaluateBudgets([row], {}).pages;
    row.scores.performance = 1;
    expect(page.scores.performance).toBe(95);
  });
});
