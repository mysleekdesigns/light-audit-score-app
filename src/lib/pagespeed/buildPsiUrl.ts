/**
 * Build a PageSpeed Insights `runPagespeed` request URL from validated
 * {@link AuditOptions}. Pure & unit-testable (no network, no env beyond the key
 * the caller passes in).
 *
 * Mapping from the project's options to PSI query params:
 *  - `formFactor` → `strategy` (`mobile` | `desktop`)
 *  - `categories` → repeated `category` params (PSI uses an UPPER_SNAKE enum)
 *  - `locale`     → `locale` (omitted → PSI default)
 *  - `key`        → the API key (omitted → keyless request, lower rate limits)
 *
 * PSI ignores the local-only levers (runs / warmCache / cpuSlowdownMultiplier /
 * emulatedUserAgent / throttling) — its lab conditions are fixed Google-side.
 */

import type { AuditOptions, LighthouseCategory } from "@/lib/lighthouse/types";

import { PSI_ENDPOINT, getPsiApiKey } from "@/lib/pagespeed/config";

/** Project category id → PSI `category` enum value. */
const PSI_CATEGORY: Record<LighthouseCategory, string> = {
  performance: "PERFORMANCE",
  accessibility: "ACCESSIBILITY",
  "best-practices": "BEST_PRACTICES",
  seo: "SEO",
};

export function buildPsiUrl(
  url: string,
  options: AuditOptions,
  apiKey: string | undefined = getPsiApiKey(),
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
