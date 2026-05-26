import { describe, expect, it } from "vitest";

import { parseLhr } from "@/lib/lighthouse/runAudit";
import { type LighthouseResult } from "@/lib/lighthouse/types";

/** A small but representative in-memory LHR. No Chrome is launched here. */
function sampleLhr(): LighthouseResult {
  return {
    requestedUrl: "https://example.com/",
    finalDisplayedUrl: "https://example.com/home",
    fetchTime: "2026-05-26T12:00:00.000Z",
    lighthouseVersion: "13.0.0",
    runWarnings: ["a warning"],
    categories: {
      performance: { id: "performance", score: 0.92 },
      accessibility: { id: "accessibility", score: 1 },
      seo: { id: "seo", score: null },
      // "best-practices" intentionally omitted to test partial scores.
    },
    audits: {
      "largest-contentful-paint": {
        numericValue: 2345.6,
        displayValue: "2.3 s",
        score: 0.88,
      },
      "cumulative-layout-shift": {
        numericValue: 0.01,
        displayValue: "0.01",
        score: 1,
      },
      // No "interactive" audit (TTI absent in v13) → should parse to null.
      "uses-text-compression": {
        title: "Enable text compression",
        description: "Compress text-based resources.",
        displayValue: "Est savings of 0.45 s",
        score: 0.5,
        details: { type: "opportunity", overallSavingsMs: 450 },
      },
      "render-blocking-resources": {
        title: "Eliminate render-blocking resources",
        description: "Resources block first paint.",
        displayValue: "Est savings of 1.20 s",
        score: 0,
        details: { type: "opportunity", overallSavingsMs: 1200 },
      },
      "non-opportunity": {
        title: "Just a passing audit",
        description: "Not an opportunity.",
        score: 1,
        details: { type: "table" },
      },
    },
  };
}

describe("parseLhr", () => {
  it("normalises category scores from 0–1 to 0–100 (null preserved)", () => {
    const parsed = parseLhr(sampleLhr(), "mobile");
    expect(parsed.scores.performance).toBe(92);
    expect(parsed.scores.accessibility).toBe(100);
    expect(parsed.scores.seo).toBeNull();
    // Omitted category should not appear.
    expect(parsed.scores["best-practices"]).toBeUndefined();
  });

  it("maps metric audits and tolerates absent metrics", () => {
    const parsed = parseLhr(sampleLhr(), "mobile");
    expect(parsed.metrics["largest-contentful-paint"]).toEqual({
      numericValue: 2345.6,
      displayValue: "2.3 s",
      score: 0.88,
    });
    expect(parsed.metrics["cumulative-layout-shift"]?.numericValue).toBe(0.01);
    // Missing audits (TTI, TBT, FCP, SI) → null.
    expect(parsed.metrics.interactive).toBeNull();
    expect(parsed.metrics["total-blocking-time"]).toBeNull();
  });

  it("extracts opportunities sorted by savings desc", () => {
    const parsed = parseLhr(sampleLhr(), "mobile");
    expect(parsed.opportunities).toHaveLength(2);
    expect(parsed.opportunities[0]).toMatchObject({
      id: "render-blocking-resources",
      savingsMs: 1200,
    });
    expect(parsed.opportunities[1]).toMatchObject({
      id: "uses-text-compression",
      savingsMs: 450,
    });
    // The non-opportunity audit is excluded.
    expect(
      parsed.opportunities.some((o) => o.id === "non-opportunity"),
    ).toBe(false);
  });

  it("pulls urls, fetchTime, version, warnings and carries formFactor", () => {
    const parsed = parseLhr(sampleLhr(), "desktop");
    expect(parsed.requestedUrl).toBe("https://example.com/");
    expect(parsed.finalUrl).toBe("https://example.com/home");
    expect(parsed.fetchTime).toBe("2026-05-26T12:00:00.000Z");
    expect(parsed.lighthouseVersion).toBe("13.0.0");
    expect(parsed.runWarnings).toEqual(["a warning"]);
    expect(parsed.formFactor).toBe("desktop");
  });

  it("defaults missing top-level fields without throwing", () => {
    const parsed = parseLhr({}, "mobile");
    expect(parsed.requestedUrl).toBe("");
    expect(parsed.finalUrl).toBe("");
    expect(parsed.runWarnings).toEqual([]);
    expect(parsed.opportunities).toEqual([]);
    // Every metric id present and null.
    expect(parsed.metrics.interactive).toBeNull();
  });
});
