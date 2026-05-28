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

  it("trailing /* also excludes the bare parent (DWIM section exclude)", () => {
    const matcher = compileExcludePathMatcher(["/events/*"]);
    // The user's expected behaviour: "everything under /events" includes
    // the section root itself, not just its sub-paths.
    expect(matcher("/events")).toBe(true);
    expect(matcher("/events/")).toBe(true);
    expect(matcher("/events/summer-tour")).toBe(true);
    // But cleanly bounded at the slash — must not match sibling names.
    expect(matcher("/eventsplanner")).toBe(false);
    expect(matcher("/about")).toBe(false);
  });

  it("nested trailing /* excludes the nested parent only", () => {
    const matcher = compileExcludePathMatcher(["/foo/bar/*"]);
    expect(matcher("/foo/bar")).toBe(true);
    expect(matcher("/foo/bar/baz")).toBe(true);
    // /foo by itself is unaffected — only /foo/bar is the section root.
    expect(matcher("/foo")).toBe(false);
    expect(matcher("/foo/barbarian")).toBe(false);
  });

  it("does NOT apply the parent-prefix DWIM to non-directory globs", () => {
    // `*.pdf` has no `/*` ending → strict glob, no parent inferred.
    const matcher = compileExcludePathMatcher(["*.pdf"]);
    expect(matcher("/report.pdf")).toBe(true);
    expect(matcher("/")).toBe(false);
    expect(matcher("/anything")).toBe(false);
  });

  it("prefix is bounded at /: /blog must not match /blogger", () => {
    const matcher = compileExcludePathMatcher(["/blog"]);
    expect(matcher("/blog")).toBe(true);
    expect(matcher("/blog/")).toBe(true);
    expect(matcher("/blog/post-1")).toBe(true);
    // Critical: these previously matched via raw startsWith — they must not.
    expect(matcher("/blogger")).toBe(false);
    expect(matcher("/blog-archive")).toBe(false);
  });

  it("strips a trailing slash from prefix patterns (still matches sub-paths)", () => {
    const matcher = compileExcludePathMatcher(["/blog/"]);
    expect(matcher("/blog")).toBe(true);
    expect(matcher("/blog/")).toBe(true);
    expect(matcher("/blog/post")).toBe(true);
    expect(matcher("/blogger")).toBe(false);
  });

  it("a bare / pattern still excludes everything (escape hatch preserved)", () => {
    const matcher = compileExcludePathMatcher(["/"]);
    expect(matcher("/")).toBe(true);
    expect(matcher("/anything")).toBe(true);
    expect(matcher("/deep/nested/path")).toBe(true);
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

  it("a /section/* exclude drops the bare section root from the sitemap", async () => {
    // Mirrors the user's example.com setup: the sitemap lists section roots
    // (/events, /clubs, …) AND their sub-pages; the user types `/events/*`
    // expecting BOTH to be dropped.
    stubRoutes({
      [`${ORIGIN}/sitemap.xml`]: SITEMAP_XML(
        `${ORIGIN}/events`,
        `${ORIGIN}/events/summer-tour`,
        `${ORIGIN}/clubs`,
        `${ORIGIN}/clubs/downtown`,
        `${ORIGIN}/about`, // kept
      ),
    });
    const result = await discover(
      input({
        useSitemap: true,
        excludePaths: ["/events/*", "/clubs/*"],
      }),
    );
    const urls = result.urls.map((u) => u.url);
    expect(urls).toEqual([`${ORIGIN}/about`]);
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

describe("discover — apex ↔ www same-site", () => {
  const APEX = "https://example.com";
  const WWW = "https://www.example.com";

  it("treats www and apex variants as the same site (apex seed)", async () => {
    stubRoutes({
      // Apex seed redirects nowhere in the test runtime (Response.url is "");
      // we exercise the host-rewriting path via the sitemap.
      [`${APEX}/`]: page(),
      [`${APEX}/sitemap.xml`]: SITEMAP_XML(
        `${WWW}/a`,
        `${WWW}/b`,
        `https://blog.example.com/x`, // different subdomain → still filtered out
      ),
    });
    const result = await discover(
      input({ url: `${APEX}/`, useSitemap: true }),
    );
    // www URLs are accepted AND rewritten to the apex host (canonical form).
    expect(result.urls.map((u) => u.url)).toEqual([
      `${APEX}/a`,
      `${APEX}/b`,
    ]);
    expect(result.urls.every((u) => u.source === "sitemap")).toBe(true);
    // blog. subdomain is NOT a www variant → stays filtered out.
    expect(result.urls.some((u) => u.url.includes("blog."))).toBe(false);
    expect(result.warnings.some((w) => /no urls found/i.test(w))).toBe(false);
  });

  it("dedupes apex and www variants of the same path into one entry", async () => {
    stubRoutes({
      [`${APEX}/sitemap.xml`]: SITEMAP_XML(`${APEX}/shared`, `${WWW}/shared`),
    });
    const result = await discover(
      input({ url: `${APEX}/`, useSitemap: true }),
    );
    expect(result.urls.map((u) => u.url)).toEqual([`${APEX}/shared`]);
  });

  it("does not treat a non-www subdomain as same-site", async () => {
    stubRoutes({
      [`${APEX}/sitemap.xml`]: SITEMAP_XML(
        `https://shop.example.com/x`,
        `https://cdn.example.com/y`,
        `${WWW}/keep`,
      ),
    });
    const result = await discover(
      input({ url: `${APEX}/`, useSitemap: true }),
    );
    expect(result.urls.map((u) => u.url)).toEqual([`${APEX}/keep`]);
  });

  it("rewrites absolute www links found while crawling an apex seed", async () => {
    stubRoutes({
      // The seed page mixes a relative apex link with an absolute www link —
      // a common Next.js / canonicalized-URL pattern. Both should be kept
      // and stored under the seed's host.
      [`${APEX}/`]: page(`/about`, `${WWW}/blog`),
      [`${APEX}/about`]: page(),
      [`${APEX}/blog`]: page(),
    });
    const result = await discover(
      input({ url: `${APEX}/`, useCrawl: true, maxDepth: 1 }),
    );
    const urls = result.urls.map((u) => u.url);
    expect(urls).toContain(`${APEX}/about`);
    // www absolute link kept, but rewritten to the apex host.
    expect(urls).toContain(`${APEX}/blog`);
    expect(urls.some((u) => u.startsWith(WWW))).toBe(false);
  });
});

describe("discover — seed redirect resolution", () => {
  it("uses the post-redirect origin as canonical (apex → www)", async () => {
    const APEX = "https://example.com";
    const WWW = "https://www.example.com";

    // `Response.url` is read-only and not settable via constructor; we patch
    // it per-response with Object.defineProperty so resolveSeed sees the
    // post-redirect URL it would see in real `fetch()`.
    function withUrl(res: Response, url: string): Response {
      Object.defineProperty(res, "url", { value: url, configurable: true });
      return res;
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const requested = String(input);
        // The seed under apex "redirects" to www — Response.url reflects the
        // final URL after the redirect.
        if (requested === `${APEX}/`) {
          return withUrl(
            new Response("<html></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
            `${WWW}/`,
          );
        }
        if (requested === `${WWW}/robots.txt`) {
          return new Response(`Sitemap: ${WWW}/sitemap.xml`, { status: 200 });
        }
        if (requested === `${WWW}/sitemap.xml`) {
          return new Response(SITEMAP_XML(`${WWW}/a`, `${WWW}/b`).body, {
            status: 200,
            headers: { "content-type": "application/xml" },
          });
        }
        // Default robots.txt for anything else → empty (allow all).
        if (requested.endsWith("/robots.txt"))
          return new Response("", { status: 200 });
        return new Response("", { status: 404 });
      }),
    );

    const result = await discover(
      input({ url: `${APEX}/`, useSitemap: true, useCrawl: false }),
    );
    // The canonical origin is the post-redirect www host; sitemap URLs are
    // kept and presented under that canonical host.
    expect(result.origin).toBe(WWW);
    expect(result.urls.map((u) => u.url)).toEqual([
      `${WWW}/a`,
      `${WWW}/b`,
    ]);
    expect(result.warnings.some((w) => /no urls found/i.test(w))).toBe(false);
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
