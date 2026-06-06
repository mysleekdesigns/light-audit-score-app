/**
 * URL-template inference + per-template sampling — the engine behind the
 * "Pages per template" control (a representative-sampling lever for big crawls).
 *
 * Template-driven sites mint thousands of near-identical pages from a handful of
 * layouts: every product shares one template, every blog post another. Auditing
 * them all is slow and, for PageSpeed, burns API quota. "Pages per template"
 * groups the discovered set by an inferred path *template* (`/products/*`,
 * `/blog/:id/:id/*`) and keeps only N representative URLs per group — the same
 * idea Screaming Frog / Sitebulb call "representative pages per template".
 *
 * This module is the pure, import-safe core: no React/DOM/Node — just string in,
 * template/selection out — so it is trivially unit-testable and shareable by the
 * client forms (which sample the selection) and the discovered-pages table (which
 * shows each URL's template for transparency).
 */

import { MAX_PAGES, type DiscoveredUrl } from "@/lib/crawl/types";

/**
 * Sentinel for "no sampling — keep every discovered URL". Stored/treated as `0`
 * so the persisted default is a plain number and `n <= 0` reads as "All".
 */
export const PAGES_PER_TEMPLATE_ALL = 0;

/**
 * Discrete "keep N per template" choices offered in the picker. `All`
 * ({@link PAGES_PER_TEMPLATE_ALL}) is added by the UI ahead of these.
 */
export const PAGES_PER_TEMPLATE_OPTIONS = [1, 2, 3, 5, 10] as const;

/**
 * Clamp an untrusted value to a valid pages-per-template count: an integer in
 * `[0, MAX_PAGES]`, where `0` = All (no sampling). Non-numbers / garbage degrade
 * to `0` (All) so a stale or malformed setting never hides discovered URLs.
 * Mirrors the clamp-everything discipline of {@link clampPages}.
 */
export function clampPagesPerTemplate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return PAGES_PER_TEMPLATE_ALL;
  }
  return Math.min(MAX_PAGES, Math.max(0, Math.floor(value)));
}

/** A pure-numeric path segment (`/products/123`). */
const NUMERIC_SEGMENT = /^\d+$/;
/** A UUID segment (`/u/3f9a…-…`). */
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A long bare hex/hash segment (≥ 8 hex chars, no separators) — Mongo ids, hashes. */
const HEX_SEGMENT = /^[0-9a-f]{8,}$/i;

/** Collapse an identifier-shaped segment to `:id`; otherwise keep it literal. */
function classifySegment(segment: string): string {
  if (
    NUMERIC_SEGMENT.test(segment) ||
    UUID_SEGMENT.test(segment) ||
    HEX_SEGMENT.test(segment)
  ) {
    return ":id";
  }
  return segment;
}

/**
 * Infer a stable, human-readable *template* for a URL from its pathname — the
 * grouping key for per-template sampling. Query string and hash are ignored
 * (so `/p?id=1` and `/p?id=2` share template `/p`).
 *
 * Rules (predictable on purpose — the result is shown per-row so the user can
 * see the grouping and override it):
 *  - 0 path segments → `"/"` (the home page is its own template).
 *  - identifier-shaped segments (numeric / UUID / long hex) → `:id`.
 *  - exactly 1 segment → `"/" + classified` so distinct top-level pages stay
 *    separate: `/about` → `/about`, `/12345` → `/:id`.
 *  - ≥ 2 segments → interior segments are classified and the **leaf is collapsed
 *    to `*`** (the variable slug/id): `/products/red-shoe` → `/products/*`,
 *    `/products/123` → `/products/*`, `/blog/2024/01/launch` → `/blog/:id/:id/*`,
 *    `/category/electronics/phones` → `/category/electronics/*`.
 *
 * Unparseable input returns the raw string unchanged (its own degenerate group),
 * so this never throws.
 */
export function inferTemplate(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return url;
  }

  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "/";
  if (segments.length === 1) return `/${classifySegment(segments[0])}`;

  const interior = segments.slice(0, -1).map(classifySegment);
  return `/${interior.join("/")}/*`;
}

/**
 * Select at most `n` URLs per inferred template, preserving discovery order
 * (sitemap order first, then crawl order — the order `urls` already carries).
 * Returns the set of selected URLs, ready to seed the form's `crawlSelected`.
 *
 * `n <= 0` means "All" ({@link PAGES_PER_TEMPLATE_ALL}) — every URL is selected,
 * exactly the pre-feature behaviour.
 */
export function samplePerTemplate(
  urls: readonly DiscoveredUrl[],
  n: number,
): Set<string> {
  if (n <= 0) return new Set(urls.map((u) => u.url));

  const perTemplate = new Map<string, number>();
  const selected = new Set<string>();
  for (const { url } of urls) {
    const template = inferTemplate(url);
    const count = perTemplate.get(template) ?? 0;
    if (count < n) {
      selected.add(url);
      perTemplate.set(template, count + 1);
    }
  }
  return selected;
}
