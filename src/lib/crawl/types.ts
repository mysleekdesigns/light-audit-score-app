/**
 * Shared contract for site discovery — sitemap + shallow crawl (PRD §6 Phase 5).
 *
 * This is the stable seam both sides of Phase 5 code against:
 *  - the engine (`discover.ts`, driven by `sitemap.ts` + `robots.ts`) implements
 *    {@link discover}-shaped behaviour and returns a {@link DiscoverResult};
 *  - the zod schema (`schema.ts`) validates a raw request body into a resolved
 *    {@link DiscoverInput} (bounds clamped, toggles defaulted);
 *  - the API route (`/api/discover`) and the browser client (`crawlClient.ts`)
 *    exchange {@link DiscoverRequest} → {@link DiscoverResult}.
 *
 * Discovery is server-side only (arbitrary cross-origin fetches + robots.txt),
 * but this file is import-safe everywhere: keep it free of node:*, cheerio,
 * fast-xml-parser, zod and Next imports so client UI can share the types.
 */

// --- Bounds & defaults (mirror the queue's clamp-everything discipline) -----

/** BFS depth: the seed page is depth 0; each link followed adds 1. */
export const MIN_DEPTH = 0;
/** Hard ceiling on crawl depth — keep discovery shallow per PRD §6 Phase 5. */
export const MAX_DEPTH = 4;
/** Default crawl depth. */
export const DEFAULT_DEPTH = 2;

/**
 * Max pages a discovery run may return. Capped at 50 to match the batch's
 * `MAX_URLS` (`@/lib/api/audits-schema`) so a fully-selected discovery set can
 * always be submitted to `POST /api/audits` without tripping its limit.
 */
export const MIN_PAGES = 1;
export const MAX_PAGES = 50;
/** Default page cap. */
export const DEFAULT_PAGES = 25;

/** Sitemap parsing on by default. */
export const DEFAULT_USE_SITEMAP = true;
/** Shallow BFS crawl on by default. */
export const DEFAULT_USE_CRAWL = true;

/** Clamp an arbitrary number into the allowed depth band (floored to int). */
export function clampDepth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DEPTH;
  return Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.floor(n)));
}

/** Clamp an arbitrary number into the allowed page-cap band (floored to int). */
export function clampPages(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PAGES;
  return Math.min(MAX_PAGES, Math.max(MIN_PAGES, Math.floor(n)));
}

// --- Request / resolved-input shapes ---------------------------------------

/**
 * Client-facing discovery request (pre-validation). `url` is the seed/origin;
 * the rest are optional and resolved to defaults by the schema. The browser
 * client (`crawlClient.ts`) sends this; the route validates it into a
 * {@link DiscoverInput}.
 */
export interface DiscoverRequest {
  /** Seed URL — an absolute http/https URL. Discovery stays same-origin to it. */
  url: string;
  /** Parse `sitemap.xml` (+ sitemap index). Defaults to {@link DEFAULT_USE_SITEMAP}. */
  useSitemap?: boolean;
  /** Run a shallow same-origin BFS crawl from the seed. Defaults to {@link DEFAULT_USE_CRAWL}. */
  useCrawl?: boolean;
  /** Max BFS depth (seed = 0). Clamped to [{@link MIN_DEPTH}, {@link MAX_DEPTH}]. */
  maxDepth?: number;
  /** Max pages to return. Clamped to [{@link MIN_PAGES}, {@link MAX_PAGES}]. */
  maxPages?: number;
}

/**
 * Fully-resolved discovery options consumed by the engine. This is the output
 * type of the zod schema in `schema.ts` (which MUST keep a compile-time
 * assertion that its inferred output satisfies this contract, mirroring
 * `@/lib/lighthouse/options`). Every field is present and within bounds.
 */
export interface DiscoverInput {
  url: string;
  useSitemap: boolean;
  useCrawl: boolean;
  maxDepth: number;
  maxPages: number;
}

// --- Result shape -----------------------------------------------------------

/** How a URL was discovered. */
export type DiscoverySource = "sitemap" | "crawl";

/** A single discovered URL with provenance. */
export interface DiscoveredUrl {
  /** Absolute, normalized http/https URL (same origin as the seed). */
  url: string;
  /** Whether it came from the sitemap or the crawl (first source wins on dedupe). */
  source: DiscoverySource;
  /** BFS depth it was first found at (0 = seed). Present for crawl-sourced URLs. */
  depth?: number;
}

/**
 * Result of a discovery run. `urls` is deduped (by normalized URL), same-origin,
 * and capped at the resolved `maxPages`. Discovery is best-effort: a missing
 * sitemap or a blocked path is a `warning`, not an error.
 */
export interface DiscoverResult {
  /** Normalized origin discovery was scoped to (e.g. `https://example.com`). */
  origin: string;
  /** Discovered URLs, deduped + capped at `maxPages`, in discovery order. */
  urls: DiscoveredUrl[];
  /** Count discovered before the `maxPages` cap was applied (≥ `urls.length`). */
  totalFound: number;
  /** True when `robots.txt` disallowed crawling the seed itself. */
  robotsBlocked: boolean;
  /** Non-fatal notes (no sitemap, fetch failures, robots-skipped paths, cap hit). */
  warnings: string[];
}
