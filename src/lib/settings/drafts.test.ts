import { describe, expect, it } from "vitest";

import { LIGHTHOUSE_CATEGORIES, MAX_RUNS, MIN_RUNS } from "@/lib/lighthouse/types";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MIN_CONCURRENCY } from "@/lib/queue/types";
import {
  EMPTY_PSI_FORM_DRAFT,
  EMPTY_TARGETS_DRAFT,
  normalizePsiFormDraft,
  normalizeTargetsDraft,
  PSI_LOCALE_DEFAULT,
  sanitizeCrawlDraft,
  type CrawlDraft,
  type PsiFormDraft,
  type TargetsDraft,
} from "@/lib/settings/drafts";

const crawl: CrawlDraft = {
  result: {
    origin: "https://example.com",
    urls: [
      { url: "https://example.com/", source: "sitemap" },
      { url: "https://example.com/blog", source: "crawl", depth: 1 },
    ],
    totalFound: 2,
    robotsBlocked: false,
    warnings: ["No sitemap.xml"],
  },
  selected: ["https://example.com/blog"],
};

describe("normalizeTargetsDraft", () => {
  it("returns the empty draft for garbage input", () => {
    for (const raw of [undefined, null, 42, "nope", [], {}]) {
      expect(normalizeTargetsDraft(raw)).toEqual(EMPTY_TARGETS_DRAFT);
    }
  });

  it("round-trips a valid draft through JSON", () => {
    const draft: TargetsDraft = {
      tab: "crawl",
      text: "https://a.example\nhttps://b.example",
      crawl,
      workspaceView: "discovered",
    };
    expect(normalizeTargetsDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  });

  it("whitelists the tab and workspace intent", () => {
    expect(normalizeTargetsDraft({ tab: "sitemap", workspaceView: "everything" })).toEqual(
      EMPTY_TARGETS_DRAFT,
    );
    expect(normalizeTargetsDraft({ workspaceView: "results" }).workspaceView).toBe("results");
  });

  it("drops a non-string text", () => {
    expect(normalizeTargetsDraft({ text: ["https://a.example"] }).text).toBe("");
  });
});

describe("sanitizeCrawlDraft", () => {
  it("returns null without a coherent result", () => {
    expect(sanitizeCrawlDraft(null)).toBeNull();
    expect(sanitizeCrawlDraft({ selected: [] })).toBeNull();
    expect(sanitizeCrawlDraft({ result: { origin: "x" } })).toBeNull();
    expect(sanitizeCrawlDraft({ result: { urls: [] } })).toBeNull();
  });

  it("drops unusable entries, collapses duplicates, and intersects the selection", () => {
    const out = sanitizeCrawlDraft({
      result: {
        origin: "https://example.com",
        urls: [
          { url: "https://example.com/", source: "sitemap" },
          { url: "https://example.com/", source: "crawl" }, // duplicate
          { url: "", source: "crawl" }, // empty
          { url: "https://example.com/x", source: "rss" }, // bad source
          "https://example.com/y", // not an object
          { url: "https://example.com/z", source: "crawl", depth: "2" }, // bad depth → dropped field
        ],
        totalFound: "many",
        warnings: ["ok", 7],
      },
      selected: ["https://example.com/", "https://example.com/x", 3],
    });
    expect(out).toEqual({
      result: {
        origin: "https://example.com",
        urls: [
          { url: "https://example.com/", source: "sitemap" },
          { url: "https://example.com/z", source: "crawl" },
        ],
        totalFound: 2,
        robotsBlocked: false,
        warnings: ["ok"],
      },
      selected: ["https://example.com/"],
    });
  });

  it("never reports fewer found than kept", () => {
    const out = sanitizeCrawlDraft({ ...crawl, result: { ...crawl.result, totalFound: 1 } });
    expect(out?.result.totalFound).toBe(2);
  });
});

describe("normalizePsiFormDraft", () => {
  it("returns the empty PSI draft for garbage input", () => {
    expect(normalizePsiFormDraft(undefined)).toEqual(EMPTY_PSI_FORM_DRAFT);
    expect(normalizePsiFormDraft("x")).toEqual(EMPTY_PSI_FORM_DRAFT);
  });

  it("round-trips a valid draft", () => {
    const draft: PsiFormDraft = {
      tab: "paste",
      text: "https://a.example",
      crawl: null,
      workspaceView: "results",
      device: "both",
      categories: ["performance", "seo"],
      locale: "pt_BR",
      runs: 5,
      concurrency: 2,
    };
    expect(normalizePsiFormDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  });

  it("clamps and whitelists every dial", () => {
    const out = normalizePsiFormDraft({
      device: "tablet",
      categories: ["seo", "bogus", "performance"],
      locale: "not a locale",
      runs: 99,
      concurrency: -4,
    });
    expect(out.device).toBe("mobile");
    expect(out.categories).toEqual(["performance", "seo"]); // canonical order
    expect(out.locale).toBe(PSI_LOCALE_DEFAULT);
    expect(out.runs).toBe(MAX_RUNS);
    expect(out.concurrency).toBe(MIN_CONCURRENCY);

    expect(normalizePsiFormDraft({ runs: 0 }).runs).toBe(MIN_RUNS);
    expect(normalizePsiFormDraft({ runs: 2.9 }).runs).toBe(2);
    expect(normalizePsiFormDraft({ concurrency: 500 }).concurrency).toBe(MAX_CONCURRENCY);
    expect(normalizePsiFormDraft({ concurrency: "3" }).concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(normalizePsiFormDraft({ categories: [] }).categories).toEqual([
      ...LIGHTHOUSE_CATEGORIES,
    ]);
  });

  it("accepts the locale shapes the form offers", () => {
    for (const locale of ["en_US", "en_GB", "es", "fr", "de", "pt_BR", "ja", "zh"]) {
      expect(normalizePsiFormDraft({ locale }).locale).toBe(locale);
    }
    expect(normalizePsiFormDraft({ locale: PSI_LOCALE_DEFAULT }).locale).toBe(PSI_LOCALE_DEFAULT);
  });
});
