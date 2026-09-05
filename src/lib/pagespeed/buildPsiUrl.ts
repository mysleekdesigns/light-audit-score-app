/**
 * Build a PageSpeed Insights `runPagespeed` request URL from validated
 * {@link AuditOptions}. Pure & unit-testable (no network, no env beyond the key
 * the caller passes in).
 *
 * Mapping from the project's options to PSI query params:
 *  - `formFactor` → `strategy` (`mobile` | `desktop`)
 *  - `categories` → repeated `category` params (PSI uses an UPPER_SNAKE enum)
 *  - `locale`     → `locale` (omitted → PSI default)
 *  - `apiKey`     → the API key (`undefined` → keyless request, lower rate limits)
 *
 * `apiKey` is REQUIRED and this module reads no environment: `runPsiAudit` is the
 * single place that resolves `getPsiApiKey()`, and it passes the result in. It
 * used to carry a `= getPsiApiKey()` default, which made the docblock above false
 * and — because an explicit `undefined` argument *triggers* a TS default rather
 * than overriding it — silently turned `buildPsiUrl(url, options, undefined)`,
 * the obvious way to ask for a keyless URL, into a key-bearing one. Requiring the
 * argument makes the keyless path say so out loud and keeps this function pure,
 * so its tests cannot depend on whether a key happens to be in the environment.
 *
 * PSI ignores the local-only levers (runs / warmCache / cpuSlowdownMultiplier /
 * emulatedUserAgent / throttling) — its lab conditions are fixed Google-side.
 */

import type { AuditOptions, LighthouseCategory } from "@/lib/lighthouse/types";

import { PSI_ENDPOINT } from "@/lib/pagespeed/config";

/** Project category id → PSI `category` enum value. */
const PSI_CATEGORY: Record<LighthouseCategory, string> = {
  performance: "PERFORMANCE",
  accessibility: "ACCESSIBILITY",
  "best-practices": "BEST_PRACTICES",
  seo: "SEO",
  // PSI v5 accepts AGENTIC_BROWSING (discovery doc revision 20260904) and its
  // hosted Lighthouse is 13.4.1, so the fifth category needs no special-casing
  // here. `runPsiAudit` still degrades honestly if a future PSI drops it — an
  // unrequested/unreturned category simply parses to a missing score, never 0.
  "agentic-browsing": "AGENTIC_BROWSING",
};

export function buildPsiUrl(
  url: string,
  options: AuditOptions,
  apiKey: string | undefined,
): string {
  const params = new URLSearchParams();
  params.set("url", url);
  params.set("strategy", options.formFactor === "desktop" ? "desktop" : "mobile");
  // Repeat `category` once per requested category (filters response size too).
  for (const category of options.categories) {
    params.append("category", PSI_CATEGORY[category]);
  }
  if (options.locale) {
    params.set("locale", options.locale);
  }
  if (apiKey) {
    params.set("key", apiKey);
  }
  return `${PSI_ENDPOINT}?${params.toString()}`;
}
