/**
 * Sitemap fetching + parsing for the discovery engine (PRD §6 Phase 5).
 *
 * A site's `sitemap.xml` is the cheapest, most authoritative source of URLs:
 * the owner has explicitly listed them. This module fetches and parses sitemaps
 * (via `fast-xml-parser`), transparently following a *sitemap index*
 * (`<sitemapindex>` of child `<sitemap><loc>` entries) into the leaf
 * `<urlset><url><loc>` documents.
 *
 * Bounding is essential — a sitemap index can fan out to thousands of child
 * sitemaps. We therefore cap:
 *  - the total number of sitemap documents fetched ({@link MAX_SITEMAPS}), and
 *  - stop early once we've gathered the caller's requested URL budget.
 *
 * Resilience: any fetch failure, non-200, non-XML body, or malformed XML for a
 * given document yields `[]` for that document (never throws); the caller
 * decides whether the empty overall result warrants a warning. URLs are
 * returned as absolute strings exactly as declared (the orchestrator filters
 * same-origin + normalizes).
 */

import { XMLParser } from "fast-xml-parser";

import {
  credentialedFetch,
  type CredentialHeaderResolver,
} from "./credentialedFetch";

/** Hard cap on sitemap documents fetched in one discovery run (index + leaves). */
export const MAX_SITEMAPS = 20;

/** Per-request fetch timeout (ms). */
const SITEMAP_FETCH_TIMEOUT_MS = 10_000;

/** A loc string can come back as a string, number, or object depending on XML. */
type LocValue = unknown;

/** One parser instance, reused across calls (cheap + stateless for our use). */
const parser = new XMLParser({
  ignoreAttributes: true,
  // Coerce nothing fancy; we only read <loc> text.
  trimValues: true,
});

/** Extract a usable URL string from a `<loc>` node value, or `null`. */
function locToString(loc: LocValue): string | null {
  if (typeof loc === "string") return loc.trim() || null;
  if (typeof loc === "number") return String(loc);
  // fast-xml-parser can wrap text in objects when attributes/namespaces appear.
  if (loc && typeof loc === "object" && "#text" in loc) {
    const text = (loc as { "#text": unknown })["#text"];
    if (typeof text === "string") return text.trim() || null;
    if (typeof text === "number") return String(text);
  }
  return null;
}

/** Normalize fast-xml-parser's "object for one, array for many" into an array. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Parsed shape of the two sitemap document kinds we understand. */
interface ParsedSitemap {
  /** `<urlset>` leaf entries: page URLs. */
  urls: string[];
  /** `<sitemapindex>` child sitemap URLs to recurse into. */
  childSitemaps: string[];
}

/**
 * Parse a sitemap XML string into its page URLs and child-sitemap URLs.
 * Tolerates malformed/empty input by returning empty arrays.
 */
export function parseSitemapXml(xml: string): ParsedSitemap {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return { urls: [], childSitemaps: [] };
  }
  if (!doc || typeof doc !== "object") return { urls: [], childSitemaps: [] };

  const root = doc as Record<string, unknown>;

  // Sitemap index: <sitemapindex><sitemap><loc>…</loc></sitemap>…
  const index = root.sitemapindex as Record<string, unknown> | undefined;
  if (index && typeof index === "object") {
    const entries = asArray(index.sitemap as unknown);
    const childSitemaps: string[] = [];
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        const loc = locToString((entry as Record<string, unknown>).loc);
        if (loc) childSitemaps.push(loc);
      }
    }
    return { urls: [], childSitemaps };
  }

  // URL set: <urlset><url><loc>…</loc></url>…
  const urlset = root.urlset as Record<string, unknown> | undefined;
  if (urlset && typeof urlset === "object") {
    const entries = asArray(urlset.url as unknown);
    const urls: string[] = [];
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        const loc = locToString((entry as Record<string, unknown>).loc);
        if (loc) urls.push(loc);
      }
    }
    return { urls, childSitemaps: [] };
  }

  return { urls: [], childSitemaps: [] };
}

/** Fetch one sitemap document's text. Best-effort: returns `null` on any failure. */
async function fetchSitemapText(
  url: string,
  resolveCredentials?: CredentialHeaderResolver,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEMAP_FETCH_TIMEOUT_MS);
  try {
    const res = await credentialedFetch(
      url,
      {
        signal: controller.signal,
        headers: { "user-agent": "LighthouseAuditBot" },
      },
      resolveCredentials,
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Options bounding {@link gatherSitemapUrls}. */
export interface GatherSitemapOptions {
  /** Stop gathering once this many URLs are collected (defaults to {@link MAX_SITEMAPS}-derived budget). */
  maxUrls?: number;
  /** Hard cap on documents fetched (defaults to {@link MAX_SITEMAPS}). */
  maxSitemaps?: number;
  /**
   * Per-URL credential decision (ROADMAP Phase B), so a protected site's
   * sitemap can be read with the audit credential.
   *
   * This is the one place in discovery where the URLs being fetched are
   * *declared by the site*, not derived from the seed: the seeds come from
   * `robots.txt` `Sitemap:` lines and the children from a `<sitemapindex>`, both
   * of which may name any absolute URL at all. Every document URL is therefore
   * passed to the resolver individually, and one that points off-site is fetched
   * without the credential rather than skipped — a public CDN-hosted sitemap for
   * a protected site is a perfectly ordinary arrangement.
   */
  resolveCredentials?: CredentialHeaderResolver;
}

/**
 * Gather page URLs from one or more seed sitemap URLs, following sitemap-index
 * documents (breadth-first) up to the document and URL caps. Deduped by exact
 * string. Never throws; failed/empty documents simply contribute nothing.
 */
export async function gatherSitemapUrls(
  seedSitemaps: string[],
  options: GatherSitemapOptions = {},
): Promise<string[]> {
  const maxSitemaps = options.maxSitemaps ?? MAX_SITEMAPS;
  const maxUrls = options.maxUrls ?? Number.POSITIVE_INFINITY;

  const queue: string[] = [...seedSitemaps];
  const visited = new Set<string>();
  const seenUrls = new Set<string>();
  const urls: string[] = [];
  let fetched = 0;

  while (queue.length > 0 && fetched < maxSitemaps && urls.length < maxUrls) {
    const next = queue.shift();
    if (next === undefined || visited.has(next)) continue;
    visited.add(next);

    const text = await fetchSitemapText(next, options.resolveCredentials);
    fetched++;
    if (text === null) continue;

    const { urls: pageUrls, childSitemaps } = parseSitemapXml(text);

    for (const u of pageUrls) {
      if (urls.length >= maxUrls) break;
      if (!seenUrls.has(u)) {
        seenUrls.add(u);
        urls.push(u);
      }
    }

    // Enqueue children we haven't seen; the document cap bounds the recursion.
    for (const child of childSitemaps) {
      if (!visited.has(child)) queue.push(child);
    }
  }

  return urls;
}
