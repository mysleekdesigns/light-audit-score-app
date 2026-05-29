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
 * Max pages a discovery run may return. Capped at 250 to match the batch's
 * `MAX_URLS` (`@/lib/api/audits-schema`) so a fully-selected discovery set can
 * always be submitted to `POST /api/audits` without tripping its limit.
 */
export const MIN_PAGES = 1;
export const MAX_PAGES = 250;
/** Default page cap. */
export const DEFAULT_PAGES = 25;

/** Sitemap parsing on by default. */
export const DEFAULT_USE_SITEMAP = true;
/** Shallow BFS crawl on by default. */
export const DEFAULT_USE_CRAWL = true;

/** Max number of exclude-path patterns a request may carry. */
export const MAX_EXCLUDE_PATHS = 50;
/** Max length (chars) of a single exclude-path pattern. */
export const MAX_EXCLUDE_PATH_LENGTH = 200;

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

// --- Exclude-path matching --------------------------------------------------

/** Regex-escape every character that is special in a JS RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a set of exclude-path patterns into a pure, total predicate over a
 * URL **pathname**. The returned function never throws and is the single source
 * of truth for "should this URL be excluded?" (used by both the BFS crawl and
 * the sitemap merge in `discover.ts`).
 *
 * Semantics (case-sensitive, matched against the pathname only):
 *  - Each pattern is trimmed; empty entries are ignored (validation lives in
 *    `schema.ts` — the matcher itself is tolerant so it can never throw).
 *  - A leading `/` is optional: `blog` and `/blog` are equivalent (both the
 *    pattern and the tested pathname are normalized to start with `/`).
 *  - A pattern WITHOUT a `*` or `?` is a **directory-prefix** match bounded at
 *    `/`: `/blog` excludes `/blog`, `/blog/`, and `/blog/post-1` — but NOT
 *    `/blogger` (the prefix must be followed by either end-of-string or `/`).
 *  - A pattern WITH `*` (or `?`) is a **glob** anchored at both ends. `*` is
 *    any run of characters, `?` is exactly one; all other regex metacharacters
 *    are escaped. e.g. `*.pdf` excludes any path ending `.pdf`. As a UX-driven
 *    extension, a trailing `/*` also excludes the bare parent: `/admin/*`
 *    excludes `/admin`, `/admin/`, AND `/admin/anything` (matching the typical
 *    user reading of "everything under this section").
 *  - When `patterns` is empty (after trimming), the predicate always returns
 *    `false`.
 */
export function compileExcludePathMatcher(
  patterns: string[],
): (pathname: string) => boolean {
  /** Normalize a pathname/pattern so it always starts with a single `/`. */
  const withLeadingSlash = (value: string): string =>
    value.startsWith("/") ? value : `/${value}`;

  /**
   * Drop a single trailing `/` so the directory-prefix check can simply append
   * `/` when looking for sub-paths (keeps `"/"` itself unchanged).
   */
  const stripTrailingSlash = (value: string): string =>
    value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;

  const prefixes: string[] = [];
  const globs: RegExp[] = [];

  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.includes("*") || trimmed.includes("?")) {
      const normalized = withLeadingSlash(trimmed);
      // Escape everything, then re-open the `*` / `?` wildcards.
      const body = escapeRegExp(normalized)
        .replace(/\\\*/g, ".*")
        .replace(/\\\?/g, ".");
      globs.push(new RegExp(`^${body}$`));
      // UX-driven: `/admin/*` (trailing `/*`) also excludes the bare `/admin`
      // parent. The typical user reading is "exclude this section"; without
      // this, the section root slips through and feels broken. Only applies to
      // directory-shaped globs — `*.pdf` has no `/*` ending so isn't affected.
      if (/\/\*$/.test(normalized)) {
        const parent = stripTrailingSlash(normalized.slice(0, -2));
        if (parent.length > 0 && !parent.includes("*") && !parent.includes("?")) {
          prefixes.push(parent);
        }
      }
    } else {
      prefixes.push(stripTrailingSlash(withLeadingSlash(trimmed)));
    }
  }

  if (prefixes.length === 0 && globs.length === 0) {
    return () => false;
  }

  return (pathname: string): boolean => {
    const path = withLeadingSlash(pathname);
    for (const prefix of prefixes) {
      // A bare `/` prefix means "exclude everything" — preserve that without
      // tripping the `prefix + "/"` check below (which would never fire).
      if (prefix === "/") return true;
      if (path === prefix) return true;
      // Bounded at `/`: `/blog` matches `/blog/foo` but not `/blogger`.
      if (path.startsWith(prefix + "/")) return true;
    }
    for (const glob of globs) {
      if (glob.test(path)) return true;
    }
    return false;
  };
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
  /**
   * Same-origin path patterns to exclude. Each is a prefix (`/blog`) or a glob
   * (`/admin/*`, `*.pdf`); matched against the URL pathname during both the
   * crawl and the sitemap merge. Defaults to `[]`. Capped at
   * {@link MAX_EXCLUDE_PATHS} entries. See {@link compileExcludePathMatcher}.
   */
  excludePaths?: string[];
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
  /**
   * Resolved same-origin exclude-path patterns (trimmed; always present, `[]`
   * when none). Feed to {@link compileExcludePathMatcher} to filter results.
   */
  excludePaths: string[];
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
