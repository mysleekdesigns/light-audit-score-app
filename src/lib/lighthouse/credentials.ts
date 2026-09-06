/**
 * Audit credentials — the authenticated/header-aware audit seam (ROADMAP Phase B).
 *
 * Auditing a staging environment or a logged-in page needs the engine to carry a
 * credential: an HTTP basic-auth pair, a session cookie, or a bearer/preview
 * header. All three collapse to ONE mechanism at the Chrome level — Lighthouse's
 * `extraHeaders` setting, applied via CDP `Network.setExtraHTTPHeaders` before
 * the navigation (`core/gather/driver/prepare.js`) — so this module's job is to
 * fold the three user-facing shapes into one header map, and to make the values
 * *disappear* everywhere the rest of the app would otherwise persist them.
 *
 * ## The binding constraint (`.claude/rules/security.md`)
 *
 * These are **not LightAudit Score's own secrets**. They belong to the site under
 * audit, they are held for the life of one batch, and they must never reach
 * SQLite, a committed file, a report file, a log line, an SSE event, or the
 * client bundle. Two mechanisms enforce that, and both are needed:
 *
 *  1. **Structural** — the queue never puts credentials on the `Batch` object at
 *     all (`AuditQueue` keeps them in a per-batch side map it deletes when the
 *     batch settles), so every existing serialisation boundary is safe by
 *     construction rather than by remembering to redact.
 *  2. **Defensive** — {@link redactAuditOptions} is applied at every persistence
 *     boundary anyway (`recordBatch`, `recordRun`, `recordFailedRun`,
 *     `saveSchedule`), so a future code path that *does* carry a credential into
 *     one still cannot write it down.
 *
 * Lighthouse copies its resolved settings into the report verbatim
 * (`core/runner.js`: `configSettings: settings`), so `lhr.configSettings.extraHeaders`
 * would carry the credential into `data/reports/<runId>.json`, the standalone
 * HTML report, and any AI analysis built from them. {@link scrubLhrCredentials}
 * is the counter-measure and runs inside the worker, before the LHR is written
 * anywhere.
 *
 * Pure and isomorphic: no Node built-ins, no `Buffer`, no I/O — so it can be
 * unit-tested trivially and imported from the engine, the server, and the client
 * alike.
 */

/**
 * Placeholder substituted for every credential VALUE by {@link redactAuditOptions}.
 * Names (header names, cookie names) are preserved — they are provenance, not
 * secrets, and they let the UI say *which* credential a run used without being
 * able to say what it was.
 */
export const REDACTED = "[redacted]";

/** HTTP basic-auth pair (`Authorization: Basic base64(user:pass)`). */
export interface BasicAuthCredential {
  username: string;
  password: string;
}

/**
 * The three credential mechanisms, as the user supplies them. Every field is
 * optional; an object with none set is equivalent to no credentials at all
 * (see {@link hasAuditCredentials}).
 */
export interface AuditCredentials {
  /** Arbitrary request headers, e.g. `{ "X-Preview-Token": "…" }`. */
  extraHeaders?: Record<string, string>;
  /** Cookie name → value, serialised into one `Cookie` request header. */
  cookies?: Record<string, string>;
  /** HTTP basic auth, serialised into an `Authorization: Basic …` header. */
  basicAuth?: BasicAuthCredential;
}

/**
 * The credential-bearing keys of {@link AuditCredentials}. Anything that has to
 * enumerate "the secret fields" (redaction, extraction, stripping) derives from
 * this one list so a fourth mechanism can never be added to the contract without
 * the redaction seam noticing.
 */
export const CREDENTIAL_KEYS = [
  "extraHeaders",
  "cookies",
  "basicAuth",
] as const satisfies readonly (keyof AuditCredentials)[];

/** Bounds on user-supplied credential material (also enforced by the zod schema). */
export const MAX_CREDENTIAL_ENTRIES = 32;
export const MAX_HEADER_NAME_LENGTH = 256;
export const MAX_HEADER_VALUE_LENGTH = 8192;

/**
 * RFC 7230 `token` — the only characters legal in an HTTP field name. Enforced
 * here (and in the zod schema) so a malformed name can never be smuggled into a
 * header map, whatever the transport does with it.
 */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Characters that must never appear in a header VALUE. CR/LF/NUL are the header
 * injection vector; the transports we hand these to (CDP's JSON protocol,
 * undici's `Headers`) reject them too, but rejecting them at the contract means
 * the user gets a validation message instead of an opaque engine failure.
 */
export const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;

/** Cookie names follow the same `token` grammar as header names. */
export const COOKIE_NAME_PATTERN = HEADER_NAME_PATTERN;

/**
 * Characters that must never appear in a cookie VALUE. `;` would end the
 * cookie-pair and let one value forge another; CR/LF/NUL are header injection.
 * (Quotes and commas are legal in a cookie-value and deliberately allowed.)
 */
export const COOKIE_VALUE_FORBIDDEN = /[;\r\n\0]/;

// --- Predicates & extraction ----------------------------------------------

/** True when `value` is a non-null object (and not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** True when a record has at least one own key. */
function isNonEmptyRecord(
  value: Record<string, string> | undefined,
): value is Record<string, string> {
  return value !== undefined && Object.keys(value).length > 0;
}

/**
 * Whether `source` carries any credential at all. Empty header/cookie maps count
 * as *no* credential, so `{ extraHeaders: {} }` behaves exactly like `{}`.
 */
export function hasAuditCredentials(
  source: AuditCredentials | undefined | null,
): boolean {
  if (!source) return false;
  return (
    isNonEmptyRecord(source.extraHeaders) ||
    isNonEmptyRecord(source.cookies) ||
    source.basicAuth !== undefined
  );
}

/**
 * Pull the credential fields out of a wider object (typically `AuditOptions`),
 * returning `undefined` when there are none. The returned object is a fresh deep
 * copy, so the caller can hold it independently of the options it came from.
 */
export function extractAuditCredentials(
  source: AuditCredentials | undefined | null,
): AuditCredentials | undefined {
  if (!hasAuditCredentials(source)) return undefined;
  const credentials: AuditCredentials = {};
  if (isNonEmptyRecord(source!.extraHeaders)) {
    credentials.extraHeaders = { ...source!.extraHeaders };
  }
  if (isNonEmptyRecord(source!.cookies)) {
    credentials.cookies = { ...source!.cookies };
  }
  if (source!.basicAuth) {
    credentials.basicAuth = { ...source!.basicAuth };
  }
  return credentials;
}

/**
 * Return a copy of `source` with every credential field REMOVED (not redacted).
 *
 * Used where the credential has no business existing even as a placeholder —
 * e.g. the options pinned onto a `Batch`, which the API serialises straight to
 * the browser. Compare {@link redactAuditOptions}, which keeps the names as
 * provenance for the persisted record.
 */
export function stripAuditCredentials<T extends AuditCredentials>(source: T): T {
  const copy = { ...source };
  for (const key of CREDENTIAL_KEYS) {
    delete copy[key];
  }
  return copy;
}

// --- Redaction (the persistence-boundary seam) -----------------------------

/** Replace every value of a record with {@link REDACTED}, preserving its keys. */
function redactRecord(record: Record<string, string>): Record<string, string> {
  // Null-prototype: a header literally named `__proto__` passes the RFC 7230
  // token grammar, and on a normal object `out[name] = value` would hit the
  // prototype setter and silently drop the entry instead of recording it.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(record)) {
    out[name] = REDACTED;
  }
  return out;
}

/**
 * Return a copy of `options` in which every credential VALUE is replaced by
 * {@link REDACTED} while its NAME survives — so a persisted run still records
 * *that* it authenticated (and with which header/cookie), never *how*.
 *
 * Pure, total and **idempotent**: redacting already-redacted options is a no-op,
 * which is what lets it be applied defensively at several boundaries in a row
 * without the record degrading. An object with no credentials is returned
 * unchanged in content (a shallow copy).
 */
export function redactAuditOptions<T extends AuditCredentials>(options: T): T {
  const copy = { ...options };
  if (isNonEmptyRecord(copy.extraHeaders)) {
    copy.extraHeaders = redactRecord(copy.extraHeaders);
  }
  if (isNonEmptyRecord(copy.cookies)) {
    copy.cookies = redactRecord(copy.cookies);
  }
  if (copy.basicAuth) {
    copy.basicAuth = { username: REDACTED, password: REDACTED };
  }
  return copy;
}

/**
 * Merge `credentials` onto `options`, returning a new object. Used by the queue
 * to re-attach the per-batch credentials it holds out-of-band to the (redaction-
 * safe) job options just before handing them to the worker.
 */
export function withAuditCredentials<T extends AuditCredentials>(
  options: T,
  credentials: AuditCredentials | undefined,
): T {
  if (!hasAuditCredentials(credentials)) return { ...options };
  return { ...options, ...extractAuditCredentials(credentials) };
}

/**
 * Merge two credential sets, `override` winning **per entry** for headers and
 * cookies and wholesale for `basicAuth`.
 *
 * The engine uses this to layer per-batch credentials (the UI's Authentication
 * disclosure, `override`) over long-lived ones from `.env` (`base`), so a
 * one-off staging token can supersede the environment without unsetting the rest
 * of it.
 */
export function mergeAuditCredentials(
  base: AuditCredentials | undefined,
  override: AuditCredentials | undefined,
): AuditCredentials | undefined {
  if (!hasAuditCredentials(base)) return extractAuditCredentials(override);
  if (!hasAuditCredentials(override)) return extractAuditCredentials(base);
  const merged: AuditCredentials = {};
  const extraHeaders = { ...base!.extraHeaders, ...override!.extraHeaders };
  if (Object.keys(extraHeaders).length > 0) merged.extraHeaders = extraHeaders;
  const cookies = { ...base!.cookies, ...override!.cookies };
  if (Object.keys(cookies).length > 0) merged.cookies = cookies;
  const basicAuth = override!.basicAuth ?? base!.basicAuth;
  if (basicAuth) merged.basicAuth = { ...basicAuth };
  return merged;
}

// --- Header construction ---------------------------------------------------

/**
 * Base64 without `Buffer`, so this module stays isomorphic. `btoa` is a global
 * in Node ≥ 16 and every browser, but it is *latin1* — it throws on any code
 * point above U+00FF — so we UTF-8 encode first, exactly as `Buffer.from(s,
 * "utf8").toString("base64")` would. A non-ASCII basic-auth password is then
 * encoded the way a browser encodes one.
 */
function toBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `Authorization` header value for a basic-auth pair. */
export function basicAuthHeaderValue(auth: BasicAuthCredential): string {
  return `Basic ${toBase64Utf8(`${auth.username}:${auth.password}`)}`;
}

/** Serialise a cookie map into one `Cookie` request-header value. */
export function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/**
 * Fold a credential set into the single header map every transport wants —
 * Lighthouse's `extraHeaders` flag, and `fetch()` during crawl discovery.
 *
 * Precedence is deliberate: `basicAuth` and `cookies` are *sugar* for the
 * `Authorization` and `Cookie` headers, so they are written first and an
 * explicit `extraHeaders` entry of the same name overrides them. That way the
 * escape hatch ("just set the header yourself") always wins, and the sugar can
 * never silently clobber a header the user typed.
 *
 * Returns `undefined` when there is nothing to send, so callers can pass the
 * result straight through as an optional flag.
 */
export function buildCredentialHeaders(
  credentials: AuditCredentials | undefined | null,
): Record<string, string> | undefined {
  if (!hasAuditCredentials(credentials)) return undefined;
  // Null-prototype for the same reason as `redactRecord`: `__proto__` is a legal
  // header name and must land as a real entry, not vanish into the setter.
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  if (credentials!.basicAuth) {
    headers.Authorization = basicAuthHeaderValue(credentials!.basicAuth);
  }
  if (isNonEmptyRecord(credentials!.cookies)) {
    headers.Cookie = serializeCookies(credentials!.cookies);
  }
  for (const [name, value] of Object.entries(credentials!.extraHeaders ?? {})) {
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

// --- Environment-sourced credentials ---------------------------------------

/**
 * Env var listing the hosts a `.env` credential may be sent to (comma-separated).
 *
 * **Required for any env credential to apply at all**, and that is the whole
 * point. A `.env` credential is ambient: unlike the per-batch panel — where the
 * user attaches a credential to the URLs they are submitting right then — it
 * would otherwise ride along on *every* audit and *every* discovery the app ever
 * runs. Auditing 30 competitor URLs after setting `LH_AUDIT_BASIC_AUTH` for a
 * staging box would post that password to 30 unrelated hosts. So the credential
 * is inert until its hosts are named.
 *
 * Entries are hostnames, optionally with a port (`staging.example.com:8443`) and
 * optionally with a leading `*.` for subdomains (`*.staging.example.com`, which
 * covers per-PR preview deploys but NOT the apex). See {@link matchesCredentialHost}.
 */
export const ENV_CREDENTIAL_HOSTS = "LH_AUDIT_CREDENTIAL_HOSTS";

/** Env var holding a long-lived basic-auth pair, formatted `user:password`. */
export const ENV_BASIC_AUTH = "LH_AUDIT_BASIC_AUTH";
/** Env var holding long-lived extra headers as a JSON object of string→string. */
export const ENV_EXTRA_HEADERS = "LH_AUDIT_EXTRA_HEADERS";
/** Env var holding long-lived cookies: a `Cookie`-header string or a JSON object. */
export const ENV_COOKIES = "LH_AUDIT_COOKIES";

/** Trim + drop empties; `undefined` for anything blank. */
function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Keep only string→string entries whose name/value pass the header grammar. */
function sanitizeHeaderRecord(
  raw: Record<string, unknown>,
  valueForbidden: RegExp,
  namePattern: RegExp,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_CREDENTIAL_ENTRIES) break;
    if (typeof value !== "string") continue;
    const cleanName = name.trim();
    if (!namePattern.test(cleanName)) continue;
    if (cleanName.length > MAX_HEADER_NAME_LENGTH) continue;
    if (value.length > MAX_HEADER_VALUE_LENGTH) continue;
    if (valueForbidden.test(value)) continue;
    out[cleanName] = value;
  }
  return out;
}

/**
 * Parse `LH_AUDIT_BASIC_AUTH` (`user:password`). The password may itself contain
 * colons, so we split on the FIRST one only. An entry with no colon, or an empty
 * username, is ignored rather than half-applied.
 */
export function parseBasicAuthEnv(
  value: string | undefined,
): BasicAuthCredential | undefined {
  const raw = cleanEnv(value);
  if (!raw) return undefined;
  const separator = raw.indexOf(":");
  if (separator <= 0) return undefined;
  const username = raw.slice(0, separator);
  const password = raw.slice(separator + 1);
  if (HEADER_VALUE_FORBIDDEN.test(username) || HEADER_VALUE_FORBIDDEN.test(password)) {
    return undefined;
  }
  return { username, password };
}

/** Parse `LH_AUDIT_EXTRA_HEADERS`: a JSON object of string→string. */
export function parseExtraHeadersEnv(
  value: string | undefined,
): Record<string, string> | undefined {
  const raw = cleanEnv(value);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const headers = sanitizeHeaderRecord(
    parsed,
    HEADER_VALUE_FORBIDDEN,
    HEADER_NAME_PATTERN,
  );
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Parse `LH_AUDIT_COOKIES`. Accepts either a JSON object (`{"session":"…"}`) or
 * the `Cookie`-header string people actually copy out of DevTools
 * (`session=…; csrf=…`), because requiring JSON for a value you paste from the
 * network panel is a needless trap.
 */
export function parseCookiesEnv(
  value: string | undefined,
): Record<string, string> | undefined {
  const raw = cleanEnv(value);
  if (!raw) return undefined;

  let record: Record<string, unknown> | undefined;
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) record = parsed;
    } catch {
      return undefined;
    }
  } else {
    record = {};
    for (const pair of raw.split(";")) {
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      record[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    }
  }
  if (!record) return undefined;

  const cookies = sanitizeHeaderRecord(
    record,
    COOKIE_VALUE_FORBIDDEN,
    COOKIE_NAME_PATTERN,
  );
  return Object.keys(cookies).length > 0 ? cookies : undefined;
}

/**
 * Resolve long-lived credentials from the environment (normally a gitignored
 * `.env`). Read INSIDE the forked worker and by the server-side crawler — never
 * marshalled through the app's request/response layer — so an env-sourced
 * credential has no path to the client at all.
 *
 * **Host-UNSCOPED — do not call this directly from a code path that makes a
 * request.** It answers "what is configured", not "what may be sent to this
 * URL". {@link envCredentialsForUrl} is the gated form, and is what the engine
 * and the crawler use; this stays exported for the status/warning helpers and
 * for tests.
 *
 * Malformed entries are ignored, never thrown on: a typo in `.env` must degrade
 * to "no credential" (and a 401 the user can see) rather than breaking every
 * audit with a parse error.
 */
/** Drop a leading `www.` and lower-case a host (mirrors the crawler's rule). */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Parse {@link ENV_CREDENTIAL_HOSTS} into its entries: comma-separated, trimmed,
 * lower-cased, empties dropped. A missing/blank value yields `[]`, which means
 * "no host is allowed" — never "every host".
 */
export function parseCredentialHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether `url` is one of the hosts an env credential may be sent to.
 *
 * Matching is on host (and port, when the entry names one), never on path or
 * scheme — a credential is scoped to a server, and `http`/`https` on the same
 * staging box are the same server. `www.` is stripped from both sides, matching
 * the crawler's same-site rule so the two layers agree.
 *
 * A `*.` prefix matches SUBDOMAINS ONLY: `*.staging.example.com` covers
 * `pr-42.staging.example.com` (the per-PR preview deploys this exists for) but
 * not the apex, and — the part that has to be right — it anchors on a literal
 * dot boundary, so it can never match `evil-staging.example.com.attacker.net`
 * or `notstaging.example.com`.
 */
export function matchesCredentialHost(url: string, entries: string[]): boolean {
  if (entries.length === 0) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const host = normalizeHost(target.hostname);
  // Compare against the EFFECTIVE port. `URL.port` is "" for a default port, so
  // without this the entirely reasonable entry `staging.example.com:443` would
  // never match `https://staging.example.com` — a config that looks right,
  // fails closed, and produces an unexplained 401.
  const port = target.port || (target.protocol === "https:" ? "443" : "80");

  for (const entry of entries) {
    const parsed = parseCredentialHostEntry(entry);
    if (!parsed) continue;
    if (parsed.port !== null && parsed.port !== port) continue;

    if (parsed.wildcard) {
      // Subdomains only, anchored on the dot: ".staging.example.com" must be a
      // SUFFIX of the target, so "x.staging.example.com" matches while
      // "staging.example.com.attacker.net" and "notstaging.example.com" cannot.
      const suffix = `.${parsed.host}`;
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
      continue;
    }
    if (host === parsed.host) return true;
  }
  return false;
}

/** One parsed allow-list entry, or `null` when it can never be safely matched. */
interface CredentialHostEntry {
  /** Bare host, `www.`-stripped and lower-cased (no leading `*.`). */
  host: string;
  /** Explicit port, or `null` to match any. */
  port: string | null;
  /** Whether the entry was written `*.host` (subdomains only). */
  wildcard: boolean;
}

/**
 * Parse one allow-list entry. Returns `null` for anything unmatchable, so a
 * malformed entry disables itself rather than the whole list.
 *
 * Tolerates a pasted full URL (`https://staging.example.com:8443/`) because that
 * is what people copy out of a browser, and the alternative is an entry that
 * looks correct and silently never matches.
 */
function parseCredentialHostEntry(entry: string): CredentialHostEntry | null {
  let value = entry;
  const wildcard = value.startsWith("*.");
  if (wildcard) value = value.slice(2);

  // A pasted URL, or a bracketed/bare IPv6 literal — let `URL` do the parsing
  // rather than guessing where the host ends among the colons.
  if (value.includes("://") || value.startsWith("[")) {
    try {
      const parsed = new URL(value.includes("://") ? value : `http://${value}`);
      const host = normalizeHost(parsed.hostname);
      return host ? { host, port: parsed.port || null, wildcard } : null;
    } catch {
      return null;
    }
  }

  // Split a trailing `:port` — only when what follows the LAST colon is digits.
  // A bare IPv6 literal (`::1`) would mis-split here, which is why it must be
  // written bracketed (`[::1]`, handled above); an unbracketed one is rejected
  // below rather than silently becoming host ":" port "1".
  const colon = value.lastIndexOf(":");
  const hasPort = colon > 0 && /^\d+$/.test(value.slice(colon + 1));
  const host = normalizeHost(hasPort ? value.slice(0, colon) : value);
  const port = hasPort ? value.slice(colon + 1) : null;

  if (!host || host.includes(":") || host.includes("*")) return null;

  // A wildcard must keep at least two labels beneath it. `*.com` — a plausible
  // typo — would otherwise restore exactly the blast radius the allow-list
  // exists to remove, sending the credential to every `.com` audited.
  if (wildcard && host.split(".").filter(Boolean).length < 2) return null;

  return { host, port, wildcard };
}

/**
 * Long-lived credentials from the environment, scoped to `url`.
 *
 * Returns `undefined` — the same as "none configured" — whenever `url` is not
 * named in {@link ENV_CREDENTIAL_HOSTS}. This is the gate that stops an ambient
 * `.env` credential leaking to every host the app touches; see that constant's
 * docblock for why it is required rather than optional.
 */
export function envCredentialsForUrl(
  env: Record<string, string | undefined>,
  url: string,
): AuditCredentials | undefined {
  const hosts = parseCredentialHosts(env[ENV_CREDENTIAL_HOSTS]);
  if (!matchesCredentialHost(url, hosts)) return undefined;
  return credentialsFromEnv(env);
}

/**
 * Whether the environment has a credential configured but no hosts to send it
 * to — the one misconfiguration that fails silently (the audit just 401s), so
 * callers surface it as a warning.
 */
export function hasUnscopedEnvCredentials(
  env: Record<string, string | undefined>,
): boolean {
  return (
    parseCredentialHosts(env[ENV_CREDENTIAL_HOSTS]).length === 0 &&
    credentialsFromEnv(env) !== undefined
  );
}

export function credentialsFromEnv(
  env: Record<string, string | undefined>,
): AuditCredentials | undefined {
  const credentials: AuditCredentials = {};
  const basicAuth = parseBasicAuthEnv(env[ENV_BASIC_AUTH]);
  if (basicAuth) credentials.basicAuth = basicAuth;
  const extraHeaders = parseExtraHeadersEnv(env[ENV_EXTRA_HEADERS]);
  if (extraHeaders) credentials.extraHeaders = extraHeaders;
  const cookies = parseCookiesEnv(env[ENV_COOKIES]);
  if (cookies) credentials.cookies = cookies;
  return hasAuditCredentials(credentials) ? credentials : undefined;
}

// --- Report scrubbing ------------------------------------------------------

/**
 * Remove credentials from a Lighthouse result **in place**.
 *
 * Lighthouse copies its resolved settings into the report verbatim
 * (`core/runner.js`: `configSettings: settings`), and `extraHeaders` is one of
 * those settings — so without this the `Authorization`/`Cookie` header would be
 * written into `data/reports/<runId>.json`, embedded in the standalone HTML
 * report, and fed to the AI analysis. Called in the worker immediately after the
 * run, so the credential never crosses the process boundary in the first place.
 *
 * Sets the field to `null`, which is Lighthouse's own default for it
 * (`core/config/constants.js`) — the report is then indistinguishable from an
 * unauthenticated one, rather than carrying a redaction marker that hints at
 * what was there. Mutates rather than clones because an LHR is ~1 MB and this
 * runs on every single run.
 */
export function scrubLhrCredentials(lhr: unknown): void {
  if (!isPlainObject(lhr)) return;
  const settings = lhr.configSettings;
  if (isPlainObject(settings) && "extraHeaders" in settings) {
    settings.extraHeaders = null;
  }
}
