import { describe, expect, it } from "vitest";

import {
  clampCpuMultiplier,
  clampRuns,
  clampScore,
  DEFAULT_AUDIT_DEFAULTS,
  DEFAULT_THRESHOLDS,
  MATCH_DEVTOOLS_PRESET,
  normalizeDefaults,
  sanitizeCategories,
  sanitizeThresholds,
  serializeDefaults,
} from "@/lib/settings/defaults";
import {
  LIGHTHOUSE_CATEGORIES,
  MAX_CPU_MULTIPLIER,
  MIN_CPU_MULTIPLIER,
} from "@/lib/lighthouse/types";

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
      "agentic-browsing",
    ]);
    expect(sanitizeCategories("nope")).toHaveLength(5);
  });

  it("keeps Lighthouse 13.3's fifth category, appended last", () => {
    expect(sanitizeCategories(["agentic-browsing"])).toEqual([
      "agentic-browsing",
    ]);
    // Canonical order appends it after seo rather than reshuffling the four.
    expect(sanitizeCategories(["agentic-browsing", "performance"])).toEqual([
      "performance",
      "agentic-browsing",
    ]);
  });
});

describe("sanitizeThresholds", () => {
  it("fills every category, clamping values and defaulting gaps to 90", () => {
    expect(sanitizeThresholds({ performance: 75, seo: 200 })).toEqual({
      performance: 75,
      accessibility: 90,
      "best-practices": 90,
      seo: 100,
      "agentic-browsing": 90,
    });
  });

  it("returns all-90 for non-objects", () => {
    expect(sanitizeThresholds(null)).toEqual({
      performance: 90,
      accessibility: 90,
      "best-practices": 90,
      seo: 90,
      "agentic-browsing": 90,
    });
  });

  it("upgrades a blob stored before Agentic Browsing existed, keeping tuned bars", () => {
    // Purely additive: a four-key blob (written under the same storage key)
    // gains the fifth bar at the default 90 without disturbing the others.
    const legacy = { performance: 50, accessibility: 60, "best-practices": 70, seo: 80 };
    expect(sanitizeThresholds(legacy)).toEqual({
      ...legacy,
      "agentic-browsing": 90,
    });
    // And an explicitly-set bar is honoured + clamped like any other.
    expect(
      sanitizeThresholds({ "agentic-browsing": 45 })["agentic-browsing"],
    ).toBe(45);
    expect(
      sanitizeThresholds({ "agentic-browsing": 250 })["agentic-browsing"],
    ).toBe(100);
  });
});

describe("DEFAULT_THRESHOLDS", () => {
  it("carries a bar for every Lighthouse category, including Agentic Browsing", () => {
    for (const category of LIGHTHOUSE_CATEGORIES) {
      expect(DEFAULT_THRESHOLDS[category]).toBe(90);
    }
    expect(Object.keys(DEFAULT_THRESHOLDS)).toHaveLength(
      LIGHTHOUSE_CATEGORIES.length,
    );
  });

  it("defaults a new audit to every category", () => {
    expect(DEFAULT_AUDIT_DEFAULTS.categories).toEqual([
      ...LIGHTHOUSE_CATEGORIES,
    ]);
    expect(DEFAULT_AUDIT_DEFAULTS.categories).toContain("agentic-browsing");
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

  it('keeps the widened "both" device selection (Phase 12)', () => {
    expect(normalizeDefaults({ formFactor: "both" }).formFactor).toBe("both");
    expect(normalizeDefaults({ formFactor: "desktop" }).formFactor).toBe(
      "desktop",
    );
    // A garbage value still falls back to mobile after the widening.
    expect(normalizeDefaults({ formFactor: "tablet" }).formFactor).toBe(
      "mobile",
    );
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
      concurrency: 1,
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

  it("lets the Concurrency dial win over accuracyMode (what you see is what runs)", () => {
    // Accuracy mode means one page at a time, so it only survives at concurrency 1.
    expect(
      normalizeDefaults({ accuracyMode: true, concurrency: 1 }).accuracyMode,
    ).toBe(true);
    // A blob carrying both the flag and a higher dial (the two used to be
    // independent, and the queue quietly pinned such runs to 1) keeps the dial.
    const conflicted = normalizeDefaults({ accuracyMode: true, concurrency: 8 });
    expect(conflicted.concurrency).toBe(8);
    expect(conflicted.accuracyMode).toBe(false);
    // The flag alone (dial absent → the factory default of 3) resolves the same way.
    expect(normalizeDefaults({ accuracyMode: true }).accuracyMode).toBe(false);
  });

  it("normalizes the Phase 11 resultsView field", () => {
    // Defaults to the dense table when absent or garbage.
    expect(normalizeDefaults({}).resultsView).toBe("table");
    expect(normalizeDefaults({ resultsView: "grid" }).resultsView).toBe("table");
    expect(DEFAULT_AUDIT_DEFAULTS.resultsView).toBe("table");
    // Honoured when explicitly "cards".
    expect(normalizeDefaults({ resultsView: "cards" }).resultsView).toBe("cards");
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
    // …and clears storage (cold first visit), matching the panel's own default.
    expect(resolved.warmCache).toBe(false);
  });

  it("normalizes the Best Practices parity fields (warmCache / userAgentPreset)", () => {
    // Defaults when absent: warm cache on, no UA override.
    const bare = normalizeDefaults({});
    expect(bare.warmCache).toBe(true);
    expect(bare.userAgentPreset).toBe("default");
    expect(DEFAULT_AUDIT_DEFAULTS.warmCache).toBe(true);
    expect(DEFAULT_AUDIT_DEFAULTS.userAgentPreset).toBe("default");

    // Honoured when present; only an explicit false turns warm cache off.
    expect(normalizeDefaults({ warmCache: false }).warmCache).toBe(false);
    expect(
      normalizeDefaults({ userAgentPreset: "desktop-chrome" }).userAgentPreset,
    ).toBe("desktop-chrome");

    // Garbage degrades safely.
    expect(normalizeDefaults({ warmCache: "no" }).warmCache).toBe(true);
    expect(normalizeDefaults({ userAgentPreset: "ie6" }).userAgentPreset).toBe(
      "default",
    );
  });

  it("normalizes pagesPerTemplate (additive, defaults to 0 = All)", () => {
    // Absent in older blobs → 0 (All), so the field upgrades without a key bump.
    expect(normalizeDefaults({}).pagesPerTemplate).toBe(0);
    expect(DEFAULT_AUDIT_DEFAULTS.pagesPerTemplate).toBe(0);
    // Honoured + clamped when present; garbage degrades to All.
    expect(normalizeDefaults({ pagesPerTemplate: 3 }).pagesPerTemplate).toBe(3);
    expect(normalizeDefaults({ pagesPerTemplate: "5" }).pagesPerTemplate).toBe(0);
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
