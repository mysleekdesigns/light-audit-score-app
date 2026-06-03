/**
 * Unit tests for the pure analysis logic: LHR → bounded input (`extract.ts`),
 * the serialized prompt (`buildPrompt.ts`), and SSE-frame parsing
 * (`parseAnalysisSseFrame` in the client). No SDK / network involved.
 */

import { describe, expect, it } from "vitest";

import type { LighthouseResult } from "@/lib/lighthouse/types";
import { parseAnalysisSseFrame } from "@/lib/client/auditClient";
import { buildAnalysisInput } from "@/lib/analysis/extract";
import { buildUserPrompt } from "@/lib/analysis/buildPrompt";
import { FIXES_OPEN } from "@/lib/analysis/types";

/** A small synthetic LHR exercising performance + seo categories. */
const LHR: LighthouseResult = {
  requestedUrl: "https://example.com/",
  finalDisplayedUrl: "https://example.com/",
  lighthouseVersion: "13.0.0",
  fetchTime: "2026-01-01T00:00:00.000Z",
  configSettings: { formFactor: "mobile" },
  categories: {
    performance: {
      id: "performance",
      score: 0.55,
      auditRefs: [
        { id: "largest-contentful-paint", weight: 25 },
        { id: "uses-responsive-images", weight: 0, group: "diagnostics" },
      ],
    },
    seo: {
      id: "seo",
      score: 0.8,
      auditRefs: [
        { id: "document-title", weight: 1 },
        { id: "meta-description", weight: 1 },
      ],
    },
  },
  audits: {
    "largest-contentful-paint": {
      id: "largest-contentful-paint",
      title: "Largest Contentful Paint",
      score: 0.4,
      scoreDisplayMode: "numeric",
      numericValue: 4200,
      displayValue: "4.2 s",
    },
    "uses-responsive-images": {
      id: "uses-responsive-images",
      title: "Properly size images",
      description: "Serve images that are appropriately-sized.",
      score: 0.3,
      scoreDisplayMode: "metricSavings",
      displayValue: "Est savings of 1,000 ms",
      details: {
        type: "opportunity",
        overallSavingsMs: 1000,
        items: [{ url: "https://example.com/big.png" }],
      },
    },
    "document-title": {
      id: "document-title",
      title: "Document has a <title> element",
      score: 1,
      scoreDisplayMode: "binary",
      displayValue: "",
    },
    "meta-description": {
      id: "meta-description",
      title: "Document does not have a meta description",
      description: "Meta descriptions improve SEO.",
      score: 0,
      scoreDisplayMode: "binary",
      displayValue: "",
      details: { type: "table", items: [{ node: { selector: "head" } }] },
    },
  },
};

describe("buildAnalysisInput", () => {
  it("summarizes performance via metrics + opportunities", () => {
    const input = buildAnalysisInput({
      lhr: LHR,
      category: "performance",
      formFactor: "mobile",
    });

    expect(input.categoryScore).toBe(55);
    expect(input.metrics?.some((m) => m.abbr === "LCP" && m.displayValue === "4.2 s")).toBe(
      true,
    );
    expect(input.opportunities?.some((o) => o.title === "Properly size images")).toBe(true);
    // Non-performance projections are absent for performance.
    expect(input.audits).toBeUndefined();
  });

  it("summarizes non-performance categories via their failing audits", () => {
    const input = buildAnalysisInput({ lhr: LHR, category: "seo", formFactor: "mobile" });

    expect(input.categoryScore).toBe(80);
    const ids = (input.audits ?? []).map((a) => a.id);
    // The failing meta-description is surfaced; the passing document-title is dropped.
    expect(ids).toContain("meta-description");
    expect(ids).not.toContain("document-title");
    const meta = input.audits?.find((a) => a.id === "meta-description");
    expect(meta?.failed).toBe(true);
    expect(meta?.examples).toContain("head");
  });
});

describe("buildUserPrompt", () => {
  it("renders the score and findings into the prompt", () => {
    const input = buildAnalysisInput({
      lhr: LHR,
      category: "performance",
      formFactor: "mobile",
    });
    const prompt = buildUserPrompt(input);

    expect(prompt).toContain("Performance score: 55 / 100");
    expect(prompt).toContain("Properly size images");
    expect(prompt).toContain(FIXES_OPEN);
  });
});

describe("parseAnalysisSseFrame", () => {
  it("parses a well-formed frame's data payload", () => {
    const frame = `event: text-delta\ndata: ${JSON.stringify({
      type: "text-delta",
      delta: "Hello",
    })}`;
    expect(parseAnalysisSseFrame(frame)).toEqual({ type: "text-delta", delta: "Hello" });
  });

  it("returns null for frames without a data line", () => {
    expect(parseAnalysisSseFrame("event: ping")).toBeNull();
    expect(parseAnalysisSseFrame("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseAnalysisSseFrame("data: {not json}")).toBeNull();
  });
});
