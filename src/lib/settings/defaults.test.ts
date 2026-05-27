import { describe, expect, it } from "vitest";

import {
  clampCpuMultiplier,
  clampRuns,
  clampScore,
  DEFAULT_AUDIT_DEFAULTS,
  MATCH_DEVTOOLS_PRESET,
  normalizeDefaults,
  sanitizeCategories,
  sanitizeThresholds,
  serializeDefaults,
} from "@/lib/settings/defaults";
import { MAX_CPU_MULTIPLIER, MIN_CPU_MULTIPLIER } from "@/lib/lighthouse/types";

describe("clampScore", () => {
  it("rounds and clamps into 0–100", () => {
    expect(clampScore(89.6, 90)).toBe(90);
    expect(clampScore(-5, 90)).toBe(0);
    expect(clampScore(140, 90)).toBe(100);
  });

  it("falls back for non-numbers", () => {
    expect(clampScore("90", 50)).toBe(50);
    expect(clampScore(Number.NaN, 50)).toBe(50);
    expect(clampScore(undefined, 50)).toBe(50);
  });
});

describe("clampRuns", () => {
  it("clamps into MIN_RUNS..MAX_RUNS", () => {
    expect(clampRuns(0, 3)).toBe(1);
    expect(clampRuns(9, 3)).toBe(5);
    expect(clampRuns(2, 3)).toBe(2);
  });

  it("falls back for non-numbers", () => {
    expect(clampRuns("3", 3)).toBe(3);
    expect(clampRuns(null, 4)).toBe(4);
  });
});

describe("sanitizeCategories", () => {
  it("keeps only valid categories in canonical order", () => {
    expect(sanitizeCategories(["seo", "performance", "bogus"])).toEqual([
      "performance",
      "seo",
    ]);
  });

  it("never returns empty (falls back to all)", () => {
    expect(sanitizeCategories([])).toEqual([
      "performance",
      "accessibility",
      "best-practices",
      "seo",
    ]);
    expect(sanitizeCategories("nope")).toHaveLength(4);
  });
});

describe("sanitizeThresholds", () => {
  it("fills every category, clamping values and defaulting gaps to 90", () => {
    expect(sanitizeThresholds({ performance: 75, seo: 200 })).toEqual({
      performance: 75,
      accessibility: 90,
      "best-practices": 90,
      seo: 100,
    });
  });

  it("returns all-90 for non-objects", () => {
    expect(sanitizeThresholds(null)).toEqual({
      performance: 90,
      accessibility: 90,
      "best-practices": 90,
      seo: 90,
    });
  });
});

describe("clampCpuMultiplier", () => {
  it("clamps into MIN..MAX_CPU_MULTIPLIER, rounding", () => {
    expect(clampCpuMultiplier(6)).toBe(6);
    expect(clampCpuMultiplier(0)).toBe(MIN_CPU_MULTIPLIER);
    expect(clampCpuMultiplier(999)).toBe(MAX_CPU_MULTIPLIER);
    expect(clampCpuMultiplier(4.4)).toBe(4);
  });

  it("returns undefined for non-numbers (→ Lighthouse's 4× default)", () => {
    expect(clampCpuMultiplier(undefined)).toBeUndefined();
    expect(clampCpuMultiplier("4")).toBeUndefined();
    expect(clampCpuMultiplier(Number.NaN)).toBeUndefined();
  });
});

describe("normalizeDefaults", () => {
  it("returns factory defaults for junk input", () => {
    expect(normalizeDefaults(undefined)).toEqual(DEFAULT_AUDIT_DEFAULTS);
    expect(normalizeDefaults("nonsense")).toEqual(DEFAULT_AUDIT_DEFAULTS);
  });

  it("validates and clamps every field", () => {
    const result = normalizeDefaults({
      formFactor: "desktop",
      runs: 99,
      concurrency: 999,
      categories: ["seo"],
      thresholds: { performance: -10 },
    });
    expect(result.formFactor).toBe("desktop");
    expect(result.runs).toBe(5);
    expect(result.concurrency).toBeLessThanOrEqual(8);
    expect(result.categories).toEqual(["seo"]);
    expect(result.thresholds.performance).toBe(0);
    expect(result.thresholds.seo).toBe(90);
  });

  it("treats an unknown formFactor as mobile", () => {
    expect(normalizeDefaults({ formFactor: "watch" }).formFactor).toBe("mobile");
  });

  it("normalizes the Phase 9 fields (throttling / accuracyMode / cpuSlowdownMultiplier)", () => {
    // Defaults when absent.
    const bare = normalizeDefaults({});
    expect(bare.throttling).toBe("simulated");
    expect(bare.accuracyMode).toBe(false);
    expect(bare.cpuSlowdownMultiplier).toBeUndefined();

    // Whitelisted / clamped when present.
    const custom = normalizeDefaults({
      throttling: "applied",
      accuracyMode: true,
      cpuSlowdownMultiplier: 999,
    });
    expect(custom.throttling).toBe("applied");
    expect(custom.accuracyMode).toBe(true);
    expect(custom.cpuSlowdownMultiplier).toBe(MAX_CPU_MULTIPLIER);

    // Garbage degrades safely.
    const junk = normalizeDefaults({ throttling: "turbo", accuracyMode: "yes" });
    expect(junk.throttling).toBe("simulated");
    expect(junk.accuracyMode).toBe(false);
  });

  it("MATCH_DEVTOOLS_PRESET resolves to the panel's defaults", () => {
    const resolved = normalizeDefaults({
      ...DEFAULT_AUDIT_DEFAULTS,
      cpuSlowdownMultiplier: 12,
      ...MATCH_DEVTOOLS_PRESET,
    });
    expect(resolved.formFactor).toBe("mobile");
    expect(resolved.throttling).toBe("simulated");
    expect(resolved.runs).toBe(1);
    expect(resolved.concurrency).toBe(1);
    expect(resolved.accuracyMode).toBe(true);
    // Preset clears any prior calibrated multiplier → Lighthouse's 4× default.
    expect(resolved.cpuSlowdownMultiplier).toBeUndefined();
  });

  it("round-trips through serialize → JSON.parse → normalize", () => {
    const custom = normalizeDefaults({
      formFactor: "desktop",
      throttling: "applied",
      runs: 4,
      concurrency: 2,
      accuracyMode: true,
      categories: ["performance", "seo"],
      cpuSlowdownMultiplier: 6,
      thresholds: { performance: 80, accessibility: 70, "best-practices": 60, seo: 50 },
    });
    const restored = normalizeDefaults(JSON.parse(serializeDefaults(custom)));
    expect(restored).toEqual(custom);
  });
});
