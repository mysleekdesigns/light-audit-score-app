import { describe, expect, it } from "vitest";

import type { HistoryRow } from "@/lib/db/persistence";
import type { CategoryScores } from "@/lib/lighthouse/types";

import {
  averageScores,
  bestWorstPages,
  groupRunsByBatch,
  overallScore,
  passFail,
} from "@/lib/batch-summary/summary";

/** Build a minimal {@link HistoryRow} with sensible defaults for the fields we don't assert on. */
function makeRow(overrides: Partial<HistoryRow> & { id: string }): HistoryRow {
  return {
    id: overrides.id,
    batchId: overrides.batchId ?? "b1",
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    finalUrl: overrides.finalUrl ?? null,
    status: overrides.status ?? "done",
    errorMessage: overrides.errorMessage ?? null,
    formFactor: overrides.formFactor ?? "mobile",
    runs: overrides.runs ?? 3,
    scores: overrides.scores ?? {},
    metrics: overrides.metrics ?? null,
    hasJsonReport: overrides.hasJsonReport ?? true,
    hasHtmlReport: overrides.hasHtmlReport ?? true,
    fetchTime: overrides.fetchTime ?? null,
    createdAt: overrides.createdAt ?? "2026-05-26T00:00:00.000Z",
  };
}

const allFour = (
  performance: number | null,
  accessibility: number | null,
  bestPractices: number | null,
  seo: number | null,
): CategoryScores => ({
  performance,
  accessibility,
  "best-practices": bestPractices,
  seo,
});

describe("groupRunsByBatch", () => {
  it("groups rows by batchId preserving input order", () => {
    const rows = [
      makeRow({ id: "r1", batchId: "a" }),
      makeRow({ id: "r2", batchId: "b" }),
      makeRow({ id: "r3", batchId: "a" }),
    ];
    const groups = groupRunsByBatch(rows);
    expect([...groups.keys()]).toEqual(["a", "b"]);
    expect(groups.get("a")!.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(groups.get("b")!.map((r) => r.id)).toEqual(["r2"]);
  });

  it("returns an empty map for no rows", () => {
    expect(groupRunsByBatch([]).size).toBe(0);
  });
});

describe("averageScores", () => {
  it("averages per category across done runs", () => {
    const rows = [
      makeRow({ id: "r1", scores: allFour(80, 90, 100, 70) }),
      makeRow({ id: "r2", scores: allFour(60, 70, 80, 90) }),
    ];
    expect(averageScores(rows)).toEqual({
      performance: 70,
      accessibility: 80,
      "best-practices": 90,
      seo: 80,
    });
  });

  it("ignores null scores in the mean (denominator is non-null count)", () => {
    const rows = [
      makeRow({ id: "r1", scores: allFour(90, null, 100, 50) }),
      makeRow({ id: "r2", scores: allFour(70, 80, null, 50) }),
    ];
    const avg = averageScores(rows);
    expect(avg.performance).toBe(80); // (90 + 70) / 2
    expect(avg.accessibility).toBe(80); // only r2 contributes
    expect(avg["best-practices"]).toBe(100); // only r1 contributes
    expect(avg.seo).toBe(50);
  });

  it("excludes failed runs entirely", () => {
    const rows = [
      makeRow({ id: "r1", scores: allFour(100, 100, 100, 100) }),
      makeRow({ id: "r2", status: "error", scores: allFour(0, 0, 0, 0) }),
    ];
    expect(averageScores(rows)).toEqual({
      performance: 100,
      accessibility: 100,
      "best-practices": 100,
      seo: 100,
    });
  });

  it("omits a category with no non-null score from any done run", () => {
    const rows = [makeRow({ id: "r1", scores: allFour(90, null, null, 80) })];
    const avg = averageScores(rows);
    expect(avg).toHaveProperty("performance", 90);
    expect(avg).toHaveProperty("seo", 80);
    expect("accessibility" in avg).toBe(false);
    expect("best-practices" in avg).toBe(false);
  });

  it("returns an empty object when there are no done runs", () => {
    const rows = [makeRow({ id: "r1", status: "error" })];
    expect(averageScores(rows)).toEqual({});
  });
});

describe("overallScore", () => {
  it("means the available category scores", () => {
    expect(overallScore(allFour(80, 90, 100, 70))).toBe(85);
  });

  it("ignores nulls", () => {
    expect(overallScore(allFour(90, null, null, 70))).toBe(80);
  });

  it("returns null when no category is scored", () => {
    expect(overallScore(allFour(null, null, null, null))).toBeNull();
    expect(overallScore({})).toBeNull();
  });
});

describe("bestWorstPages", () => {
  it("selects best and worst by overall score among done runs", () => {
    const rows = [
      makeRow({ id: "mid", scores: allFour(60, 60, 60, 60) }),
      makeRow({ id: "high", scores: allFour(95, 95, 95, 95) }),
      makeRow({ id: "low", scores: allFour(20, 20, 20, 20) }),
    ];
    const { best, worst } = bestWorstPages(rows);
    expect(best?.id).toBe("high");
    expect(worst?.id).toBe("low");
  });

  it("excludes failed runs from selection", () => {
    const rows = [
      makeRow({ id: "ok", scores: allFour(40, 40, 40, 40) }),
      makeRow({ id: "fail", status: "error" }),
    ];
    const { best, worst } = bestWorstPages(rows);
    expect(best?.id).toBe("ok");
    expect(worst?.id).toBe("ok");
  });

  it("resolves ties to the first encountered run", () => {
    const rows = [
      makeRow({ id: "first", scores: allFour(80, 80, 80, 80) }),
      makeRow({ id: "second", scores: allFour(80, 80, 80, 80) }),
    ];
    const { best, worst } = bestWorstPages(rows);
    expect(best?.id).toBe("first");
    expect(worst?.id).toBe("first");
  });

  it("returns nulls when no done run has an overall score", () => {
    const rows = [
      makeRow({ id: "fail", status: "error" }),
      makeRow({ id: "unscored", scores: allFour(null, null, null, null) }),
    ];
    expect(bestWorstPages(rows)).toEqual({ best: null, worst: null });
  });

  it("returns nulls for an empty batch", () => {
    expect(bestWorstPages([])).toEqual({ best: null, worst: null });
  });
});

describe("passFail", () => {
  it("counts a page as passing when score >= threshold (boundary passes)", () => {
    const rows = [
      makeRow({ id: "exact", scores: allFour(90, 90, 90, 90) }),
      makeRow({ id: "just-under", scores: allFour(89, 89, 89, 89) }),
    ];
    const result = passFail(rows, {
      performance: 90,
      accessibility: 90,
      "best-practices": 90,
      seo: 90,
    });
    expect(result.performance).toEqual({ pass: 1, fail: 1, total: 2 });
  });

  it("applies different thresholds per category", () => {
    const rows = [makeRow({ id: "r1", scores: allFour(60, 95, 75, 85) })];
    const result = passFail(rows, {
      performance: 50, // 60 >= 50 → pass
      accessibility: 90, // 95 >= 90 → pass
      "best-practices": 80, // 75 < 80 → fail
      seo: 90, // 85 < 90 → fail
    });
    expect(result.performance.pass).toBe(1);
    expect(result.accessibility.pass).toBe(1);
    expect(result["best-practices"].fail).toBe(1);
    expect(result.seo.fail).toBe(1);
  });

  it("counts failed runs as fail across all categories, in the total", () => {
    const rows = [
      makeRow({ id: "ok", scores: allFour(95, 95, 95, 95) }),
      makeRow({ id: "fail", status: "error" }),
    ];
    const result = passFail(rows, { performance: 90 });
    expect(result.performance).toEqual({ pass: 1, fail: 1, total: 2 });
  });

  it("counts a done run missing a category's score as fail for that category", () => {
    const rows = [makeRow({ id: "r1", scores: allFour(95, null, 95, 95) })];
    const result = passFail(rows, {
      performance: 90,
      accessibility: 90,
      "best-practices": 90,
      seo: 90,
    });
    expect(result.performance).toEqual({ pass: 1, fail: 0, total: 1 });
    expect(result.accessibility).toEqual({ pass: 0, fail: 1, total: 1 });
  });

  it("falls back to the 90 threshold when a category has none configured", () => {
    const rows = [
      makeRow({ id: "high", scores: allFour(91, 91, 91, 91) }),
      makeRow({ id: "low", scores: allFour(89, 89, 89, 89) }),
    ];
    const result = passFail(rows, {}); // no thresholds → 90 everywhere
    expect(result.seo).toEqual({ pass: 1, fail: 1, total: 2 });
  });
});
