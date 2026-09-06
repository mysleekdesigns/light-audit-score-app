/**
 * Credential-aware `fetch` for site discovery (ROADMAP Phase B).
 *
 * Discovery reaches the network from three places — the seed/page fetch in
 * `discover.ts`, `robots.ts`, and `sitemap.ts` — and Phase B lets all three
 * carry the user's audit credential so "discover the pages of my staging site"
 * enumerates the site instead of collecting its login page. That makes one
 * question safety-critical, and worth answering in exactly one place: *which*
 * requests may carry the credential.
 *
 * The answer is a {@link CredentialHeaderResolver} — a per-URL decision function
 * supplied by `discover.ts`, which owns the "same-site with the seed" rule and
 * is the only module that ever sees the credential values. This module never
 * holds a credential of its own; it asks, attaches, and forgets.
 *
 * ## Why the redirect chain is walked by hand
 *
 * `redirect: "follow"` is not safe enough for a credentialed request. Per the
 * fetch spec (§ HTTP-redirect fetch) a cross-origin redirect drops only
 * `Authorization`, `Cookie`, `Host` and `Proxy-Authorization`, so the basic-auth
 * and cookie mechanisms are protected — but an arbitrary `extraHeaders` entry
 * such as `X-Preview-Token` is forwarded to the redirect target verbatim. A
 * staging host that redirects off-site would hand that token to whoever it
 * points at, and we would never know.
 *
 * So whenever a resolver is present we drive the chain ourselves with
 * `redirect: "manual"`, re-asking the resolver at every hop and simply omitting
 * the credential on any hop it declines. Node's `fetch` (undici) answers a
 * manual redirect with the real 3xx response and a readable `Location` — not the
 * browser's opaque-redirect filtered response — which is what makes this
 * possible with the global `fetch` at all. Following continues *unauthenticated*
 * rather than aborting, so an off-site redirect degrades to the ordinary
 * public-site behaviour instead of failing the run.
 *
 * With no resolver — every public site, i.e. the overwhelmingly common case —
 * we make a single `redirect: "follow"` call that is byte-identical to the
 * pre-Phase-B request, so unauthenticated discovery is completely unchanged.
 *
 * Dependency-free (global `fetch` only), so it stays trivially unit-testable and
 * import-safe from every crawl module.
 */

/**
 * Decides which credential headers, if any, may be attached to `url`.
 * `undefined` means "send this one unauthenticated". Consulted separately for
 * every hop of a redirect chain, never once per logical request.
 */
export type CredentialHeaderResolver = (
  url: string,
) => Record<string, string> | undefined;

/**
 * Hop limit for the manually-followed redirect chain. Deliberately far shorter
 * than a browser's 20: discovery is best-effort and bounded everywhere else
 * too, and a page that needs more than a handful of hops is not worth the
 * requests. Exhausting it returns the last 3xx, which every caller already
 * treats as "not OK" → `null` body → a warning.
 */
export const MAX_CREDENTIAL_REDIRECTS = 5;

/** Redirect statuses we follow. Any other status ends the chain. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The slice of `RequestInit` discovery's fetchers actually use. */
export interface CredentialedFetchInit {
  /** Abort signal from the caller's per-request timeout. */
  signal: AbortSignal;
  /** The crawler's own headers (currently just its `user-agent`). */
  headers: Record<string, string>;
}

/**
 * Overlay `credentialHeaders` with the crawler's own `base` headers, matching
 * names case-insensitively so only ONE spelling of each field survives.
 *
 * Two deliberate decisions:
 *  - **`base` wins on a collision.** The crawler identifies as
 *    `ROBOTS_USER_AGENT` and matches `robots.txt` groups under that name, so
 *    letting a credential entry rename our user-agent would make us crawl under
 *    one identity while obeying another's rules. (The audit itself still applies
 *    `extraHeaders` verbatim in Chrome — this restriction is discovery-only.)
 *  - **Case-insensitive.** HTTP field names are case-insensitive, but a plain
 *    object is not: `{ "user-agent": a, "User-Agent": b }` survives as two keys
 *    and `Headers` joins them into `"a, b"`. Folding here means the request
 *    carries exactly what we intend.
 */
function mergeHeaders(
  base: Record<string, string>,
  credentialHeaders: Record<string, string> | undefined,
): Record<string, string> {
  if (!credentialHeaders) return { ...base };
  const merged: Record<string, string> = { ...credentialHeaders };
  const byLowerName = new Map<string, string>();
  for (const name of Object.keys(merged)) {
    byLowerName.set(name.toLowerCase(), name);
  }
  for (const [name, value] of Object.entries(base)) {
    const clashing = byLowerName.get(name.toLowerCase());
    if (clashing !== undefined) delete merged[clashing];
    merged[name] = value;
  }
  return merged;
}

/**
 * Fetch `url`, attaching whatever credential headers `resolveCredentials`
 * allows for each URL actually requested (see the module docblock for why the
 * redirect chain is walked by hand).
 *
 * Throws only what `fetch` itself throws — a network error or the caller's
 * abort — so the existing "a failed fetch becomes a warning, never a throw"
 * discipline in each caller's `try/catch` is untouched.
 */
export async function credentialedFetch(
  url: string,
  init: CredentialedFetchInit,
  resolveCredentials?: CredentialHeaderResolver,
): Promise<Response> {
  // No credential anywhere in this run: the exact request discovery has always
  // made, redirects and all, so nothing about a public crawl changes.
  if (!resolveCredentials) {
    return fetch(url, { ...init, redirect: "follow" });
  }

  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, {
      signal: init.signal,
      headers: mergeHeaders(init.headers, resolveCredentials(current)),
      redirect: "manual",
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (hop >= MAX_CREDENTIAL_REDIRECTS) return response;
    const location = response.headers.get("location");
    if (!location) return response;

    // `Location` may be relative; resolve it against the URL we just requested.
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return response;
    }

    // Release the socket before the next hop — nothing reads a 3xx body.
    await response.body?.cancel().catch(() => {});
    current = next;
  }
}
