/**
 * Strip credentials out of URLs before they cross a trust boundary.
 *
 * A user-supplied endpoint is a plausible place for a secret to hide: some
 * vendors authenticate with `?key=…`, and `https://user:pass@host` is legal in
 * any base URL someone pastes into `LH_ANALYSIS_BASE_URL`. That URL then wants
 * to appear in exactly the places a secret must never reach — a settings
 * response, an SSE error frame, a persisted warning — so it goes through here
 * first.
 *
 * Pure and dependency-free, so both server routes and drivers can use it.
 */

/** Matches a bare http(s) URL inside free text, stopping at whitespace/quotes. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** Stand-in for a URL that could not be parsed, and so could not be cleaned. */
const UNPARSEABLE = "[redacted url]";

/**
 * Credential-carrying query parameters, matched even when they are NOT part of a
 * parseable URL — an SDK message often quotes a bare `?api-key=…` fragment, and
 * {@link redactUrl} can only clean a URL it can parse.
 */
const CREDENTIAL_PARAM =
  /([?&](?:api[-_]?key|key|token|access_token|password)=)[^&\s)\]}"'<>]+/gi;

/**
 * Remove userinfo, query, and fragment from one URL, keeping only the parts safe
 * to display: scheme, host, port, path.
 *
 * Returns `null` when the input is absent or unparseable — a caller must never
 * fall back to the raw value, since "we couldn't parse it" is not "it's clean".
 */
export function redactUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * The one safe-to-render form of a URL a MODEL produced — a citation, a link in
 * the streamed diagnosis — or `null` when there isn't one.
 *
 * Model output is not author-controlled: it is shaped by the audit report, which
 * carries text from the audited page. So a URL arriving here can be anything,
 * including `javascript:` / `data:` — which, rendered into an `href` the user
 * clicks, would execute on the app's own origin, inside the session the request
 * gate exists to protect. Only absolute `http:`/`https:` survive, matching the
 * protocol rule the audit and discovery schemas already enforce on input.
 *
 * Returning `null` (rather than a scrubbed string) is deliberate: a caller must
 * render plain text instead of a link, never fall back to the raw value.
 */
export function safeHttpHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // The scheme must be written out in full. Checking only `url.protocol` would
  // not be enough: `new URL("http:settings")` — no base — yields the ABSOLUTE
  // `http://settings/`, while the same string in an `href` resolves against the
  // page and navigates to a path on THIS origin. That gap turns a citation
  // rendered as an outside source into a link back into the gated app.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    // Parse to reject what only looks like a URL. The ORIGINAL string is what
    // we hand back, so a source keeps the exact form the model cited (no added
    // trailing slash, no re-encoding); with an explicit scheme and no base, the
    // browser resolves the href exactly as `URL` just parsed it.
    const url = new URL(trimmed);
    // No `user:pass@host`. A real citation never carries userinfo, and it is
    // the one remaining way a URL can read as one host while resolving to
    // another — the same reason `redactUrl` strips it.
    if (url.username || url.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Redact every URL embedded in a free-text string.
 *
 * For messages we did not compose ourselves — an SDK's transport error, say,
 * which often quotes the request URL verbatim — where interpolating a cleaned
 * value isn't an option because we never held the pieces separately.
 */
export function redactUrlsInText(text: string): string {
  return text
    .replace(URL_IN_TEXT, (match) => {
      // Trailing punctuation is far more likely sentence structure than path.
      const trimmed = match.replace(/[.,;:!?]+$/, "");
      const suffix = match.slice(trimmed.length);
      return (redactUrl(trimmed) ?? UNPARSEABLE) + suffix;
    })
    // Second pass, for credential params that survived because they were never
    // part of a parseable URL to begin with.
    .replace(CREDENTIAL_PARAM, "$1[redacted]");
}
