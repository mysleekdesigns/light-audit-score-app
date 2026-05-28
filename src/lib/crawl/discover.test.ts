/**
 * Unit tests for `discover.ts` — orchestration of sitemap + crawl.
 *
 * Hermetic: the global `fetch` is stubbed with a small router keyed by URL that
 * serves robots.txt, sitemaps, and HTML pages. No real network, no Chrome.
 * Covers: sitemap source, same-origin filtering, robots disallow (seed +
 * in-crawl), maxDepth/maxPages bounds + cap warning, and dedupe across sources.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { discover } from "@/lib/crawl/discover";
import {
  compileExcludePathMatcher,
  type DiscoverInput,
} from "@/lib/crawl/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ORIGIN = "https://example.com";

/** A single canned response: HTML page, sitemap XML, or robots text. */
interface Route {
  status?: number;
  contentType?: string;
  body: string;
}

/**
 * Install a fetch stub that serves `routes` keyed by exact URL. Anything not in
 * the map returns 404. robots.txt defaults to allow-all if unspecified.
 */
function stubRoutes(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    const route = routes[url];
    if (!route) {
      // Default robots.txt → empty (allow all).
      if (url.endsWith("/robots.txt")) {
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 404 });
    }
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: {
        "content-type": route.contentType ?? "text/html; charset=utf-8",
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function input(overrides: Partial<DiscoverInput> = {}): DiscoverInput {
  return {
    url: `${ORIGIN}/`,
    useSitemap: false,
    useCrawl: false,
    maxDepth: 2,
    maxPages: 50,
    excludePaths: [],
    ...overrides,
  };
}

/** Build an HTML page that links to the given hrefs. */
function page(...hrefs: string[]): Route {
  const anchors = hrefs.map((h) => `<a href="${h}">link</a>`).join("");
  return { body: `<!doctype html><html><body>${anchors}</body></html>` };
}

const SITEMAP_XML = (...locs: string[]): Route => ({
  contentType: "application/xml",
  body: `<?xml version="1.0"?><urlset>${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join("")}</urlset>`,
});

describe("discover — sitemap source", () => {
  it("gathers same-origin sitemap URLs from <origin>/sitemap.xml", async () => {
    stubRoutes({
      [`${ORIGIN}/sitemap.xml`]: SITEMAP_XML(
        `${ORIGIN}/a`,
        `${ORIGIN}/b`,
        "https://other.com/x", // cross-origin → filtered out
      ),
    });
    const result = await discover(input({ useSitemap: true }));
    expect(result.origin).toBe(ORIGIN);
    expect(result.urls.map((u) => u.url)).toEqual([
      `${ORIGIN}/a`,
      `${ORIGIN}/b`,
    ]);
    expect(result.urls.every((u) => u.source === "sitemap")).toBe(true);
    expect(result.robotsBlocked).toBe(false);
  });

  it("uses Sitemap: URLs declared in robots.txt", async () => {
    stubRoutes({
      [`${ORIGIN}/robots.txt`]: {
        body: `Sitemap: ${ORIGIN}/custom-sitemap.xml`,
      },
      [`${ORIGIN}/custom-sitemap.xml`]: SITEMAP_XML(`${ORIGIN}/from-robots`),
    });
    const result = await discover(input({ useSitemap: true }));
    expect(result.urls.map((u) => u.url)).toEqual([`${ORIGIN}/from-robots`]);
  });

  it("warns when the sitemap yields no same-origin URLs", async () => {
    stubRoutes({
      [`${ORIGIN}/sitemap.xml`]: { status: 404, body: "" },
    });
    const result = await discover(input({ useSitemap: true }));
    expect(result.urls).toEqual([]);
    expect(result.warnings.some((w) => /no urls found/i.test(w))).toBe(true);
  });
});

describe("discover — crawl source", () => {
  it("performs a BFS crawl, tagging depth and staying same-origin", async () => {
    stubRoutes({
      [`${ORIGIN}/`]: page(`${ORIGIN}/a`, `${ORIGIN}/b`, "https://other.com/x"),
      [`${ORIGIN}/a`]: page(`${ORIGIN}/a/deep`),
      [`${ORIGIN}/b`]: page(),
    });
    const result = await discover(input({ useCrawl: true, maxDepth: 2 }));
    const byUrl = new Map(result.urls.map((u) => [u.url, u]));
    expect(byUrl.get(`${ORIGIN}/`)?.depth).toBe(0);
    expect(byUrl.get(`${ORIGIN}/a`)?.depth).toBe(1);
    expect(byUrl.get(`${ORIGIN}/b`)?.depth).toBe(1);
    expect(byUrl.get(`${ORIGIN}/a/deep`)?.depth).toBe(2);
    // Cross-origin link never appears.
    expect(result.urls.some((u) => u.url.includes("other.com"))).toBe(false);
    expect(result.urls.every((u) => u.source === "crawl")).toBe(true);
  });

  it("respects maxDepth (depth 0 fetches seed only, no links followed)", async () => {
    stubRoutes({
      [`${ORIGIN}/`]: page(`${ORIGIN}/a`),
      [`${ORIGIN}/a`]: page(`${ORIGIN}/a/deep`),
    });
    const result = await discover(input({ useCrawl: true, maxDepth: 0 }));
    // Only the seed is recorded; it's never expanded at depth 0.
    expect(result.urls.map((u) => u.url)).toEqual([`${ORIGIN}/`]);
  });

  it("dedupes the same page reached via multiple links (first depth wins)", async () => {
    stubRoutes({
      [`${ORIGIN}/`]: page(`${ORIGIN}/a`, `${ORIGIN}/b`),
      [`${ORIGIN}/a`]: page(`${ORIGIN}/shared`),
      [`${ORIGIN}/b`]: page(`${ORIGIN}/shared`),
    });
    const result = await discover(input({ useCrawl: true, maxDepth: 3 }));
    const shared = result.urls.filter((u) => u.url === `${ORIGIN}/shared`);
    expect(shared).toHaveLength(1);
    expect(shared[0].depth).toBe(2);
  });

  it("strips hash fragments when deduping crawled links", async () => {
    stubRoutes({
      [`${ORIGIN}/`]: page(`${ORIGIN}/a#one`, `${ORIGIN}/a#two`),
      [`${ORIGIN}/a`]: page(),
    });
    const result = await discover(input({ useCrawl: true, maxDepth: 1 }));
    expect(result.urls.filter((u) => u.url === `${ORIGIN}/a`)).toHaveLength(1);
  });
});

describe("discover — robots handling", () => {
  it("sets robotsBlocked and skips the crawl when the seed is disallowed", async () => {
    stubRoutes({
      [`${ORIGIN}/robots.txt`]: { body: "User-agent: *\nDisallow: /" },
      [`${ORIGIN}/`]: page(`${ORIGIN}/a`),
    });
    const result = await discover(input({ useCrawl: true }));
    expect(result.robotsBlocked).toBe(true);
    expect(result.urls).toEqual([]);
    expect(result.warnings.some((w) => /robots\.txt disallows/i.test(w))).toBe(
      true,
    );
  });

  it("still reads the sitemap even when crawling is robots-blocked", async () => {
    stubRoutes({
      [`${ORIGIN}/robots.txt`]: {
        body: `User-agent: *\nDisallow: /\nSitemap: ${ORIGIN}/sitemap.xml`,
      },
      [`${ORIGIN}/sitemap.xml`]: SITEMAP_XML(`${ORIGIN}/listed`),
    });
    const result = await discover(input({ useSitemap: true, useCrawl: true }));
    expect(result.robotsBlocked).toBe(true);
    expect(result.urls.map((u) => u.url)).toEqual([`${ORIGIN}/listed`]);
    expect(result.urls[0].source).toBe("sitemap");
  });

  it("skips robots-disallowed links during the crawl and warns", async () => {
    stubRoutes({
      [`${ORIGIN}/robots.txt`]: { body: "User-agent: *\nDisallow: /private" },
      [`${ORIGIN}/`]: page(`${ORIGIN}/ok`, `${ORIGIN}/private/secret`),
      [`${ORIGIN}/ok`]: page(),
    });
    const result = await discover(input({ useCrawl: true, maxDepth: 2 }));
    expect(result.urls.some((u) => u.url.includes("/private"))).toBe(false);
    expect(result.urls.some((u) => u.url === `${ORIGIN}/ok`)).toBe(true);
    expect(result.warnings.some((w) => /disallowed by robots/i.test(w))).toBe(
      true,
    );
  });
});

describe("discover — dedupe across sources + caps", () => {
  it("dedupes across sitemap and crawl (first source wins)", async () => {
    stubRoutes({
      [`${ORIGIN}/sitemap.xml`]: SITEMAP_XML(`${ORIGIN}/shared`, `${ORIGIN}/s-only`),
      [`${ORIGIN}/`]: page(`${ORIGIN}/shared`, `${ORIGIN}/c-only`),
      [`${ORIGIN}/shared`]: page(),
      [`${ORIGIN}/c-only`]: page(),
    });
    const result = await discover(
      input({ useSitemap: true, useCrawl: true, maxDepth: 1 }),
    );
    const shared = result.urls.filter((u) => u.url === `${ORIGIN}/shared`);
    expect(shared).toHaveLength(1);
    // Sitemap runs first, so the shared URL keeps source "sitemap".
    expect(shared[0].source).toBe("sitemap");
    expect(result.urls.some((u) => u.url === `${ORIGIN}/s-only`)).toBe(true);
    expect(result.urls.some((u) => u.url === `${ORIGIN}/c-only`)).toBe(true);
  });

  it("caps at maxPages, sets totalFound to the pre-cap count, and warns", async () => {
    stubRoutes({
      [`${ORIGIN}/sitemap.xml`]: SITEMAP_XML(
        `${ORIGIN}/1`,
        `${ORIGIN}/2`,
        `${ORIGIN}/3`,
        `${ORIGIN}/4`,
        `${ORIGIN}/5`,
      ),
    });
    const result = await discover(input({ useSitemap: true, maxPages: 2 }));
    expect(result.totalFound).toBe(5);
    expect(result.urls).toHaveLength(2);
    expect(result.urls.map((u) => u.url)).toEqual([`${ORIGIN}/1`, `${ORIGIN}/2`]);
    expect(result.warnings.some((w) => /truncated/i.test(w))).toBe(true);
  });

  it("does not warn about truncation when under the cap", async () => {
    stubRoutes({
      [`${ORIGIN}/sitemap.xml`]: SITEMAP_XML(`${ORIGIN}/1`),
    });
    const result = await discover(input({ useSitemap: true, maxPages: 10 }));
    expect(result.totalFound).toBe(1);
    expect(result.warnings.some((w) => /truncated/i.test(w))).toBe(false);
  });
});

describe("compileExcludePathMatcher", () => {
  it("returns a predicate that is always false for empty patterns", () => {
    const matcher = compileExcludePathMatcher([]);
    expect(matcher("/")).toBe(false);
    expect(matcher("/anything")).toBe(false);
  });

  it("ignores blank/whitespace-only patterns (→ always false)", () => {
    const matcher = compileExcludePathMatcher(["", "   "]);
    expect(matcher("/blog")).toBe(false);
  });

  it("prefix-matches a pattern without a wildcard", () => {
    const matcher = compileExcludePathMatcher(["/blog"]);
    expect(matcher("/blog")).toBe(true);
    expect(matcher("/blog/")).toBe(true);
    expect(matcher("/blog/post-1")).toBe(true);
    expect(matcher("/about")).toBe(false);
  });

  it("normalizes a leading slash (pattern and pathname)", () => {
    const matcher = compileExcludePathMatcher(["blog"]);
    expect(matcher("/blog/post")).toBe(true);
    expect(matcher("blog/post")).toBe(true);
  });

  it("glob-matches /admin/* against any sub-path", () => {
    const matcher = compileExcludePathMatcher(["/admin/*"]);
    expect(matcher("/admin/users")).toBe(true);
    expect(matcher("/admin/deep/nested")).toBe(true);
    expect(matcher("/public")).toBe(false);
  });

  it("glob-matches *.pdf as a suffix anchored at both ends", () => {
    const matcher = compileExcludePathMatcher(["*.pdf"]);
    expect(matcher("/docs/report.pdf")).toBe(true);
    expect(matcher("/report.pdf")).toBe(true);
    expect(matcher("/report.pdf.html")).toBe(false);
    expect(matcher("/report.html")).toBe(false);
  });

  it("treats ? as a single-character wildcard", () => {
    const matcher = compileExcludePathMatcher(["/page-?"]);
    expect(matcher("/page-1")).toBe(true);
    expect(matcher("/page-12")).toBe(false);
  });

  it("is case-sensitive", () => {
    const matcher = compileExcludePathMatcher(["/Blog"]);
    expect(matcher("/Blog")).toBe(true);
    expect(matcher("/blog")).toBe(false);
  });

  it("escapes regex metacharacters in non-wildcard portions", () => {
    const matcher = compileExcludePathMatcher(["/a.b*"]);
    expect(matcher("/a.b/c")).toBe(true);
    expect(matcher("/axb/c")).toBe(false);
  });
});

describe("discover — exclude paths", () => {
  it("omits matching URLs from BOTH sitemap and crawl, keeping the rest", async () => {
    stubRoutes({
      [`${ORIGIN}/sitemap.xml`]: SITEMAP_XML(
        `${ORIGIN}/admin/dashboard`, // crawl: excluded by /admin/*
        `${ORIGIN}/about`, // kept
      ),
      [`${ORIGIN}/`]: page(`${ORIGIN}/blog/post-1`, `${ORIGIN}/contact`),
      [`${ORIGIN}/contact`]: page(),
    });
    const result = await discover(
      input({
        useSitemap: true,
        useCrawl: true,
        maxDepth: 1,
        excludePaths: ["/admin/*", "/blog"],
      }),
    );
    const urls = result.urls.map((u) => u.url);
    // Sitemap-sourced excluded URL is gone; sitemap-sourced kept URL remains.
    expect(urls).not.toContain(`${ORIGIN}/admin/dashboard`);
    expect(urls).toContain(`${ORIGIN}/about`);
    // Crawl-sourced excluded link (the /blog prefix) is gone; sibling remains.
    expect(urls.some((u) => u.includes("/blog"))).toBe(false);
    expect(urls).toContain(`${ORIGIN}/contact`);
    // One summarizing warning is pushed.
    expect(
      result.warnings.some((w) => /excluded \d+ url\(s\)/i.test(w)),
    ).toBe(true);
  });

  it("does not warn about exclusions when nothing matches", async () => {
    stubRoutes({
      [`${ORIGIN}/sitemap.xml`]: SITEMAP_XML(`${ORIGIN}/about`),
    });
    const result = await discover(
      input({ useSitemap: true, excludePaths: ["/admin/*"] }),
    );
    expect(result.urls.map((u) => u.url)).toEqual([`${ORIGIN}/about`]);
    expect(result.warnings.some((w) => /excluded/i.test(w))).toBe(false);
  });
});

describe("discover — resilience", () => {
  it("turns page fetch failures into warnings without throwing", async () => {
    stubRoutes({
      [`${ORIGIN}/`]: page(`${ORIGIN}/broken`),
      [`${ORIGIN}/broken`]: { status: 500, body: "" },
    });
    const result = await discover(input({ useCrawl: true, maxDepth: 2 }));
    // The seed is still recorded; broken child is recorded as a URL but its
    // fetch (to expand) failed → warning.
    expect(result.urls.some((u) => u.url === `${ORIGIN}/`)).toBe(true);
    expect(result.warnings.some((w) => /could not fetch/i.test(w))).toBe(true);
  });

  it("skips non-HTML pages (does not parse them for links)", async () => {
    stubRoutes({
      [`${ORIGIN}/`]: {
        contentType: "application/pdf",
        body: "%PDF-1.4 binary",
      },
    });
    const result = await discover(input({ useCrawl: true, maxDepth: 2 }));
    // Seed still recorded as a candidate, but no links extracted from non-HTML.
    expect(result.urls.map((u) => u.url)).toEqual([`${ORIGIN}/`]);
  });
});
