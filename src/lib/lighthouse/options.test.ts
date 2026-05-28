import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIONS,
  parseAuditOptions,
  resolveAuditOptions,
  resolveFormFactors,
} from "@/lib/lighthouse/options";
import {
  LIGHTHOUSE_CATEGORIES,
  MAX_CPU_MULTIPLIER,
  MIN_CPU_MULTIPLIER,
} from "@/lib/lighthouse/types";

describe("DEFAULT_OPTIONS", () => {
  it("is mobile / simulated / all categories / 3 runs / warm cache", () => {
    expect(DEFAULT_OPTIONS).toEqual({
      formFactor: "mobile",
      throttling: "simulated",
      categories: [...LIGHTHOUSE_CATEGORIES],
      runs: 3,
      warmCache: true,
    });
  });
});

describe("resolveAuditOptions", () => {
  it("returns defaults for undefined input", () => {
    expect(resolveAuditOptions()).toEqual(DEFAULT_OPTIONS);
  });

  it("returns defaults for null input", () => {
    expect(resolveAuditOptions(null)).toEqual(DEFAULT_OPTIONS);
  });

  it("returns defaults for an empty object", () => {
    expect(resolveAuditOptions({})).toEqual(DEFAULT_OPTIONS);
  });

  it("overrides only the provided fields, defaults fill the rest", () => {
    const result = resolveAuditOptions({ formFactor: "desktop", runs: 5 });
    expect(result).toEqual({
      formFactor: "desktop",
      throttling: "simulated",
      categories: [...LIGHTHOUSE_CATEGORIES],
      runs: 5,
      warmCache: true,
    });
  });

  it("accepts a full, explicit options object", () => {
    const result = resolveAuditOptions({
      formFactor: "desktop",
      throttling: "applied",
      categories: ["performance", "seo"],
      runs: 1,
      warmCache: false,
    });
    expect(result).toEqual({
      formFactor: "desktop",
      throttling: "applied",
      categories: ["performance", "seo"],
      runs: 1,
      warmCache: false,
    });
  });

  it("dedupes duplicate categories while preserving order", () => {
    const result = resolveAuditOptions({
      categories: ["seo", "performance", "seo", "performance"],
    });
    expect(result.categories).toEqual(["seo", "performance"]);
  });

  it("throws on an empty categories array", () => {
    expect(() => resolveAuditOptions({ categories: [] })).toThrow(
      /audit options/i,
    );
  });

  it("throws on an unknown category value", () => {
    expect(() => resolveAuditOptions({ categories: ["pwa"] })).toThrow(
      /audit options/i,
    );
  });

  it("throws when runs is below the minimum", () => {
    expect(() => resolveAuditOptions({ runs: 0 })).toThrow(/audit options/i);
  });

  it("throws when runs is above the maximum", () => {
    expect(() => resolveAuditOptions({ runs: 6 })).toThrow(/audit options/i);
  });

  it("throws when runs is not an integer", () => {
    expect(() => resolveAuditOptions({ runs: 2.5 })).toThrow(/audit options/i);
  });

  it("throws on an invalid formFactor", () => {
    expect(() => resolveAuditOptions({ formFactor: "tablet" })).toThrow(
      /audit options/i,
    );
  });

  it("throws on an invalid throttling value", () => {
    expect(() => resolveAuditOptions({ throttling: "none" })).toThrow(
      /audit options/i,
    );
  });

  it("includes the offending field path in the error message", () => {
    expect(() => resolveAuditOptions({ runs: 99 })).toThrow(/runs/);
  });
});

describe("resolveAuditOptions — cpuSlowdownMultiplier", () => {
  it("omits the field entirely when not provided (no default)", () => {
    const result = resolveAuditOptions({});
    expect("cpuSlowdownMultiplier" in result).toBe(false);
    expect(result.cpuSlowdownMultiplier).toBeUndefined();
  });

  it("keeps an in-range integer multiplier unchanged", () => {
    const result = resolveAuditOptions({ cpuSlowdownMultiplier: 6 });
    expect(result.cpuSlowdownMultiplier).toBe(6);
  });

  it("keeps an in-range fractional multiplier unchanged (no flooring)", () => {
    const result = resolveAuditOptions({ cpuSlowdownMultiplier: 4.5 });
    expect(result.cpuSlowdownMultiplier).toBe(4.5);
  });

  it("clamps below MIN_CPU_MULTIPLIER up to the minimum", () => {
    const result = resolveAuditOptions({ cpuSlowdownMultiplier: 0 });
    expect(result.cpuSlowdownMultiplier).toBe(MIN_CPU_MULTIPLIER);
  });

  it("clamps above MAX_CPU_MULTIPLIER down to the maximum", () => {
    const result = resolveAuditOptions({ cpuSlowdownMultiplier: 999 });
    expect(result.cpuSlowdownMultiplier).toBe(MAX_CPU_MULTIPLIER);
  });

  it("keeps the exact bounds unchanged", () => {
    expect(
      resolveAuditOptions({ cpuSlowdownMultiplier: MIN_CPU_MULTIPLIER })
        .cpuSlowdownMultiplier,
    ).toBe(MIN_CPU_MULTIPLIER);
    expect(
      resolveAuditOptions({ cpuSlowdownMultiplier: MAX_CPU_MULTIPLIER })
        .cpuSlowdownMultiplier,
    ).toBe(MAX_CPU_MULTIPLIER);
  });

  it("throws on a non-numeric multiplier", () => {
    expect(() =>
      resolveAuditOptions({ cpuSlowdownMultiplier: "fast" }),
    ).toThrow(/audit options/i);
  });
});

describe("parseAuditOptions", () => {
  it("behaves like resolveAuditOptions for valid input", () => {
    expect(parseAuditOptions({ formFactor: "desktop" })).toEqual(
      resolveAuditOptions({ formFactor: "desktop" }),
    );
  });

  it("throws on invalid input", () => {
    expect(() => parseAuditOptions({ runs: -1 })).toThrow(/audit options/i);
  });
});

describe("resolveFormFactors", () => {
  it("expands 'both' to mobile then desktop, in that stable order", () => {
    expect(resolveFormFactors("both")).toEqual(["mobile", "desktop"]);
  });

  it("returns a single-element list for 'mobile'", () => {
    expect(resolveFormFactors("mobile")).toEqual(["mobile"]);
  });

  it("returns a single-element list for 'desktop'", () => {
    expect(resolveFormFactors("desktop")).toEqual(["desktop"]);
  });
});
