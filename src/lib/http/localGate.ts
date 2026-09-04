/**
 * Pure helpers behind `src/proxy.ts` — the local server's request gate.
 *
 * Edge-runtime safe (no Node built-ins) and dependency-free, so the checks that
 * decide who may talk to the local API can be unit-tested without booting Next.
 */

/**
 * Hostnames that always mean "this machine", whatever address the server bound.
 *
 * `0.0.0.0` is deliberately NOT here. It is the wildcard BIND address, not a
 * name for this machine, and it was for years the way a web page reached a
 * local server that `localhost` checks were meant to protect — browsers only
 * closed that in 2024. An allow-list should not lean on that fix. Someone who
 * binds the wildcard reaches the app on `127.0.0.1` (which is what
 * `scripts/start.mjs` prints) or names their host in `LH_ALLOWED_HOSTS`.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** Any 127.x.x.x address is loopback. */
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * What may appear in an unbracketed `Host`: letters, digits, `.`, `-` and `_`
 * (DNS, plus the underscore Docker and Windows names use), and `:` for the port
 * or a bracket-less IPv6 literal. Anything else — `@`, `/`, `\`, whitespace, a
 * bracket, a second host — means the header is not a hostname.
 */
const HOSTNAME_CHARS = /^[a-z0-9._:-]+$/;

/**
 * A bracketed IPv6 `Host`, with its optional port and RFC 6874 zone id:
 * `[::1]`, `[::1]:3000`, `[fe80::1%25eth0]:3000`. Matched as a whole rather
 * than by stripping brackets, so `[::1]evil]` cannot slip through.
 */
const BRACKETED_IPV6 = /^\[([0-9a-f:.]+(?:%25[a-z0-9-]+)?)\](?::\d{1,5})?$/;

/**
 * The hostname part of a `Host` header, lower-cased: the port is stripped and
 * IPv6 brackets removed. `null` for a missing, unparseable, or malformed value.
 *
 * The charset check is load-bearing, not hygiene. Without it
 * `Host: 127.0.0.1:3000@evil.example` splits at its single colon to a loopback
 * `127.0.0.1` and passes the allow-list — while the same raw header used as a
 * URL base parses `127.0.0.1:3000` as USERINFO and `evil.example` as the host,
 * which is how the gate's `?token=` strip redirect could be pointed off-origin.
 * A browser cannot send such a header, but a proxy or a scripted client can.
 */
export function hostnameOf(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (!value) return null;

  // "[::1]:3000" → "::1". Matched whole: a partial strip would accept
  // "[::1]evil]" and report the loopback half of it.
  if (value.startsWith("[")) {
    return BRACKETED_IPV6.exec(value)?.[1] ?? null;
  }

  if (!HOSTNAME_CHARS.test(value)) return null;

  // "host:3000" → "host"; a bare IPv6 (several colons, no brackets) is kept whole.
  const first = value.indexOf(":");
  const last = value.lastIndexOf(":");
  const hostname = first !== -1 && first === last ? value.slice(0, first) : value;
  return hostname || null;
}

/** Whether a hostname is loopback — including `*.localhost`, which resolves there. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    LOOPBACK_V4.test(hostname)
  );
}

/** Parse `LH_ALLOWED_HOSTS` (comma-separated hostnames, ports tolerated). */
export function parseAllowedHosts(value: string | undefined): Set<string> {
  const hosts = new Set<string>();
  if (!value) return hosts;
  for (const entry of value.split(",")) {
    const hostname = hostnameOf(entry);
    if (hostname) hosts.add(hostname);
  }
  return hosts;
}

/**
 * Whether a request's `Host` header names this machine, or a host the user
 * explicitly allowed for a deliberate non-loopback bind.
 *
 * This is the DNS-rebinding defence: a page served from `attacker.example`
 * whose DNS is re-pointed at 127.0.0.1 still sends `Host: attacker.example`,
 * and is refused before any route runs.
 */
export function isAllowedHost(
  hostHeader: string | null | undefined,
  allowedHosts: string | undefined,
): boolean {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  return parseAllowedHosts(allowedHosts).has(hostname);
}

/** Methods that never change state — exempt from the write-origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The subset of a Headers object the gate reads — easy to fake in tests. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Whether a state-changing request comes from this app's OWN origin.
 *
 * SameSite=Strict scopes the session cookie by *site*, not origin, and cookies
 * ignore ports — so a page on another loopback port (a dev server, a docs
 * preview, a port-forwarded box) would carry it, and a `text/plain` POST needs
 * no CORS preflight. Browsers label such requests: `Sec-Fetch-Site`
 * (`same-origin` | `same-site` | `cross-site` | `none`) and `Origin`. The
 * request must be same-origin by whichever the browser sent.
 *
 * A request carrying NEITHER header is refused rather than waved through as
 * "not a browser": this check is the only thing standing between the app and a
 * page on another loopback port, and a browser old enough to send neither (or
 * an embedded WebView that doesn't) is exactly the client that would defeat it.
 * A scripted client of its own — curl, a user's automation — satisfies this by
 * sending `Origin: http://127.0.0.1:<port>` (or `Sec-Fetch-Site: same-origin`)
 * alongside the session cookie it already has to send.
 */
export function isTrustedWrite(method: string, headers: HeaderReader): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;

  const fetchSite = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  const origin = headers.get("origin")?.trim();
  if (origin === undefined || origin === "") return false;
  if (origin === "null") return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const host = headers.get("host")?.trim().toLowerCase() ?? "";
  return originHost !== "" && originHost === host;
}

/**
 * Constant-time string equality for the session token. Runs over the longer of
 * the two lengths so a mismatch at position 0 costs the same as one at the end;
 * only the (non-secret) length comparison short-circuits, and even that is
 * folded into the result rather than returned early.
 */
export function safeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
