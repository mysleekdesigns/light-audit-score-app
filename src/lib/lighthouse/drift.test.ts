import { describe, expect, it } from "vitest";

import {
  assessDrift,
  benchmarkIndexSpread,
  MULTIPLIER_DRIFT_THRESHOLD,
  SPREAD_WARN_RELATIVE,
} from "@/lib/lighthouse/drift";

describe("benchmarkIndexSpread", () => {
  it("returns null when there are no valid values", () => {
    expect(benchmarkIndexSpread([])).toBeNull();
    expect(benchmarkIndexSpread([null, undefined])).toBeNull();
    expect(benchmarkIndexSpread([0, -5, Number.NaN])).toBeNull();
  });

  it("computes min/max/mean/range over valid values, ignoring null/invalid", () => {
    const spread = benchmarkIndexSpread([1000, null, 2000, undefined, 0]);
    expect(spread).not.toBeNull();
    expect(spread!.count).toBe(2);
    expect(spread!.min).toBe(1000);
    expect(spread!.max).toBe(2000);
    expect(spread!.mean).toBe(1500);
    expect(spread!.range).toBe(1000);
    expect(spread!.relativeSpread).toBeCloseTo(1000 / 1500);
  });

  it("reports zero spread for a single value", () => {
    const spread = benchmarkIndexSpread([1234]);
    expect(spread!.count).toBe(1);
    expect(spread!.range).toBe(0);
    expect(spread!.relativeSpread).toBe(0);
  });
});

describe("assessDrift", () => {
  it("returns 'none' when Performance is out of scope, regardless of host", () => {
    const result = assessDrift({
      benchmarkIndices: [4000],
      cpuSlowdownMultiplier: 4,
      concurrency: 3,
      performanceInScope: false,
    });
    expect(result.severity).toBe("none");
    expect(result.reasons).toEqual([]);
    // Still exposes the calibration/spread for an informational badge.
    expect(result.calibration).not.toBeNull();
    expect(result.spread).not.toBeNull();
  });

  it("flags a fast host under-throttled by the default 4× (optimistic Performance)", () => {
    const result = assessDrift({
      benchmarkIndices: [4000],
      cpuSlowdownMultiplier: 4,
      concurrency: 1,
    });
    expect(result.severity).toBe("warn");
    expect(result.powerDrift).toBe(true);
    // benchmark 4000 → recommended ~9×, applied 4× → gap >= threshold.
    expect(result.calibration!.recommendedMultiplier).toBeGreaterThanOrEqual(
      4 + MULTIPLIER_DRIFT_THRESHOLD,
    );
    expect(result.reasons[0]).toMatch(/optimistically/i);
    expect(result.reasons[0]).toMatch(/calibrate/i);
  });

  it("treats a missing multiplier as the 4× default for power-drift", () => {
    const pinned = assessDrift({
      benchmarkIndices: [4000],
      cpuSlowdownMultiplier: 4,
      concurrency: 1,
    });
    const auto = assessDrift({
      benchmarkIndices: [4000],
      cpuSlowdownMultiplier: null,
      concurrency: 1,
    });
    expect(auto.powerDrift).toBe(pinned.powerDrift);
    expect(auto.powerDrift).toBe(true);
  });

  it("does not flag power-drift on a high-end desktop at the default 4×", () => {
    const result = assessDrift({
      benchmarkIndices: [1750],
      cpuSlowdownMultiplier: 4,
      concurrency: 1,
    });
    // benchmark 1750 → recommended 4×, applied 4× → no gap.
    expect(result.powerDrift).toBe(false);
    expect(result.severity).toBe("none");
  });

  it("flags an over-throttled host (applied multiplier too high) as pessimistic", () => {
    const result = assessDrift({
      benchmarkIndices: [1750],
      cpuSlowdownMultiplier: 10,
      concurrency: 1,
    });
    expect(result.powerDrift).toBe(true);
    expect(result.reasons[0]).toMatch(/pessimistically/i);
  });

  it("flags a wide benchmarkIndex spread across runs as CPU contention", () => {
    const result = assessDrift({
      // ~33% swing — well above SPREAD_WARN_RELATIVE.
      benchmarkIndices: [1500, 2100],
      cpuSlowdownMultiplier: 4,
      concurrency: 1,
    });
    expect(result.wideSpread).toBe(true);
    expect(result.spread!.relativeSpread).toBeGreaterThanOrEqual(
      SPREAD_WARN_RELATIVE,
    );
    expect(result.reasons.some((r) => /varied/i.test(r))).toBe(true);
  });

  it("does not flag a tight benchmarkIndex spread", () => {
    const result = assessDrift({
      // ~3% swing on a high-end-desktop host at the matching 4×.
      benchmarkIndices: [1700, 1750],
      cpuSlowdownMultiplier: 4,
      concurrency: 1,
    });
    expect(result.wideSpread).toBe(false);
  });

  it("flags concurrency > 1 with Performance in scope and clears at concurrency 1", () => {
    const contended = assessDrift({
      benchmarkIndices: [1750],
      cpuSlowdownMultiplier: 4,
      concurrency: 3,
    });
    expect(contended.concurrencyContended).toBe(true);
    expect(contended.severity).toBe("warn");
    expect(contended.reasons.some((r) => /accuracy mode/i.test(r))).toBe(true);

    const solo = assessDrift({
      benchmarkIndices: [1750],
      cpuSlowdownMultiplier: 4,
      concurrency: 1,
    });
    expect(solo.concurrencyContended).toBe(false);
    expect(solo.severity).toBe("none");
  });

  it("orders reasons power-drift → spread → concurrency when all fire", () => {
    const result = assessDrift({
      benchmarkIndices: [3500, 4500],
      cpuSlowdownMultiplier: 4,
      concurrency: 3,
    });
    expect(result.powerDrift).toBe(true);
    expect(result.wideSpread).toBe(true);
    expect(result.concurrencyContended).toBe(true);
    expect(result.reasons).toHaveLength(3);
    expect(result.reasons[0]).toMatch(/optimistically/i);
    expect(result.reasons[1]).toMatch(/varied/i);
    expect(result.reasons[2]).toMatch(/concurrency/i);
  });

  it("returns calibration null and no power-drift when no valid benchmarkIndex", () => {
    const result = assessDrift({
      benchmarkIndices: [null, undefined],
      cpuSlowdownMultiplier: 4,
      concurrency: 1,
    });
    expect(result.calibration).toBeNull();
    expect(result.powerDrift).toBe(false);
    expect(result.severity).toBe("none");
  });
});
