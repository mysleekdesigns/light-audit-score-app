/**
 * PageSpeed Insights request-cost arithmetic.
 *
 * PSI charges one API call per Lighthouse run, so a batch's cost is
 * `runs × strategies × targets` (`"both"` fans each URL into a mobile *and* a
 * desktop job — see `expandDevice` in `src/lib/lighthouse/options.ts`). The PSI
 * form's readout and its quota alert both need that number, so the arithmetic
 * lives here once rather than being re-derived in two components.
 *
 * Pure and client-safe: no key, no env, no network. The published quotas below
 * are Google's documented ceilings for a keyed project — a *keyless* request is
 * capped at a 0 daily quota (see `getPsiApiKey`), which is why the UI points at
 * `PAGESPEED_API_KEY` rather than treating keyless as merely "slower".
 */

import type { DeviceSelection } from "@/lib/lighthouse/types";

/** Google's documented PSI burst ceiling: ~240 requests per minute, per key. */
export const PSI_REQUESTS_PER_MINUTE = 240;

/** Google's documented PSI daily ceiling: 25,000 requests, per key. */
export const PSI_REQUESTS_PER_DAY = 25_000;

/** What one batch will cost against the PSI quota. */
export interface PsiRequestCost {
  /** Strategies each URL is analysed on — 2 for `"both"`, otherwise 1. */
  strategies: number;
  /** API calls a single URL costs: `runs × strategies`. */
  perUrl: number;
  /** API calls the whole batch costs: `perUrl × targets`. */
  total: number;
  /** True once {@link PsiRequestCost.total} passes the per-minute burst ceiling. */
  overBurst: boolean;
}

/** Coerce a possibly-fractional / negative count to a non-negative integer. */
function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Cost of a PSI batch: `runs × strategies` calls per URL, times the target count.
 *
 * `targets` of 0 still yields a meaningful `perUrl` — that's the figure the form
 * shows before any URL has been pasted, so the user can price a run in advance.
 */
export function psiRequestCost(
  device: DeviceSelection,
  runs: number,
  targets: number,
): PsiRequestCost {
  const strategies = device === "both" ? 2 : 1;
  const perUrl = count(runs) * strategies;
  const total = perUrl * count(targets);
  return {
    strategies,
    perUrl,
    total,
    overBurst: total > PSI_REQUESTS_PER_MINUTE,
  };
}
