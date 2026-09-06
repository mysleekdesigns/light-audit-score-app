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

/**
 * What replaces a credential's VALUE. The parameter's name is deliberately kept.
 *
 * Deleting the whole parameter would be the safer-looking choice and the worse
 * one: the auditor exporting a client report needs to SEE that a token was in
 * that URL, because the right response is usually to re-audit without it, not to
 * ship a file that silently looks clean.
 */
const REDACTED_VALUE = "[redacted]";

/**
 * Query parameters whose value is a credential, a signature, or a session
 * identifier — the things that must not travel in a document the user forwards.
 *
 * Matched on the WHOLE parameter name, not as a substring: a substring rule
 * turns `considerations=` into a redaction because it contains `sid`, and a
 * waterfall full of `[redacted]` where the data was ordinary is its own kind of
 * dishonesty. The AWS/GCS prefixes are spelled out because presigned asset URLs
 * are the most common way a genuinely sensitive URL reaches a Lighthouse
 * waterfall (`X-Amz-Signature`, `X-Goog-Signature`).
 *
 * **`code` and `state` are deliberately NOT here.** They are the OAuth pair, so
 * excluding them leaves a real gap — a magic-link audit can put a single-use
 * token in `?code=`. They are also, on ordinary sites, a discount code and a US
 * state, and redacting those would fire on a large share of e-commerce and form
 * URLs where nothing is at stake. This function is a safety net over an
 * unbounded space of parameter names; it cannot be the guarantee. The guarantee
 * is that the export TELLS the user the file contains the audited pages' request
 * URLs and screenshots, so a run against an authenticated or internal target
 * gets looked at before it is sent. See ROADMAP Phase H's security review.
 */
const CREDENTIAL_PARAM_NAME =
  /^(?:x-)?(?:(?:amz|goog)-)?(?:api[-_]?key|key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|password|passwd|pwd|secret|client[-_]?secret|signature|sig|auth|authorization|session[-_]?id|session|sid|jwt|bearer|credential|credentials|security[-_]?token)$/i;

/**
 * Redact credential-carrying query parameters, keeping the URL otherwise intact.
 *
 * Unlike {@link redactUrl}, which drops the query wholesale, this preserves every
 * ordinary parameter. That matters where the query is the DATA: a request
 * waterfall exists partly to show that a page fetched `app.js?v=3` and
 * `app.js?v=4`, or two `gtag/js?id=…` beacons that differ only in their query.
 * Stripping those would flatten distinct rows into identical-looking ones.
 *
 * Accepts a full URL or a bare `path?query` fragment (Lighthouse's waterfall
 * rows carry the latter), and leaves a value with no `?` untouched. Any fragment
 * is preserved after the query.
 */
export function redactCredentialParams(value: string): string {
  const queryStart = value.indexOf("?");
  if (queryStart === -1) return value;

  const head = value.slice(0, queryStart);
  const tail = value.slice(queryStart + 1);
  const hashAt = tail.indexOf("#");
  const query = hashAt === -1 ? tail : tail.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : tail.slice(hashAt);
  if (!query) return value;

  const cleaned = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      // `+` is a space in a query string, and a percent-encoded name is still
      // the same name — decode before matching so `access%5Ftoken` cannot slip
      // past a rule written for `access_token`. A malformed escape is not a
      // reason to throw: fall back to the raw name, which simply matches less.
      let decoded = name;
      try {
        decoded = decodeURIComponent(name.replace(/\+/g, " "));
      } catch {
        /* keep the raw name */
      }
      return CREDENTIAL_PARAM_NAME.test(decoded.trim())
        ? `${name}=${REDACTED_VALUE}`
        : pair;
    })
    .join("&");

  return `${head}?${cleaned}${fragment}`;
}

/**
 * The display form of a URL that is going into a document the user will send on:
 * no `user:pass@`, and no credential-carrying query values.
 *
 * The userinfo half is not hypothetical here. ROADMAP Phase B made authenticated
 * audits first-class, and `https://user:pass@staging.example.com` is a legal
 * thing for someone to type into the audit form — which would otherwise print
 * the password at the top of a client-facing report.
 *
 * Unparseable input is not discarded (a waterfall row's `path` is a fragment, not
 * a URL, and `redactUrl` returning `null` for it would blank a legitimate row);
 * it still gets the parameter pass.
 */
export function redactForExport(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return redactCredentialParams(url.toString());
    }
  } catch {
    /* a path fragment, or not a URL at all — parameter pass only */
  }
  return redactCredentialParams(value);
}
