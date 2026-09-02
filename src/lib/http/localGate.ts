/**
 * Pure helpers behind `src/middleware.ts` — the local server's request gate.
 *
 * Edge-runtime safe (no Node built-ins) and dependency-free, so the checks that
 * decide who may talk to the local API can be unit-tested without booting Next.
 */

/** Hostnames that always mean "this machine", whatever address the server bound. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** Any 127.x.x.x address is loopback. */
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * The hostname part of a `Host` header, lower-cased: the port is stripped and
 * IPv6 brackets removed. `null` for a missing or unparseable value.
 */
export function hostnameOf(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (!value) return null;

  // "[::1]:3000" → "::1"
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? null : value.slice(1, end);
  }

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
 * request must be same-origin by whichever the browser sent; a client that
 * sends neither is not a browser and is left alone.
 */
export function isTrustedWrite(method: string, headers: HeaderReader): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;

  const fetchSite = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  const origin = headers.get("origin")?.trim();
  if (origin === undefined || origin === "") return true;
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
