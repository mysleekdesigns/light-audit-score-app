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
  MAX_EXCLUDE_PATH_LENGTH,
  MAX_EXCLUDE_PATHS,
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
      excludePaths: [],
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
    const result = parseDiscoverBody({
      url: "https://example.com",
      maxPages: MAX_PAGES + 1,
    });
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

describe("parseDiscoverBody — excludePaths", () => {
  it("defaults excludePaths to [] when omitted", () => {
    const result = parseDiscoverBody({ url: "https://example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.excludePaths).toEqual([]);
  });

  it("passes valid patterns through, trimmed", () => {
    const result = parseDiscoverBody({
      url: "https://example.com",
      excludePaths: ["  /blog  ", "/admin/*", "*.pdf"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.excludePaths).toEqual(["/blog", "/admin/*", "*.pdf"]);
  });

  it("rejects an empty/whitespace-only entry with an issue on the excludePaths path", () => {
    const result = parseDiscoverBody({
      url: "https://example.com",
      excludePaths: ["/blog", "   "],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.startsWith("excludePaths"))).toBe(
      true,
    );
  });

  it("rejects more than MAX_EXCLUDE_PATHS entries", () => {
    const result = parseDiscoverBody({
      url: "https://example.com",
      excludePaths: Array.from(
        { length: MAX_EXCLUDE_PATHS + 1 },
        (_, i) => `/p${i}`,
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.startsWith("excludePaths"))).toBe(
      true,
    );
  });

  it("rejects an over-length entry", () => {
    const result = parseDiscoverBody({
      url: "https://example.com",
      excludePaths: [`/${"a".repeat(MAX_EXCLUDE_PATH_LENGTH + 1)}`],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.startsWith("excludePaths"))).toBe(
      true,
    );
  });

  it("rejects a non-string entry", () => {
    const result = parseDiscoverBody({
      url: "https://example.com",
      excludePaths: [123],
    });
    expect(result.ok).toBe(false);
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

describe("seed URLs with embedded credentials", () => {
  // Mirrors `audits-schema`: discovery must not accept a credential it would
  // then persist in the audit it feeds (ROADMAP Phase B).
  it("rejects a seed URL carrying userinfo", () => {
    const result = parseDiscoverBody({ url: "https://staging:hunter2@example.com/" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/must not embed a username/i);
  });

  it("still accepts an ordinary seed URL", () => {
    expect(parseDiscoverBody({ url: "https://example.com/" }).ok).toBe(true);
  });
});
