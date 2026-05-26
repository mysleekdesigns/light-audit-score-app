/**
 * Unit tests for `robots.ts` — parsing precedence + best-effort fetch.
 * Hermetic: the global `fetch` is stubbed; no real network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRobots, parseRobots, ROBOTS_USER_AGENT } from "@/lib/crawl/robots";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseRobots — grouping + user-agent selection", () => {
  it("allows everything when there are no rules", () => {
    const m = parseRobots("# just a comment\n");
    expect(m.isAllowed("/anything")).toBe(true);
    expect(m.sitemaps).toEqual([]);
  });

  it("applies the wildcard group when no UA-specific group exists", () => {
    const m = parseRobots("User-agent: *\nDisallow: /private\n");
    expect(m.isAllowed("/private/x")).toBe(false);
    expect(m.isAllowed("/public")).toBe(true);
  });

  it("prefers the UA-specific group over the wildcard group", () => {
    const text = [
      "User-agent: *",
      "Disallow: /",
      "",
      `User-agent: ${ROBOTS_USER_AGENT}`,
      "Allow: /",
      "Disallow: /admin",
    ].join("\n");
    const m = parseRobots(text);
    // Wildcard blocks everything, but our UA group allows root and only blocks /admin.
    expect(m.isAllowed("/")).toBe(true);
    expect(m.isAllowed("/page")).toBe(true);
    expect(m.isAllowed("/admin/settings")).toBe(false);
  });

  it("treats an empty Disallow as 'allow all' within a group", () => {
    const m = parseRobots("User-agent: *\nDisallow:\n");
    expect(m.isAllowed("/anything")).toBe(true);
  });
});

describe("parseRobots — precedence (longest match, Allow wins on tie)", () => {
  it("uses the longest matching rule", () => {
    const text = [
      "User-agent: *",
      "Disallow: /a",
      "Allow: /a/b",
    ].join("\n");
    const m = parseRobots(text);
    expect(m.isAllowed("/a/x")).toBe(false); // only /a matches
    expect(m.isAllowed("/a/b/c")).toBe(true); // /a/b is longer + allows
  });

  it("lets Allow win when an Allow and Disallow tie on length", () => {
    const text = ["User-agent: *", "Disallow: /page", "Allow: /page"].join("\n");
    const m = parseRobots(text);
    expect(m.isAllowed("/page")).toBe(true);
  });

  it("honours the $ end-of-path anchor", () => {
    const text = ["User-agent: *", "Disallow: /*.pdf$"].join("\n");
    const m = parseRobots(text);
    expect(m.isAllowed("/file.pdf")).toBe(false);
    expect(m.isAllowed("/file.pdf?x=1")).toBe(true); // anchored, query breaks the match
    expect(m.isAllowed("/page.html")).toBe(true);
  });

  it("honours the * wildcard mid-pattern", () => {
    const text = ["User-agent: *", "Disallow: /*/private"].join("\n");
    const m = parseRobots(text);
    expect(m.isAllowed("/a/private")).toBe(false);
    expect(m.isAllowed("/a/b/private")).toBe(false);
    expect(m.isAllowed("/a/public")).toBe(true);
  });
});

describe("parseRobots — sitemaps", () => {
  it("collects Sitemap directives regardless of group, deduped + in order", () => {
    const text = [
      "Sitemap: https://example.com/sitemap.xml",
      "User-agent: *",
      "Disallow: /x",
      "Sitemap: https://example.com/news.xml",
      "Sitemap: https://example.com/sitemap.xml",
    ].join("\n");
    const m = parseRobots(text);
    expect(m.sitemaps).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/news.xml",
    ]);
  });
});

describe("fetchRobots — best-effort", () => {
  it("parses a 200 robots.txt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("User-agent: *\nDisallow: /no\n", { status: 200 }),
      ),
    );
    const m = await fetchRobots("https://example.com");
    expect(m.isAllowed("/no/x")).toBe(false);
    expect(m.isAllowed("/yes")).toBe(true);
  });

  it("allows all on a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const m = await fetchRobots("https://example.com");
    expect(m.isAllowed("/anything")).toBe(true);
    expect(m.sitemaps).toEqual([]);
  });

  it("allows all when fetch throws (network error/timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const m = await fetchRobots("https://example.com");
    expect(m.isAllowed("/anything")).toBe(true);
  });

  it("requests /robots.txt at the origin", async () => {
    let requested: string | undefined;
    const fetchMock = vi.fn((url: string) => {
      requested = url;
      return Promise.resolve(new Response("", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchRobots("https://example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requested).toBe("https://example.com/robots.txt");
  });
});
