/**
 * Unit tests for `schema.ts` — body validation into a resolved DiscoverInput.
 * Pure + synchronous; no network.
 */

import { describe, expect, it } from "vitest";

import { parseDiscoverBody } from "@/lib/crawl/schema";
import {
  DEFAULT_DEPTH,
  DEFAULT_PAGES,
  DEFAULT_USE_CRAWL,
  DEFAULT_USE_SITEMAP,
  MAX_DEPTH,
  MAX_PAGES,
  MIN_DEPTH,
  MIN_PAGES,
} from "@/lib/crawl/types";

describe("parseDiscoverBody — valid bodies", () => {
  it("resolves a minimal body with all defaults applied", () => {
    const result = parseDiscoverBody({ url: "https://example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      url: "https://example.com",
      useSitemap: DEFAULT_USE_SITEMAP,
      useCrawl: DEFAULT_USE_CRAWL,
      maxDepth: DEFAULT_DEPTH,
      maxPages: DEFAULT_PAGES,
    });
  });

  it("accepts http and https and trims the URL", () => {
    const result = parseDiscoverBody({ url: "  http://example.org/path  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe("http://example.org/path");
  });

  it("honours explicit toggles", () => {
    const result = parseDiscoverBody({
      url: "https://example.com",
      useSitemap: false,
      useCrawl: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.useSitemap).toBe(false);
    expect(result.value.useCrawl).toBe(true);
  });
});

describe("parseDiscoverBody — bounds clamping", () => {
  it("clamps maxDepth above MAX_DEPTH down", () => {
    const result = parseDiscoverBody({ url: "https://example.com", maxDepth: 99 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxDepth).toBe(MAX_DEPTH);
  });

  it("clamps maxDepth below MIN_DEPTH up", () => {
    const result = parseDiscoverBody({ url: "https://example.com", maxDepth: -5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxDepth).toBe(MIN_DEPTH);
  });

  it("floors a fractional maxDepth", () => {
    const result = parseDiscoverBody({ url: "https://example.com", maxDepth: 2.9 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxDepth).toBe(2);
  });

  it("clamps maxPages above MAX_PAGES down", () => {
    const result = parseDiscoverBody({ url: "https://example.com", maxPages: 9999 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxPages).toBe(MAX_PAGES);
  });

  it("clamps maxPages below MIN_PAGES up", () => {
    const result = parseDiscoverBody({ url: "https://example.com", maxPages: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxPages).toBe(MIN_PAGES);
  });
});

describe("parseDiscoverBody — rejected bodies", () => {
  it("rejects a missing url", () => {
    const result = parseDiscoverBody({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "url")).toBe(true);
  });

  it("rejects a non-http(s) protocol (ftp)", () => {
    const result = parseDiscoverBody({ url: "ftp://example.com" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe("url");
    expect(result.issues[0].message).toMatch(/http/i);
  });

  it("rejects a javascript: protocol", () => {
    const result = parseDiscoverBody({ url: "javascript:alert(1)" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-URL string", () => {
    const result = parseDiscoverBody({ url: "not a url" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe("url");
  });

  it("rejects a non-boolean toggle", () => {
    const result = parseDiscoverBody({
      url: "https://example.com",
      useSitemap: "yes",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "useSitemap")).toBe(true);
  });

  it("rejects a non-numeric maxDepth", () => {
    const result = parseDiscoverBody({
      url: "https://example.com",
      maxDepth: "deep",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "maxDepth")).toBe(true);
  });

  it("does not throw on a non-object body", () => {
    expect(() => parseDiscoverBody("nonsense")).not.toThrow();
    expect(parseDiscoverBody("nonsense").ok).toBe(false);
  });
});
