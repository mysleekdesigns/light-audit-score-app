/**
 * Site discovery orchestration (PRD §6 Phase 5).
 *
 * Given a validated {@link DiscoverInput} (a seed URL + bounded sitemap/crawl
 * toggles), produce a deduped, same-origin, capped list of candidate URLs the
 * user can feed straight into the audit batch. Two complementary sources:
 *
 *  1. **Sitemap** (`sitemap.ts`) — authoritative URLs declared by the owner,
 *     discovered via robots `Sitemap:` directives (falling back to
 *     `<origin>/sitemap.xml`). Cheap and broad; tagged `source: "sitemap"`.
 *  2. **Shallow BFS crawl** (`cheerio`) — follow same-origin `<a href>` links
 *     from the seed up to `maxDepth`. Catches pages not in the sitemap; tagged
 *     `source: "crawl"` with the depth first seen at.
 *
 * Politeness + safety are first-class:
 *  - Everything is filtered to the seed's **canonical origin**. We resolve the
 *    seed with one initial fetch (`redirect: "follow"`) so that an apex → www
 *    (or http → https) redirect picks the redirect target as authoritative,
 *    and we treat `host` and `www.host` as the same site so dedupe collapses
 *    the two host variants. All other subdomains stay strictly separate.
 *  - We honour `robots.txt`: if the seed itself is disallowed we set
 *    `robotsBlocked` and skip crawling entirely (we still read the sitemap,
 *    which the owner publishes deliberately). During the crawl, disallowed
 *    paths are skipped (and noted once).
 *  - Best-effort: individual fetch failures/timeouts become `warnings`, never
 *    throw. A per-request AbortController (~10s) plus hard fetch/URL caps mean a
 *    hostile or enormous site can't hang or balloon the run.
 *
 * Server-only (`fetch` arbitrary cross-origin + cheerio). `fetch` is a Node 24
 * global — used directly; no new dependencies.
 */

import * as cheerio from "cheerio";

import { fetchRobots, ROBOTS_USER_AGENT, type RobotsMatcher } from "./robots";
import { gatherSitemapUrls } from "./sitemap";
import {
  compileExcludePathMatcher,
  type DiscoveredUrl,
  type DiscoverInput,
  type DiscoverResult,
} from "./types";

/** Per-request fetch timeout (ms) for HTML page fetches during the crawl. */
const PAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Hard ceiling on HTML pages fetched during a crawl, independent of `maxPages`.
 * Generous slack over the page cap so BFS can discover more than it returns,
 * but still bounds work on a hostile/huge site.
 */
const MAX_CRAWL_FETCHES = 100;

/**
 * Cap on URLs collected from the sitemap before same-origin filtering + the
 * final `maxPages` cap. Bounds memory on enormous sitemaps.
 */
const MAX_SITEMAP_COLLECT = 500;

/** Drop a leading `www.` (case-insensitive) from a host. */
function stripWww(host: string): string {
  return host.replace(/^www\./i, "");
}

/**
 * Resolve `raw` (optionally against `base`) into the canonical URL string used
 * everywhere for filtering and dedupe, returning `null` if it's not http(s) or
 * not "same-site" with `origin`.
 *
 * "Same-site" is a deliberate, narrow relaxation of strict same-origin: same
 * protocol + port, and hosts that match after stripping a leading `www.` —
 * `example.com` and `www.example.com` are treated as the same site, but every
 * other subdomain (`blog.example.com`, `cdn.example.com`) stays separate. This
 * fixes the common case where a seed (`example.com`) redirects to `www` or
 * where the sitemap/canonical absolute links use the opposite variant.
 *
 * The hash fragment is dropped; the host is rewritten to `origin`'s host so
 * dedupe collapses `example.com/x` and `www.example.com/x` to a single entry.
 */
function canonicalize(
  raw: string,
  origin: string,
  base?: string,
): string | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol !== o.protocol) return null;
  if (u.port !== o.port) return null;
  if (stripWww(u.host) !== stripWww(o.host)) return null;
  u.hash = "";
  u.host = o.host;
  return u.toString();
}

/**
 * Lightweight normalization for the seed (no origin check yet — that happens
 * after we resolve the canonical origin via {@link resolveSeed}).
 */
function normalizeSeed(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  return parsed.toString();
}

/** The pathname + search of a URL, used for robots matching. */
function pathForRobots(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/**
 * One HTTP fetch + its final URL after redirects (empty string when the runtime
 * doesn't populate `Response.url`, e.g. our test stubs — callers fall back to
 * the requested URL in that case).
 */
interface FetchedPage {
  /** Final URL after redirects, or `""` if unavailable. */
  finalUrl: string;
  /** Response body as text, only when status is OK and content-type is HTML. */
  html: string | null;
}

/** Fetch a page following redirects; return its final URL and (if HTML) body. */
async function fetchHtml(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": ROBOTS_USER_AGENT },
      redirect: "follow",
    });
    const finalUrl = res.url || "";
    if (!res.ok) return { finalUrl, html: null };
    const contentType = res.headers.get("content-type") ?? "";
    // Only parse HTML; skip PDFs, images, JSON, etc.
    if (!contentType.includes("text/html")) return { finalUrl, html: null };
    return { finalUrl, html: await res.text() };
  } catch {
    return { finalUrl: "", html: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the seed URL into a canonical form by performing one initial fetch
 * (`redirect: "follow"`). This lets us choose the post-redirect origin as
 * authoritative, which handles the very common apex↔www / http↔https redirect
 * case (e.g. seed `https://example.com` → final `https://www.example.com/`).
 *
 * Best-effort: any failure (network error, timeout, non-OK, non-HTML) falls
 * back to the seed's own origin and a `null` html — discovery still proceeds.
 * The returned `html` is reused by the crawl to avoid a second seed fetch.
 */
async function resolveSeed(seed: string): Promise<{
  canonicalUrl: string;
  canonicalOrigin: string;
  html: string | null;
}> {
  const { finalUrl, html } = await fetchHtml(seed);
  const canonicalUrl = finalUrl || seed;
  let canonicalOrigin: string;
  try {
    canonicalOrigin = new URL(canonicalUrl).origin;
  } catch {
    canonicalOrigin = new URL(seed).origin;
  }
  return { canonicalUrl, canonicalOrigin, html };
}

/** Extract same-site, http(s) `<a href>` targets from HTML (canonicalized, deduped). */
function extractLinks(html: string, baseUrl: string, origin: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const canonical = canonicalize(href, origin, baseUrl);
    if (!canonical) return;
    if (seen.has(canonical)) return;
    seen.add(canonical);
    out.push(canonical);
  });
  return out;
}

/**
 * Run a shallow BFS crawl from the seed. Returns crawl-sourced URLs (with the
 * depth first found), appending any non-fatal notes to `warnings`. Bounded by
 * `maxDepth`, `maxPages` (collection budget), {@link MAX_CRAWL_FETCHES}, robots,
 * same-origin, and the caller's `isExcluded` predicate (excluded links are not
 * even followed, mirroring robots-disallowed links).
 */
async function crawl(
  seed: string,
  seedHtml: string | null,
  origin: string,
  maxDepth: number,
  collectBudget: number,
  robots: RobotsMatcher,
  isExcluded: (pathname: string) => boolean,
  warnings: string[],
): Promise<DiscoveredUrl[]> {
  const found = new Map<string, DiscoveredUrl>();
  const enqueued = new Set<string>();
  const queue: { url: string; depth: number; html: string | null }[] = [];

  const seedCanonical = canonicalize(seed, origin);
  if (seedCanonical) {
    queue.push({ url: seedCanonical, depth: 0, html: seedHtml });
    enqueued.add(seedCanonical);
  }

  let fetches = 0;
  let robotsSkipped = 0;

  while (queue.length > 0) {
    if (fetches >= MAX_CRAWL_FETCHES) break;
    if (found.size >= collectBudget) break;

    const { url, depth, html: cachedHtml } = queue.shift()!;

    // Record the page itself (seed included) as a discovered URL.
    if (!found.has(url)) {
      found.set(url, { url, source: "crawl", depth });
    }

    // Only expand (fetch + parse) while within the depth bound.
    if (depth >= maxDepth) continue;

    // Reuse the seed body from resolveSeed when available; otherwise fetch.
    // The base URL for link resolution is the page's final URL after redirects
    // (`finalUrl`), falling back to the requested URL when unavailable.
    let html: string | null;
    let baseUrl: string;
    if (cachedHtml !== null) {
      html = cachedHtml;
      baseUrl = url;
    } else {
      const fetched = await fetchHtml(url);
      fetches++;
      html = fetched.html;
      baseUrl = fetched.finalUrl || url;
    }
    if (html === null) {
      warnings.push(`Could not fetch page for crawl: ${url}`);
      continue;
    }

    for (const link of extractLinks(html, baseUrl, origin)) {
      if (enqueued.has(link)) continue;
      // Don't follow excluded links (the central `add` collector also drops
      // them, but skipping the fetch keeps the crawl cheap and on-budget).
      if (isExcluded(new URL(link).pathname)) continue;
      // Honour robots for paths we'd fetch/follow.
      if (!robots.isAllowed(pathForRobots(link))) {
        robotsSkipped++;
        continue;
      }
      enqueued.add(link);
      queue.push({ url: link, depth: depth + 1, html: null });
    }
  }

  if (robotsSkipped > 0) {
    warnings.push(
      `Skipped ${robotsSkipped} link(s) disallowed by robots.txt during crawl.`,
    );
  }

  return [...found.values()];
}

/**
 * Discover candidate URLs for a seed via sitemap and/or shallow crawl.
 * Always resolves (best-effort); failures surface as `warnings`.
 */
export async function discover(input: DiscoverInput): Promise<DiscoverResult> {
  const warnings: string[] = [];

  // Resolve the seed via one initial fetch so the canonical origin reflects any
  // redirect (e.g. apex → www, http → https). Defends against the common case
  // where the sitemap and canonical absolute links use a different host variant
  // than the user typed. Best-effort: failure falls back to the seed's origin.
  const seed = normalizeSeed(input.url) ?? input.url;
  const { canonicalUrl, canonicalOrigin, html: seedHtml } =
    await resolveSeed(seed);
  const origin = canonicalOrigin;

  // robots.txt drives crawl politeness and may declare sitemaps.
  const robots = await fetchRobots(origin);

  const seedPath = pathForRobots(canonicalUrl);
  const robotsBlocked = !robots.isAllowed(seedPath);

  // Single source of truth for exclude-path matching, applied to BOTH sources.
  const isExcluded = compileExcludePathMatcher(input.excludePaths);

  // Collect by source; dedupe across sources afterwards (first source wins).
  const collected: DiscoveredUrl[] = [];
  const seen = new Set<string>();
  let excludedCount = 0;

  function add(url: string, source: DiscoveredUrl["source"], depth?: number) {
    const canonical = canonicalize(url, origin);
    if (!canonical) return;
    if (seen.has(canonical)) return;
    // Single exclusion chokepoint: drop URLs matching the exclude patterns,
    // whatever their source. Marked seen so a later source can't re-add them.
    if (isExcluded(new URL(canonical).pathname)) {
      seen.add(canonical);
      excludedCount++;
      return;
    }
    seen.add(canonical);
    collected.push(
      source === "crawl"
        ? { url: canonical, source, depth }
        : { url: canonical, source },
    );
  }

  // --- Sitemap (owner-declared; allowed even when crawling is blocked) ------
  if (input.useSitemap) {
    const seeds =
      robots.sitemaps.length > 0
        ? robots.sitemaps
        : [`${origin}/sitemap.xml`];
    let sitemapUrls: string[] = [];
    try {
      sitemapUrls = await gatherSitemapUrls(seeds, {
        maxUrls: MAX_SITEMAP_COLLECT,
      });
    } catch {
      // gatherSitemapUrls is itself best-effort, but belt-and-suspenders.
      sitemapUrls = [];
    }
    const sameSite = sitemapUrls
      .map((u) => canonicalize(u, origin))
      .filter((u): u is string => u !== null);
    if (sameSite.length === 0) {
      warnings.push("No URLs found in sitemap.");
    }
    for (const u of sameSite) add(u, "sitemap");
  }

  // --- Crawl (skipped entirely if robots disallows the seed) ----------------
  if (input.useCrawl) {
    if (robotsBlocked) {
      warnings.push(
        "robots.txt disallows crawling the seed URL; skipped the crawl.",
      );
    } else {
      const crawled = await crawl(
        canonicalUrl,
        seedHtml,
        origin,
        input.maxDepth,
        MAX_CRAWL_FETCHES,
        robots,
        isExcluded,
        warnings,
      );
      for (const item of crawled) add(item.url, "crawl", item.depth);
    }
  }

  if (excludedCount > 0) {
    warnings.push(
      `Excluded ${excludedCount} URL(s) matching your exclude patterns.`,
    );
  }

  const totalFound = collected.length;
  const urls = collected.slice(0, input.maxPages);
  if (totalFound > urls.length) {
    warnings.push(
      `Found ${totalFound} URLs; truncated to the maximum of ${input.maxPages}.`,
    );
  }

  return { origin, urls, totalFound, robotsBlocked, warnings };
}
