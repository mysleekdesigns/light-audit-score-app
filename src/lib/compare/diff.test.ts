import { describe, expect, it } from "vitest";

import type { HistoryRow } from "@/lib/db/persistence";
import type {
  CategoryScores,
  CoreWebVitals,
  MetricValue,
} from "@/lib/lighthouse/types";

import {
  buildScoreTrend,
  diffMetrics,
  diffScores,
  groupRunsByUrl,
  runTime,
} from "./diff";

/** Build a HistoryRow with sensible defaults, overridable per-test. */
function makeRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: "run-1",
    batchId: "batch-1",
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: "done",
    errorMessage: null,
    formFactor: "mobile",
    runs: 3,
    scores: {
      performance: 80,
      accessibility: 90,
      "best-practices": 75,
      seo: 100,
    },
    metrics: null,
    environment: null,
    hasJsonReport: true,
    hasHtmlReport: true,
    fetchTime: "2026-05-01T10:00:00.000Z",
    createdAt: "2026-05-01T10:00:05.000Z",
    ...overrides,
  };
}

/** Build a MetricValue. */
function mv(numericValue: number | null, displayValue = ""): MetricValue {
  return { numericValue, displayValue, score: numericValue === null ? null : 0.5 };
}

describe("runTime", () => {
  it("prefers fetchTime over createdAt", () => {
    const row = makeRow({
      fetchTime: "2026-05-01T10:00:00.000Z",
      createdAt: "2026-05-02T00:00:00.000Z",
    });
    expect(runTime(row)).toBe("2026-05-01T10:00:00.000Z");
  });

  it("falls back to createdAt when fetchTime is null", () => {
    const row = makeRow({ fetchTime: null, createdAt: "2026-05-02T00:00:00.000Z" });
    expect(runTime(row)).toBe("2026-05-02T00:00:00.000Z");
  });
});

describe("groupRunsByUrl", () => {
  it("excludes failed (error) runs", () => {
    const rows = [
      makeRow({ id: "a", url: "https://a.com/", status: "done" }),
      makeRow({ id: "b", url: "https://a.com/", status: "error", scores: {} }),
    ];
    const groups = groupRunsByUrl(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].url).toBe("https://a.com/");
    expect(groups[0].runs.map((r) => r.id)).toEqual(["a"]);
  });

  it("groups by url and sorts each group ascending by time", () => {
    const rows = [
      makeRow({ id: "a2", url: "https://a.com/", fetchTime: "2026-05-03T00:00:00.000Z" }),
      makeRow({ id: "a1", url: "https://a.com/", fetchTime: "2026-05-01T00:00:00.000Z" }),
      makeRow({ id: "b1", url: "https://b.com/", fetchTime: "2026-05-02T00:00:00.000Z" }),
      makeRow({ id: "a3", url: "https://a.com/", fetchTime: "2026-05-02T00:00:00.000Z" }),
    ];
    const groups = groupRunsByUrl(rows);
    const a = groups.find((g) => g.url === "https://a.com/");
    expect(a?.runs.map((r) => r.id)).toEqual(["a1", "a3", "a2"]);
  });

  it("orders groups by descending run count, then alphabetically", () => {
    const rows = [
      makeRow({ id: "a1", url: "https://a.com/" }),
      makeRow({ id: "b1", url: "https://b.com/" }),
      makeRow({ id: "b2", url: "https://b.com/" }),
      makeRow({ id: "c1", url: "https://c.com/" }),
      makeRow({ id: "c2", url: "https://c.com/" }),
    ];
    const groups = groupRunsByUrl(rows);
    // b and c both have 2 runs (b before c alphabetically), then a with 1.
    expect(groups.map((g) => g.url)).toEqual([
      "https://b.com/",
      "https://c.com/",
      "https://a.com/",
    ]);
  });

  it("falls back to createdAt for ordering when fetchTime is null", () => {
    const rows = [
      makeRow({ id: "late", url: "https://x.com/", fetchTime: null, createdAt: "2026-05-05T00:00:00.000Z" }),
      makeRow({ id: "early", url: "https://x.com/", fetchTime: null, createdAt: "2026-05-01T00:00:00.000Z" }),
    ];
    const [group] = groupRunsByUrl(rows);
    expect(group.runs.map((r) => r.id)).toEqual(["early", "late"]);
  });
});

describe("diffScores", () => {
  const baseline: CategoryScores = {
    performance: 50,
    accessibility: 90,
    "best-practices": 80,
    seo: 70,
  };
  const comparison: CategoryScores = {
    performance: 75, // improved (+25)
    accessibility: 90, // flat
    "best-practices": 60, // regressed (−20)
    seo: undefined, // missing on comparison side
  };

  it("returns one diff per category in canonical order", () => {
    const diffs = diffScores(baseline, comparison);
    expect(diffs.map((d) => d.category)).toEqual([
      "performance",
      "accessibility",
      "best-practices",
      "seo",
    ]);
  });

  it("marks higher scores as improvements (up)", () => {
    const perf = diffScores(baseline, comparison).find((d) => d.category === "performance");
    expect(perf).toMatchObject({ baseline: 50, comparison: 75, delta: 25, direction: "up" });
  });

  it("marks lower scores as regressions (down)", () => {
    const bp = diffScores(baseline, comparison).find((d) => d.category === "best-practices");
    expect(bp).toMatchObject({ delta: -20, direction: "down" });
  });

  it("marks unchanged scores as flat with delta 0", () => {
    const a11y = diffScores(baseline, comparison).find((d) => d.category === "accessibility");
    expect(a11y).toMatchObject({ delta: 0, direction: "flat" });
  });

  it("yields none/null when a side is missing", () => {
    const seo = diffScores(baseline, comparison).find((d) => d.category === "seo");
    expect(seo).toMatchObject({ baseline: 70, comparison: null, delta: null, direction: "none" });
  });
});

describe("diffMetrics", () => {
  const baseline: CoreWebVitals = {
    "largest-contentful-paint": mv(2500, "2.5 s"),
    "cumulative-layout-shift": mv(0.1, "0.1"),
    "total-blocking-time": mv(300, "300 ms"),
    "first-contentful-paint": mv(1000, "1.0 s"),
    "speed-index": mv(3000, "3.0 s"),
    interactive: null,
  };
  const comparison: CoreWebVitals = {
    "largest-contentful-paint": mv(2000, "2.0 s"), // improved (−500, lower better)
    "cumulative-layout-shift": mv(0.2, "0.2"), // regressed (+0.1)
    "total-blocking-time": mv(300, "300 ms"), // unchanged
    "first-contentful-paint": null, // missing comparison side
    "speed-index": mv(2500, "2.5 s"),
    interactive: mv(4000, "4.0 s"), // baseline null → missing
  };

  it("treats a decreased numericValue as improved (lower is better)", () => {
    const lcp = diffMetrics(baseline, comparison).find((d) => d.id === "largest-contentful-paint");
    expect(lcp).toMatchObject({ delta: -500, improved: true });
  });

  it("treats an increased numericValue as a regression", () => {
    const cls = diffMetrics(baseline, comparison).find((d) => d.id === "cumulative-layout-shift");
    expect(cls?.improved).toBe(false);
    expect(cls?.delta).toBeCloseTo(0.1, 5);
  });

  it("treats an unchanged numericValue as null improved with delta 0", () => {
    const tbt = diffMetrics(baseline, comparison).find((d) => d.id === "total-blocking-time");
    expect(tbt).toMatchObject({ delta: 0, improved: null });
  });

  it("handles a missing comparison metric", () => {
    const fcp = diffMetrics(baseline, comparison).find((d) => d.id === "first-contentful-paint");
    expect(fcp).toMatchObject({ comparison: null, delta: null, improved: null });
  });

  it("handles a missing baseline metric", () => {
    const tti = diffMetrics(baseline, comparison).find((d) => d.id === "interactive");
    expect(tti).toMatchObject({ baseline: null, delta: null, improved: null });
  });

  it("handles both metric sets being null", () => {
    const diffs = diffMetrics(null, null);
    expect(diffs).toHaveLength(6);
    expect(diffs.every((d) => d.delta === null && d.improved === null)).toBe(true);
  });

  it("returns one diff per metric in canonical order", () => {
    expect(diffMetrics(baseline, comparison).map((d) => d.id)).toEqual([
      "largest-contentful-paint",
      "cumulative-layout-shift",
      "total-blocking-time",
      "first-contentful-paint",
      "speed-index",
      "interactive",
    ]);
  });
});

describe("buildScoreTrend", () => {
  it("orders points oldest → newest and excludes failed runs", () => {
    const rows = [
      makeRow({ id: "c", fetchTime: "2026-05-03T00:00:00.000Z", scores: { performance: 70 } }),
      makeRow({ id: "fail", status: "error", scores: {}, fetchTime: "2026-05-04T00:00:00.000Z" }),
      makeRow({ id: "a", fetchTime: "2026-05-01T00:00:00.000Z", scores: { performance: 50 } }),
      makeRow({ id: "b", fetchTime: "2026-05-02T00:00:00.000Z", scores: { performance: 60 } }),
    ];
    const trend = buildScoreTrend(rows);
    expect(trend.map((p) => p.runId)).toEqual(["a", "b", "c"]);
    expect(trend.map((p) => p.performance)).toEqual([50, 60, 70]);
  });

  it("projects all four category scores, normalising missing to null", () => {
    const trend = buildScoreTrend([
      makeRow({ id: "x", scores: { performance: 80, accessibility: 90 } }),
    ]);
    expect(trend[0]).toMatchObject({
      runId: "x",
      performance: 80,
      accessibility: 90,
      "best-practices": null,
      seo: null,
    });
  });

  it("uses the run's effective time as the x dataKey", () => {
    const trend = buildScoreTrend([
      makeRow({ id: "y", fetchTime: null, createdAt: "2026-05-09T08:00:00.000Z" }),
    ]);
    expect(trend[0].t).toBe("2026-05-09T08:00:00.000Z");
    expect(trend[0].label).not.toBe("");
  });

  it("returns an empty array for no done runs", () => {
    expect(buildScoreTrend([makeRow({ status: "error", scores: {} })])).toEqual([]);
  });
});
