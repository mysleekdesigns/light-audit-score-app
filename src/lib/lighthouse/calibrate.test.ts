import { describe, expect, it } from "vitest";

import {
  calibrationFor,
  classifyBenchmarkIndex,
  recommendCpuMultiplier,
} from "@/lib/lighthouse/calibrate";
import { MAX_CPU_MULTIPLIER, MIN_CPU_MULTIPLIER } from "@/lib/lighthouse/types";

describe("classifyBenchmarkIndex", () => {
  it("maps each bracket to its device class (docs/throttling.md cutoffs)", () => {
    expect(classifyBenchmarkIndex(1800)).toBe("high-end-desktop");
    expect(classifyBenchmarkIndex(1500)).toBe("high-end-desktop");
    expect(classifyBenchmarkIndex(1200)).toBe("low-end-desktop");
    expect(classifyBenchmarkIndex(900)).toBe("high-end-mobile");
    expect(classifyBenchmarkIndex(400)).toBe("mid-tier-mobile");
    expect(classifyBenchmarkIndex(125)).toBe("mid-tier-mobile");
    expect(classifyBenchmarkIndex(80)).toBe("low-end-mobile");
  });
});

describe("recommendCpuMultiplier", () => {
  it("reproduces the doc's suggested multipliers when targeting mid-tier mobile", () => {
    // High-end desktop midpoint (~1750) → the documented default 4×.
    expect(recommendCpuMultiplier(1750)).toBe(4);
    // High-end mobile midpoint (~1000) → 2×.
    expect(recommendCpuMultiplier(1000)).toBe(2);
    // Mid-tier mobile is already on target → 1×.
    expect(recommendCpuMultiplier(450)).toBe(1);
  });

  it("recommends a higher multiplier for a very fast host (Apple Silicon)", () => {
    // ~4000 benchmarkIndex needs far more than the default 4× to hit mid-tier mobile.
    const m = recommendCpuMultiplier(4046);
    expect(m).toBeGreaterThan(4);
    expect(m).toBeLessThanOrEqual(MAX_CPU_MULTIPLIER);
  });

  it("never drops below the minimum for an underpowered host", () => {
    expect(recommendCpuMultiplier(50)).toBe(MIN_CPU_MULTIPLIER);
  });

  it("never exceeds the maximum for an extreme host", () => {
    expect(recommendCpuMultiplier(100000)).toBe(MAX_CPU_MULTIPLIER);
  });
});

describe("calibrationFor", () => {
  it("returns a full calibration for a valid index", () => {
    expect(calibrationFor(1750)).toEqual({
      benchmarkIndex: 1750,
      deviceClass: "high-end-desktop",
      deviceClassLabel: "High-end desktop",
      recommendedMultiplier: 4,
    });
  });

  it("returns null for missing or invalid indices", () => {
    expect(calibrationFor(null)).toBeNull();
    expect(calibrationFor(undefined)).toBeNull();
    expect(calibrationFor(0)).toBeNull();
    expect(calibrationFor(Number.NaN)).toBeNull();
    expect(calibrationFor(-100)).toBeNull();
  });
});
