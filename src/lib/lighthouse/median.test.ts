import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AuditOptions,
  type LighthouseResult,
  type SingleRunResult,
} from "@/lib/lighthouse/types";

// Mock the single-run module so no Chrome is launched. `parseLhr` is kept real
// (the median path re-parses the selected LHR), so the fabricated LHRs below
// carry the fields parseLhr reads.
const runSingleAudit = vi.fn<(url: string, options: AuditOptions) => Promise<SingleRunResult>>();
vi.mock("@/lib/lighthouse/runAudit", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/lighthouse/runAudit")
  >("@/lib/lighthouse/runAudit");
  return { ...actual, runSingleAudit };
});

// Imported after vi.mock so the mock is in place.
const { runAudit } = await import("@/lib/lighthouse/median");

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance"],
  runs: 3,
};

/**
 * Build an LHR valid enough for Lighthouse's real `computeMedianRun`, which
 * medians over FCP, interactive, and LCP. `perf` drives the perf score and the
 * metric numeric values so median selection is deterministic.
 */
function makeLhr(perf: number, fetchTime: string): LighthouseResult {
  const ms = (10 - perf) * 1000; // higher perf → lower timings
  return {
    requestedUrl: "https://example.com/",
    finalDisplayedUrl: "https://example.com/",
    fetchTime,
    lighthouseVersion: "13.0.0",
    runWarnings: [`warn-${perf}`],
    categories: { performance: { id: "performance", score: perf / 10 } },
    audits: {
      "first-contentful-paint": { numericValue: ms, displayValue: `${ms}`, score: perf / 10 },
      "interactive": { numericValue: ms, displayValue: `${ms}`, score: perf / 10 },
      "largest-contentful-paint": { numericValue: ms, displayValue: `${ms}`, score: perf / 10 },
    },
    environment: { benchmarkIndex: 1500, hostUserAgent: "test" },
    configSettings: {
      throttlingMethod: "simulate",
      throttling: { cpuSlowdownMultiplier: 4 },
    },
    timing: { total: ms },
  };
}

function makeRun(perf: number, fetchTime: string): SingleRunResult {
  const lhr = makeLhr(perf, fetchTime);
  return {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    fetchTime,
    lighthouseVersion: "13.0.0",
    formFactor: "mobile",
    scores: { performance: perf * 10 },
    metrics: {
      "largest-contentful-paint": { numericValue: (10 - perf) * 1000, displayValue: "", score: perf / 10 },
      "cumulative-layout-shift": null,
      "total-blocking-time": null,
      "first-contentful-paint": { numericValue: (10 - perf) * 1000, displayValue: "", score: perf / 10 },
      "speed-index": null,
      interactive: { numericValue: (10 - perf) * 1000, displayValue: "", score: perf / 10 },
    },
    opportunities: [],
    runWarnings: [`warn-${perf}`],
    environment: {
      benchmarkIndex: 1500,
      hostUserAgent: "test",
      throttlingMethod: "simulate",
      cpuSlowdownMultiplier: 4,
    },
    lhr,
  };
}

describe("runAudit (median of N)", () => {
  beforeEach(() => {
    runSingleAudit.mockReset();
  });

  it("runs sequentially N times and returns perRunScores of length N", async () => {
    runSingleAudit
      .mockResolvedValueOnce(makeRun(4, "t1"))
      .mockResolvedValueOnce(makeRun(8, "t2"))
      .mockResolvedValueOnce(makeRun(6, "t3"));

    const result = await runAudit("https://example.com/", OPTIONS);

    expect(runSingleAudit).toHaveBeenCalledTimes(3);
    expect(result.runs).toBe(3);
    expect(result.perRunScores).toEqual([
      { performance: 40 },
      { performance: 80 },
      { performance: 60 },
    ]);
  });

  it("selects the median run via computeMedianRun", async () => {
    runSingleAudit
      .mockResolvedValueOnce(makeRun(4, "t1"))
      .mockResolvedValueOnce(makeRun(8, "t2"))
      .mockResolvedValueOnce(makeRun(6, "t3"));

    const result = await runAudit("https://example.com/", OPTIONS);

    // The middle-performing run (6 → score 60, fetchTime t3) is the median.
    expect(result.median.scores.performance).toBe(60);
    expect(result.median.lhr.fetchTime).toBe("t3");
  });

  it("dedupes run warnings across runs", async () => {
    runSingleAudit
      .mockResolvedValueOnce(makeRun(4, "t1"))
      .mockResolvedValueOnce(makeRun(4, "t2"))
      .mockResolvedValueOnce(makeRun(6, "t3"));

    const result = await runAudit("https://example.com/", OPTIONS);
    expect([...result.runWarnings].sort()).toEqual(["warn-4", "warn-6"]);
  });

  it("falls back to the single run when N === 1", async () => {
    const single: AuditOptions = { ...OPTIONS, runs: 1 };
    runSingleAudit.mockResolvedValueOnce(makeRun(7, "only"));

    const result = await runAudit("https://example.com/", single);

    expect(runSingleAudit).toHaveBeenCalledTimes(1);
    expect(result.runs).toBe(1);
    expect(result.perRunScores).toHaveLength(1);
    expect(result.median.lhr.fetchTime).toBe("only");
    expect(result.median.scores.performance).toBe(70);
  });

  it("carries options, urls and version onto the result", async () => {
    runSingleAudit
      .mockResolvedValueOnce(makeRun(4, "t1"))
      .mockResolvedValueOnce(makeRun(8, "t2"))
      .mockResolvedValueOnce(makeRun(6, "t3"));

    const result = await runAudit("https://example.com/", OPTIONS);
    expect(result.options).toBe(OPTIONS);
    expect(result.requestedUrl).toBe("https://example.com/");
    expect(result.finalUrl).toBe("https://example.com/");
    expect(result.lighthouseVersion).toBe("13.0.0");
  });
});
