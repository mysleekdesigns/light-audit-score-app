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
 *  - Everything is filtered to the seed's **origin** (protocol+host+port).
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
import type {
  DiscoveredUrl,
  DiscoverInput,
  DiscoverResult,
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

/** Normalize a seed URL to its origin (e.g. `https://example.com`). */
function toOrigin(url: string): string {
  return new URL(url).origin;
}

/**
 * Normalize a URL for dedupe: drop the hash fragment, keep everything else.
 * Returns `null` if it doesn't parse or isn't http/https.
 */
function normalizeUrl(raw: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  return parsed.toString();
}

/** Same-origin test: identical protocol + host + port. */
function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** The pathname + search of a URL, used for robots matching. */
function pathForRobots(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Fetch a page as HTML text, or `null` (non-200, non-HTML, error, timeout). */
async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": ROBOTS_USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    // Only parse HTML; skip PDFs, images, JSON, etc.
    if (!contentType.includes("text/html")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract same-origin, http(s) `<a href>` targets from HTML (normalized, deduped). */
function extractLinks(html: string, baseUrl: string, origin: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const normalized = normalizeUrl(href, baseUrl);
    if (!normalized) return;
    if (!isSameOrigin(normalized, origin)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  });
  return out;
}

/**
 * Run a shallow BFS crawl from the seed. Returns crawl-sourced URLs (with the
 * depth first found), appending any non-fatal notes to `warnings`. Bounded by
 * `maxDepth`, `maxPages` (collection budget), {@link MAX_CRAWL_FETCHES}, robots,
 * and same-origin.
 */
async function crawl(
  seed: string,
  origin: string,
  maxDepth: number,
  collectBudget: number,
  robots: RobotsMatcher,
  warnings: string[],
): Promise<DiscoveredUrl[]> {
  const found = new Map<string, DiscoveredUrl>();
  const enqueued = new Set<string>();
  const queue: { url: string; depth: number }[] = [];

  const seedNorm = normalizeUrl(seed);
  if (seedNorm) {
    queue.push({ url: seedNorm, depth: 0 });
    enqueued.add(seedNorm);
  }

  let fetches = 0;
  let robotsSkipped = 0;

  while (queue.length > 0) {
    if (fetches >= MAX_CRAWL_FETCHES) break;
    if (found.size >= collectBudget) break;

    const { url, depth } = queue.shift()!;

    // Record the page itself (seed included) as a discovered URL.
    if (!found.has(url)) {
      found.set(url, { url, source: "crawl", depth });
    }

    // Only expand (fetch + parse) while within the depth bound.
    if (depth >= maxDepth) continue;

    const html = await fetchHtml(url);
    fetches++;
    if (html === null) {
      warnings.push(`Could not fetch page for crawl: ${url}`);
      continue;
    }

    for (const link of extractLinks(html, url, origin)) {
      if (enqueued.has(link)) continue;
      // Honour robots for paths we'd fetch/follow.
      if (!robots.isAllowed(pathForRobots(link))) {
        robotsSkipped++;
        continue;
      }
      enqueued.add(link);
      queue.push({ url: link, depth: depth + 1 });
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
  const origin = toOrigin(input.url);

  // robots.txt drives crawl politeness and may declare sitemaps.
  const robots = await fetchRobots(origin);

  const seedPath = pathForRobots(input.url);
  const robotsBlocked = !robots.isAllowed(seedPath);

  // Collect by source; dedupe across sources afterwards (first source wins).
  const collected: DiscoveredUrl[] = [];
  const seen = new Set<string>();

  function add(url: string, source: DiscoveredUrl["source"], depth?: number) {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    if (!isSameOrigin(normalized, origin)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    collected.push(
      source === "crawl"
        ? { url: normalized, source, depth }
        : { url: normalized, source },
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
    const sameOrigin = sitemapUrls.filter((u) => isSameOrigin(u, origin));
    if (sameOrigin.length === 0) {
      warnings.push("No URLs found in sitemap.");
    }
    for (const u of sameOrigin) add(u, "sitemap");
  }

  // --- Crawl (skipped entirely if robots disallows the seed) ----------------
  if (input.useCrawl) {
    if (robotsBlocked) {
      warnings.push(
        "robots.txt disallows crawling the seed URL; skipped the crawl.",
      );
    } else {
      const crawled = await crawl(
        input.url,
        origin,
        input.maxDepth,
        MAX_CRAWL_FETCHES,
        robots,
        warnings,
      );
      for (const item of crawled) add(item.url, "crawl", item.depth);
    }
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
