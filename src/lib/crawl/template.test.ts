/**
 * Unit tests for `template.ts` — URL-template inference + per-template sampling.
 * Pure + synchronous; no network.
 */

import { describe, expect, it } from "vitest";

import {
  clampPagesPerTemplate,
  inferTemplate,
  PAGES_PER_TEMPLATE_ALL,
  samplePerTemplate,
} from "@/lib/crawl/template";
import { MAX_PAGES, type DiscoveredUrl } from "@/lib/crawl/types";

/** Build a discovered-URL list (source is irrelevant to sampling). */
function urls(...list: string[]): DiscoveredUrl[] {
  return list.map((url) => ({ url, source: "sitemap" }));
}

describe("inferTemplate", () => {
  it("treats the home page as its own template", () => {
    expect(inferTemplate("https://example.com")).toBe("/");
    expect(inferTemplate("https://example.com/")).toBe("/");
  });

  it("keeps distinct top-level pages separate", () => {
    expect(inferTemplate("https://example.com/about")).toBe("/about");
    expect(inferTemplate("https://example.com/contact")).toBe("/contact");
  });

  it("collapses the leaf slug of a detail page to '*'", () => {
    expect(inferTemplate("https://example.com/products/red-shoe")).toBe(
      "/products/*",
    );
    expect(inferTemplate("https://example.com/products/blue-hat")).toBe(
      "/products/*",
    );
  });

  it("groups numeric-id and slug detail pages under the same template", () => {
    expect(inferTemplate("https://example.com/products/123")).toBe(
      "/products/*",
    );
    expect(inferTemplate("https://example.com/products/red-shoe")).toBe(
      "/products/*",
    );
  });

  it("normalizes a single numeric/uuid top-level segment to ':id'", () => {
    expect(inferTemplate("https://example.com/12345")).toBe("/:id");
    expect(
      inferTemplate("https://example.com/3f9a8b7c-1d2e-4f5a-9b8c-7d6e5f4a3b2c"),
    ).toBe("/:id");
  });

  it("collapses dated archive segments so different dates share a template", () => {
    expect(inferTemplate("https://example.com/blog/2024/01/launch")).toBe(
      "/blog/:id/:id/*",
    );
    expect(inferTemplate("https://example.com/blog/2024/02/another-post")).toBe(
      "/blog/:id/:id/*",
    );
  });

  it("keeps separate category subtrees distinct", () => {
    expect(inferTemplate("https://example.com/category/electronics/phones")).toBe(
      "/category/electronics/*",
    );
    expect(inferTemplate("https://example.com/category/books/novels")).toBe(
      "/category/books/*",
    );
  });

  it("ignores query string and hash", () => {
    expect(inferTemplate("https://example.com/p?id=1")).toBe("/p");
    expect(inferTemplate("https://example.com/p?id=2#section")).toBe("/p");
  });

  it("returns the raw string for unparseable input without throwing", () => {
    expect(inferTemplate("not a url")).toBe("not a url");
  });
});

describe("samplePerTemplate", () => {
  const discovered = urls(
    "https://example.com/", // template "/"
    "https://example.com/products/a", // "/products/*"
    "https://example.com/products/b", // "/products/*"
    "https://example.com/products/c", // "/products/*"
    "https://example.com/blog/x", // "/blog/*"
    "https://example.com/blog/y", // "/blog/*"
  );

  it("keeps every URL when n <= 0 (All)", () => {
    const all = samplePerTemplate(discovered, PAGES_PER_TEMPLATE_ALL);
    expect(all.size).toBe(discovered.length);
    for (const { url } of discovered) expect(all.has(url)).toBe(true);
  });

  it("caps each template at n, preserving discovery order", () => {
    const sampled = samplePerTemplate(discovered, 2);
    // "/" (1) + "/products/*" first 2 + "/blog/*" first 2 = 5
    expect([...sampled]).toEqual([
      "https://example.com/",
      "https://example.com/products/a",
      "https://example.com/products/b",
      "https://example.com/blog/x",
      "https://example.com/blog/y",
    ]);
    // The third product (over the cap) is dropped.
    expect(sampled.has("https://example.com/products/c")).toBe(false);
  });

  it("n = 1 keeps a single representative per template", () => {
    const sampled = samplePerTemplate(discovered, 1);
    expect([...sampled]).toEqual([
      "https://example.com/",
      "https://example.com/products/a",
      "https://example.com/blog/x",
    ]);
  });

  it("returns an empty set for an empty discovery", () => {
    expect(samplePerTemplate([], 3).size).toBe(0);
  });
});

describe("clampPagesPerTemplate", () => {
  it("passes valid counts through (floored)", () => {
    expect(clampPagesPerTemplate(3)).toBe(3);
    expect(clampPagesPerTemplate(2.9)).toBe(2);
  });

  it("treats 0 / negatives as All", () => {
    expect(clampPagesPerTemplate(0)).toBe(PAGES_PER_TEMPLATE_ALL);
    expect(clampPagesPerTemplate(-5)).toBe(0);
  });

  it("caps at MAX_PAGES", () => {
    expect(clampPagesPerTemplate(MAX_PAGES + 1000)).toBe(MAX_PAGES);
  });

  it("degrades non-numbers to All", () => {
    expect(clampPagesPerTemplate("3")).toBe(PAGES_PER_TEMPLATE_ALL);
    expect(clampPagesPerTemplate(undefined)).toBe(0);
    expect(clampPagesPerTemplate(NaN)).toBe(0);
  });
});
