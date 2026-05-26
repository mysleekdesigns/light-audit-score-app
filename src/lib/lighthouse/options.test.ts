import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIONS,
  parseAuditOptions,
  resolveAuditOptions,
} from "@/lib/lighthouse/options";
import { LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";

describe("DEFAULT_OPTIONS", () => {
  it("is mobile / simulated / all categories / 3 runs", () => {
    expect(DEFAULT_OPTIONS).toEqual({
      formFactor: "mobile",
      throttling: "simulated",
      categories: [...LIGHTHOUSE_CATEGORIES],
      runs: 3,
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
    });
  });

  it("accepts a full, explicit options object", () => {
    const result = resolveAuditOptions({
      formFactor: "desktop",
      throttling: "applied",
      categories: ["performance", "seo"],
      runs: 1,
    });
    expect(result).toEqual({
      formFactor: "desktop",
      throttling: "applied",
      categories: ["performance", "seo"],
      runs: 1,
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
