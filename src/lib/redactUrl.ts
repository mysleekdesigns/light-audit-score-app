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
