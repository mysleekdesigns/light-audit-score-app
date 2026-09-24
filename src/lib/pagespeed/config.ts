/**
 * PageSpeed Insights (PSI) engine configuration.
 *
 * The PSI engine is a second audit engine behind the shared `RunAudit` seam: it
 * calls Google's hosted PageSpeed Insights API instead of launching local Chrome.
 * This module owns the endpoint, the (optional) API key, and the retry/timeout
 * tuning. Server-only — the key is read from `process.env` and never sent to the
 * client.
 */

import { PSI_REQUESTS_PER_MINUTE } from "@/lib/pagespeed/quota";

/** PSI v5 `runPagespeed` endpoint (GET). */
export const PSI_ENDPOINT =
  "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * Resolve the PageSpeed Insights API key from the environment. Prefers the
 * dedicated `PAGESPEED_API_KEY`; falls back to `GOOGLE_API_KEY` so a single
 * Google API key works for both Custom Search and PSI (the key's GCP project must
 * have the PageSpeed Insights API enabled). Returns `undefined` when neither is
 * set — PSI then runs "keyless", which Google now caps at a 0 daily quota, so a
 * key is effectively required. Read server-side only; never sent to the client.
 */
export function getPsiApiKey(): string | undefined {
  const dedicated = process.env.PAGESPEED_API_KEY?.trim();
  if (dedicated) return dedicated;
  const shared = process.env.GOOGLE_API_KEY?.trim();
  return shared && shared.length > 0 ? shared : undefined;
}

/**
 * Per-request ceiling. PSI raised its own analysis timeout to 120s for heavy
 * pages (release notes, Mar 2 2021), so we bound each attempt to match.
 */
export const PSI_REQUEST_TIMEOUT_MS = 120_000;

/** Total attempts per request (1 initial + retries) on 5xx / network errors. */
export const PSI_MAX_ATTEMPTS = 3;

/** Base backoff between transient retries (doubled each attempt). */
export const PSI_RETRY_BASE_MS = 1_000;

/**
 * Attempts per request on an HTTP 429 — Google's per-project "Queries per
 * minute" quota — counted separately from the transient budget above. A
 * per-minute window has to actually roll over, so these waits are long:
 * `Retry-After` when Google sends one, else 15s → 30s → 60s → 60s (worst case
 * about 2¾ minutes per request before the job is recorded as an error).
 */
export const PSI_QUOTA_MAX_ATTEMPTS = 5;

/** First wait after a 429 without a `Retry-After` (doubled each attempt). */
export const PSI_QUOTA_RETRY_BASE_MS = 15_000;

/** Ceiling on a single quota wait — one full window. */
export const PSI_QUOTA_RETRY_MAX_MS = 60_000;

/**
 * Requests per minute the shared PSI limiter admits
 * (`PAGESPEED_REQUESTS_PER_MINUTE`). Defaults to Google's documented
 * per-project ceiling. Lower it when the key's project has a smaller "Queries
 * per minute" quota, or shares that quota with another app.
 */
export function getPsiRequestsPerMinute(): number {
  const raw = process.env.PAGESPEED_REQUESTS_PER_MINUTE?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : PSI_REQUESTS_PER_MINUTE;
}
