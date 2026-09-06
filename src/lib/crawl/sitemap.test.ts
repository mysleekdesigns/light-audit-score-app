/**
 * Unit tests for `sitemap.ts` — XML parsing, index recursion, bounding.
 * Hermetic: the global `fetch` is stubbed; no real network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  gatherSitemapUrls,
  MAX_SITEMAPS,
  parseSitemapXml,
} from "@/lib/crawl/sitemap";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a urlset XML body from loc strings. */
function urlset(...locs: string[]): string {
  const body = locs.map((l) => `<url><loc>${l}</loc></url>`).join("");
  return `<?xml version="1.0"?><urlset>${body}</urlset>`;
}

/** Build a sitemapindex XML body from child sitemap loc strings. */
function sitemapindex(...locs: string[]): string {
  const body = locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("");
  return `<?xml version="1.0"?><sitemapindex>${body}</sitemapindex>`;
}

describe("parseSitemapXml", () => {
  it("parses a urlset with multiple entries", () => {
    const parsed = parseSitemapXml(
      urlset("https://a.com/", "https://a.com/b"),
    );
    expect(parsed.urls).toEqual(["https://a.com/", "https://a.com/b"]);
    expect(parsed.childSitemaps).toEqual([]);
  });

  it("parses a urlset with a single entry (object, not array)", () => {
    const parsed = parseSitemapXml(urlset("https://a.com/only"));
    expect(parsed.urls).toEqual(["https://a.com/only"]);
  });

  it("parses a sitemap index into child sitemaps", () => {
    const parsed = parseSitemapXml(
      sitemapindex("https://a.com/s1.xml", "https://a.com/s2.xml"),
    );
    expect(parsed.urls).toEqual([]);
    expect(parsed.childSitemaps).toEqual([
      "https://a.com/s1.xml",
      "https://a.com/s2.xml",
    ]);
  });

  it("returns empty arrays for malformed XML", () => {
    const parsed = parseSitemapXml("<<<not xml>>>");
    expect(parsed.urls).toEqual([]);
    expect(parsed.childSitemaps).toEqual([]);
  });

  it("returns empty arrays for an unknown root element", () => {
    const parsed = parseSitemapXml("<rss><channel></channel></rss>");
    expect(parsed.urls).toEqual([]);
    expect(parsed.childSitemaps).toEqual([]);
  });
});

describe("gatherSitemapUrls — recursion + bounding", () => {
  it("follows a sitemap index into its child urlsets", async () => {
    const responses: Record<string, string> = {
      "https://a.com/sitemap.xml": sitemapindex(
        "https://a.com/s1.xml",
        "https://a.com/s2.xml",
      ),
      "https://a.com/s1.xml": urlset("https://a.com/1", "https://a.com/2"),
      "https://a.com/s2.xml": urlset("https://a.com/3"),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = responses[String(url)];
        return body
          ? new Response(body, { status: 200 })
          : new Response("", { status: 404 });
      }),
    );
    const urls = await gatherSitemapUrls(["https://a.com/sitemap.xml"]);
    expect(urls).toEqual([
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });

  it("dedupes URLs across child sitemaps", async () => {
    const responses: Record<string, string> = {
      "https://a.com/index.xml": sitemapindex(
        "https://a.com/s1.xml",
        "https://a.com/s2.xml",
      ),
      "https://a.com/s1.xml": urlset("https://a.com/dup", "https://a.com/x"),
      "https://a.com/s2.xml": urlset("https://a.com/dup", "https://a.com/y"),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(responses[String(url)] ?? "", { status: 200 }),
      ),
    );
    const urls = await gatherSitemapUrls(["https://a.com/index.xml"]);
    expect(urls).toEqual([
      "https://a.com/dup",
      "https://a.com/x",
      "https://a.com/y",
    ]);
  });

  it("stops once maxUrls is reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          urlset(
            "https://a.com/1",
            "https://a.com/2",
            "https://a.com/3",
            "https://a.com/4",
          ),
          { status: 200 },
        ),
      ),
    );
    const urls = await gatherSitemapUrls(["https://a.com/sitemap.xml"], {
      maxUrls: 2,
    });
    expect(urls).toEqual(["https://a.com/1", "https://a.com/2"]);
  });

  it("caps the number of sitemap documents fetched", async () => {
    // A pathological index pointing at MAX_SITEMAPS + 10 children, each a urlset.
    const children = Array.from(
      { length: MAX_SITEMAPS + 10 },
      (_, i) => `https://a.com/s${i}.xml`,
    );
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.endsWith("index.xml")) {
        return new Response(sitemapindex(...children), { status: 200 });
      }
      return new Response(urlset(`${s}#page`), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await gatherSitemapUrls(["https://a.com/index.xml"]);
    // index doc + leaf docs, never exceeding MAX_SITEMAPS total fetches.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(MAX_SITEMAPS);
  });

  it("ignores documents that fail to fetch (non-200) without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("good.xml")
          ? new Response(urlset("https://a.com/ok"), { status: 200 })
          : new Response("", { status: 500 }),
      ),
    );
    const urls = await gatherSitemapUrls([
      "https://a.com/bad.xml",
      "https://a.com/good.xml",
    ]);
    expect(urls).toEqual(["https://a.com/ok"]);
  });

  it("returns [] when every fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const urls = await gatherSitemapUrls(["https://a.com/sitemap.xml"]);
    expect(urls).toEqual([]);
  });
});

describe("gatherSitemapUrls — credentials (ROADMAP Phase B)", () => {
  const SAME_SITE = "https://a.com";
  const CROSS_SITE = "https://cdn.example.net";
  const CREDENTIAL = { Authorization: "Basic dGVzdA==" };

  /** Serve `responses` by URL, recording the init of every call. */
  function stubFetch(responses: Record<string, string>) {
    const fetchMock = vi.fn<
      (input: string, init?: RequestInit) => Promise<Response>
    >(async (input) =>
      new Response(responses[String(input)] ?? "", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** Headers the stub was asked to send for `url`. */
  function headersFor(
    fetchMock: ReturnType<typeof stubFetch>,
    url: string,
  ): Record<string, string> | undefined {
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === url);
    return call?.[1]?.headers as Record<string, string> | undefined;
  }

  it("credentials same-site documents and withholds from cross-site children", async () => {
    // The URLs here are declared by the SITE (robots.txt / a sitemap index),
    // not derived from the seed, so each one is gated individually.
    const fetchMock = stubFetch({
      [`${SAME_SITE}/index.xml`]: sitemapindex(
        `${SAME_SITE}/s1.xml`,
        `${CROSS_SITE}/s2.xml`,
      ),
      [`${SAME_SITE}/s1.xml`]: urlset(`${SAME_SITE}/1`),
      [`${CROSS_SITE}/s2.xml`]: urlset(`${SAME_SITE}/2`),
    });

    const urls = await gatherSitemapUrls([`${SAME_SITE}/index.xml`], {
      resolveCredentials: (url) =>
        url.startsWith(`${SAME_SITE}/`) ? CREDENTIAL : undefined,
    });

    expect(headersFor(fetchMock, `${SAME_SITE}/index.xml`)).toEqual({
      "user-agent": "LighthouseAuditBot",
      ...CREDENTIAL,
    });
    expect(headersFor(fetchMock, `${SAME_SITE}/s1.xml`)).toEqual({
      "user-agent": "LighthouseAuditBot",
      ...CREDENTIAL,
    });
    // A CDN-hosted sitemap for a protected site is ordinary — read it, but
    // never hand it the credential.
    expect(headersFor(fetchMock, `${CROSS_SITE}/s2.xml`)).toEqual({
      "user-agent": "LighthouseAuditBot",
    });
    expect(urls).toEqual([`${SAME_SITE}/1`, `${SAME_SITE}/2`]);
  });

  it("makes the unchanged request when no resolver is supplied", async () => {
    const fetchMock = stubFetch({
      [`${SAME_SITE}/sitemap.xml`]: urlset(`${SAME_SITE}/1`),
    });
    await gatherSitemapUrls([`${SAME_SITE}/sitemap.xml`]);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers).toEqual({ "user-agent": "LighthouseAuditBot" });
    expect(init?.redirect).toBe("follow");
  });
});
