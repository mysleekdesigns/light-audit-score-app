/**
 * The one place an audit target is turned from typed text into a URL.
 *
 * Lifted verbatim out of `scripts/audit-cli.ts` when the MCP server (ROADMAP
 * Phase G) became a second door into the same archive. That move is not tidying:
 * **the return value is the key History groups by**, so two callers with two
 * normalisers file the same page under two URLs and quietly split the archive —
 * the exact archive Phase G exists to let an agent compare against. One
 * function, one answer, for the CLI and the agent alike.
 *
 * Every decision below is inherited from the CLI's own security reviews, and the
 * comments explaining them are kept where the code is rather than where it used
 * to be.
 */

import { safeText } from "@/lib/text/displaySafe";

/** A target that cannot be audited, with a message safe to show the caller. */
export class UrlNormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlNormalizeError";
  }
}

/**
 * Longest untrusted target echoed into a rejection message.
 *
 * 80, matching the CLI's own echo budget: these messages land in a CI log or in
 * an agent's context, and a rejected target is worth a glance, never a screen.
 */
const MAX_ECHO_CHARS = 80;

/**
 * A value echoed back into an error: stripped, then clamped.
 *
 * Clamping alone was not enough (Phase F security review, L-d) — refusing a
 * target is still ECHOING it, so an ESC or CR could forge the log line from the
 * rejection path. Nor was stripping only the control class (Phase G security
 * review, M1): a bidi override survives it, so a refused `…/gnp.exe` reads in a
 * transcript as `…/exe.png`. `safeText` is the union of both, and is shared with
 * the MCP tools and the CLI so the three cannot drift apart again.
 */
function clampForMessage(value: string): string {
  return safeText(value, MAX_ECHO_CHARS);
}

/**
 * Validate an audit target and return it **as typed**, with a scheme.
 *
 * @throws {UrlNormalizeError} for anything that cannot be audited.
 */
export function normalizeAuditUrl(raw: string): string {
  const trimmed = raw.trim();

  // Refuse control characters outright, rather than canonicalising them away.
  //
  // WHATWG `URL` STRIPS tab/CR/LF while parsing, so `https://x.test/<CR>y`
  // validates cleanly and then — because this function deliberately returns the
  // string as typed (see below) — a raw CR would travel on into `runs.url`.
  // Canonicalising instead would fix that and break something worse: the stored
  // URL would stop matching what the web path stores, splitting the archive.
  // Refusing keeps both properties, and nothing legitimate is lost — no real
  // target contains a control character.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new UrlNormalizeError(
      `A URL must not contain control characters: ${clampForMessage(trimmed)}`,
    );
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UrlNormalizeError(`Not a URL: ${clampForMessage(trimmed)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlNormalizeError(
      `Only http and https URLs can be audited: ${clampForMessage(trimmed)}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new UrlNormalizeError(
      "A URL must not carry a username or password — it would be written to " +
        "this run's history and into any report you publish. Put credentials in " +
        "LH_AUDIT_BASIC_AUTH (with LH_AUDIT_CREDENTIAL_HOSTS) instead; see .env.example.",
    );
  }

  // The PARSED url is used to validate and then thrown away; what is returned is
  // the string as typed. That is deliberate, and matters more than it looks:
  // `URL.toString()` canonicalises, so `https://example.com` comes back as
  // `https://example.com/`. `POST /api/audits` validates the same way and
  // returns the original (`src/lib/api/audits-schema.ts`), and `runs.url` is the
  // key History groups by and Compare trends on — so canonicalising here would
  // file two runs of the same page under two different URLs and quietly split
  // the shared archive.
  //
  // The cost is that a control character in the input survives into the string;
  // that is handled where it matters — at the point of ECHO — rather than by
  // mangling the address that gets audited and stored.
  return withScheme;
}

/**
 * The same normalisation, reduced to a comparison key.
 *
 * Distinct from the stored value on purpose: History must keep the URL exactly
 * as it was typed, but a *lookup* ("show me this page's runs") should not miss
 * because one caller wrote a trailing slash and another didn't. So the archive
 * keeps `normalizeAuditUrl`'s answer and matching uses this one, which is the
 * canonical form with a bare trailing slash and the fragment dropped.
 *
 * Returns `null` for anything that is not an auditable URL, so a caller can
 * treat "not a URL" as "matches nothing" instead of throwing mid-listing.
 */
export function auditUrlKey(raw: string): string | null {
  let normalized: string;
  try {
    normalized = normalizeAuditUrl(raw);
  } catch {
    return null;
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  // The fragment never reaches the network, so two URLs differing only by it are
  // the same page to Lighthouse and must be the same page to a history lookup.
  url.hash = "";
  const text = url.toString();
  // `https://x.test/` and `https://x.test` are one page; a deeper path's
  // trailing slash is NOT ours to drop (a server may distinguish them).
  return url.pathname === "/" && text.endsWith("/") ? text.slice(0, -1) : text;
}
