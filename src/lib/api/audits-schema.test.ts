import { describe, expect, it } from "vitest";

import { MAX_URLS, parseCreateBatchBody } from "@/lib/api/audits-schema";
import { DEFAULT_OPTIONS } from "@/lib/lighthouse/options";
import { LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
} from "@/lib/queue/types";

describe("parseCreateBatchBody — valid bodies", () => {
  it("resolves a minimal body with options + concurrency defaults applied", () => {
    const result = parseCreateBatchBody({ urls: ["https://example.com"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      urls: ["https://example.com"],
      options: DEFAULT_OPTIONS,
      concurrency: DEFAULT_CONCURRENCY,
    });
  });

  it("accepts http and https URLs", () => {
    const result = parseCreateBatchBody({
      urls: ["http://example.com", "https://example.org/path?q=1"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.urls).toEqual([
      "http://example.com",
      "https://example.org/path?q=1",
    ]);
  });

  it("trims whitespace around URLs", () => {
    const result = parseCreateBatchBody({ urls: ["  https://example.com  "] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.urls).toEqual(["https://example.com"]);
  });

  it("validates and defaults provided options via auditOptionsSchema", () => {
    const result = parseCreateBatchBody({
      urls: ["https://example.com"],
      options: { formFactor: "desktop" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options).toEqual({
      formFactor: "desktop",
      throttling: "simulated",
      categories: [...LIGHTHOUSE_CATEGORIES],
      runs: 3,
    });
  });

  it("applies all option defaults when options is omitted", () => {
    const result = parseCreateBatchBody({ urls: ["https://example.com"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options).toEqual(DEFAULT_OPTIONS);
  });

  it("accepts exactly MAX_URLS entries", () => {
    const urls = Array.from(
      { length: MAX_URLS },
      (_, i) => `https://example.com/${i}`,
    );
    const result = parseCreateBatchBody({ urls });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.urls).toHaveLength(MAX_URLS);
  });
});

describe("parseCreateBatchBody — concurrency clamping", () => {
  it("clamps above MAX_CONCURRENCY down to MAX_CONCURRENCY", () => {
    const result = parseCreateBatchBody({
      urls: ["https://example.com"],
      concurrency: 999,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.concurrency).toBe(MAX_CONCURRENCY);
  });

  it("clamps below MIN_CONCURRENCY up to MIN_CONCURRENCY", () => {
    const result = parseCreateBatchBody({
      urls: ["https://example.com"],
      concurrency: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.concurrency).toBe(MIN_CONCURRENCY);
  });

  it("floors a fractional concurrency", () => {
    const result = parseCreateBatchBody({
      urls: ["https://example.com"],
      concurrency: 4.9,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.concurrency).toBe(4);
  });

  it("keeps an in-band concurrency unchanged", () => {
    const result = parseCreateBatchBody({
      urls: ["https://example.com"],
      concurrency: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.concurrency).toBe(5);
  });
});

describe("parseCreateBatchBody — rejected bodies", () => {
  it("rejects an empty urls array", () => {
    const result = parseCreateBatchBody({ urls: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].path).toBe("urls");
  });

  it("rejects a missing urls field", () => {
    const result = parseCreateBatchBody({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "urls")).toBe(true);
  });

  it("rejects a non-http(s) protocol (ftp)", () => {
    const result = parseCreateBatchBody({ urls: ["ftp://example.com"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe("urls.0");
    expect(result.issues[0].message).toMatch(/http/i);
  });

  it("rejects a javascript: protocol", () => {
    const result = parseCreateBatchBody({ urls: ["javascript:alert(1)"] });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-URL string", () => {
    const result = parseCreateBatchBody({ urls: ["not a url"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe("urls.0");
  });

  it("rejects more than MAX_URLS entries", () => {
    const urls = Array.from(
      { length: MAX_URLS + 1 },
      (_, i) => `https://example.com/${i}`,
    );
    const result = parseCreateBatchBody({ urls });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "urls")).toBe(true);
  });

  it("rejects invalid options (bad category) and reports the path", () => {
    const result = parseCreateBatchBody({
      urls: ["https://example.com"],
      options: { categories: ["pwa"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path.startsWith("options"))).toBe(true);
  });

  it("rejects a non-numeric concurrency", () => {
    const result = parseCreateBatchBody({
      urls: ["https://example.com"],
      concurrency: "fast",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "concurrency")).toBe(true);
  });

  it("rejects a non-object body without throwing", () => {
    expect(() => parseCreateBatchBody("nonsense")).not.toThrow();
    expect(parseCreateBatchBody("nonsense").ok).toBe(false);
  });
});
