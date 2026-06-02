import { describe, expect, it } from "vitest";

import {
  parseFieldData,
  parseFieldExperience,
} from "@/lib/pagespeed/parseFieldData";

const sampleMetric = {
  percentile: 2100,
  category: "AVERAGE",
  distributions: [
    { min: 0, max: 2500, proportion: 0.7 },
    { min: 2500, max: 4000, proportion: 0.2 },
    { min: 4000, max: null, proportion: 0.1 },
  ],
};

describe("parseFieldExperience", () => {
  it("maps metrics + overall category, preserving raw percentiles", () => {
    const exp = parseFieldExperience({
      overall_category: "AVERAGE",
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: sampleMetric,
        // CLS percentile is PSI's raw ×100 value — stored as-is, normalised at display.
        CUMULATIVE_LAYOUT_SHIFT_SCORE: {
          percentile: 20,
          category: "AVERAGE",
          distributions: [],
        },
      },
    });
    expect(exp).toBeDefined();
    expect(exp?.overallCategory).toBe("AVERAGE");
    expect(exp?.metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile).toBe(2100);
    expect(exp?.metrics.LARGEST_CONTENTFUL_PAINT_MS?.distributions).toHaveLength(3);
    expect(exp?.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile).toBe(20);
  });

  it("returns undefined when there is no overall category and no usable metric", () => {
    expect(parseFieldExperience({ metrics: {} })).toBeUndefined();
    expect(parseFieldExperience(undefined)).toBeUndefined();
    expect(parseFieldExperience(null)).toBeUndefined();
  });

  it("keeps an experience that has only an overall category (empty metrics)", () => {
    const exp = parseFieldExperience({ overall_category: "FAST", metrics: {} });
    expect(exp?.overallCategory).toBe("FAST");
    expect(Object.keys(exp?.metrics ?? {})).toHaveLength(0);
  });

  it("drops metrics missing a percentile or category", () => {
    const exp = parseFieldExperience({
      overall_category: "SLOW",
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: sampleMetric,
        INTERACTION_TO_NEXT_PAINT: { category: "FAST" }, // no percentile
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 900 }, // no category
      },
    });
    expect(exp?.metrics.LARGEST_CONTENTFUL_PAINT_MS).toBeDefined();
    expect(exp?.metrics.INTERACTION_TO_NEXT_PAINT).toBeUndefined();
    expect(exp?.metrics.FIRST_CONTENTFUL_PAINT_MS).toBeUndefined();
  });
});

describe("parseFieldData", () => {
  it("returns undefined when neither URL nor origin has data", () => {
    expect(parseFieldData(undefined, undefined)).toBeUndefined();
    expect(parseFieldData({ metrics: {} }, { metrics: {} })).toBeUndefined();
  });

  it("includes whichever experiences have data", () => {
    const field = parseFieldData(
      { overall_category: "AVERAGE", metrics: { LARGEST_CONTENTFUL_PAINT_MS: sampleMetric } },
      { overall_category: "FAST", metrics: {} },
    );
    expect(field?.url?.overallCategory).toBe("AVERAGE");
    expect(field?.origin?.overallCategory).toBe("FAST");
  });

  it("omits the origin experience when only the URL has data", () => {
    const field = parseFieldData(
      { overall_category: "SLOW", metrics: {} },
      undefined,
    );
    expect(field?.url?.overallCategory).toBe("SLOW");
    expect(field?.origin).toBeUndefined();
  });
});
