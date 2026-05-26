import { describe, it, expect } from "vitest";

import { parseUrls } from "@/lib/parseUrls";

describe("parseUrls", () => {
  it("returns empty result for empty input", () => {
    expect(parseUrls("")).toEqual({ urls: [], invalid: [] });
  });

  it("parses newline-separated URLs", () => {
    const result = parseUrls(
      "https://example.com\nhttps://example.com/pricing\nhttps://example.com/blog",
    );
    expect(result.urls).toEqual([
      "https://example.com",
      "https://example.com/pricing",
      "https://example.com/blog",
    ]);
    expect(result.invalid).toEqual([]);
  });

  it("parses comma-separated URLs", () => {
    const result = parseUrls("https://a.com, https://b.com,https://c.com");
    expect(result.urls).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
    expect(result.invalid).toEqual([]);
  });

  it("parses mixed newline + comma input", () => {
    const result = parseUrls(
      "https://a.com, https://b.com\nhttps://c.com,https://d.com",
    );
    expect(result.urls).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
      "https://d.com",
    ]);
    expect(result.invalid).toEqual([]);
  });

  it("skips blank lines and empty comma tokens", () => {
    const result = parseUrls(
      "\nhttps://a.com\n\n  \nhttps://b.com,,\n,https://c.com,",
    );
    expect(result.urls).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
    expect(result.invalid).toEqual([]);
  });

  it("trims surrounding whitespace from each token", () => {
    const result = parseUrls("   https://a.com   \n\thttps://b.com\t");
    expect(result.urls).toEqual(["https://a.com", "https://b.com"]);
    expect(result.invalid).toEqual([]);
  });

  it("dedupes while preserving first-seen order", () => {
    const result = parseUrls(
      "https://a.com\nhttps://b.com\nhttps://a.com\nhttps://c.com\nhttps://b.com",
    );
    expect(result.urls).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
    expect(result.invalid).toEqual([]);
  });

  it("accepts both http and https", () => {
    const result = parseUrls("http://insecure.com\nhttps://secure.com");
    expect(result.urls).toEqual(["http://insecure.com", "https://secure.com"]);
    expect(result.invalid).toEqual([]);
  });

  it("rejects non-absolute and non-http(s) tokens with correct line numbers", () => {
    const result = parseUrls(
      "https://good.com\nftp://files.com\njavascript:alert(1)\nnotaurl\nexample.com",
    );
    expect(result.urls).toEqual(["https://good.com"]);
    expect(result.invalid).toEqual([
      { line: 2, value: "ftp://files.com" },
      { line: 3, value: "javascript:alert(1)" },
      { line: 4, value: "notaurl" },
      { line: 5, value: "example.com" },
    ]);
  });

  it("reports correct line numbers for invalid tokens within comma-joined lines", () => {
    const result = parseUrls("https://a.com, notaurl\nhttps://b.com,ftp://x.com");
    expect(result.urls).toEqual(["https://a.com", "https://b.com"]);
    expect(result.invalid).toEqual([
      { line: 1, value: "notaurl" },
      { line: 2, value: "ftp://x.com" },
    ]);
  });

  it("rejects a bare scheme-less host but accepts the same host with a scheme", () => {
    const result = parseUrls("example.com\nhttps://example.com");
    expect(result.urls).toEqual(["https://example.com"]);
    expect(result.invalid).toEqual([{ line: 1, value: "example.com" }]);
  });
});
