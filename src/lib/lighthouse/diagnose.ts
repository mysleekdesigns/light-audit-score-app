/**
 * Failure classifiers for the Lighthouse engine (PRD §7 Polish, §8 preflight).
 *
 * Two pure, I/O-free functions that turn the engine's two failure shapes into a
 * single human-readable line. The classified `Error.message` is exactly what the
 * user sees: `AuditQueue.runJob` marks a failed job `error` with this message and
 * the UI renders it verbatim, so these strings are user-facing copy.
 *
 *  - `runtimeErrorMessage(lhr)` — Lighthouse frequently "succeeds" (returns an
 *    LHR) even when navigation failed, carrying the reason in `lhr.runtimeError`
 *    (e.g. `NO_FCP`, `FAILED_DOCUMENT_REQUEST`, `DNS_FAILURE`). We detect that and
 *    return a plain-English line so a page that never rendered is treated as an
 *    error rather than reported with bogus zero scores.
 *  - `classifyAuditError(err, url)` — Lighthouse / chrome-launcher / the network
 *    can also *throw*. We recognise the common classes (Chrome launch failures,
 *    DNS/unreachable, timeouts) by message/code substring and return an
 *    actionable line; everything else falls back to the trimmed original message.
 *
 * This module deliberately imports nothing (no Chrome, no Node I/O, no types that
 * pull in runtime) so it stays trivially unit-testable and safe to import from
 * the forked worker under native TS stripping. Tiny structural guards are inlined
 * rather than imported.
 */

/** Narrow `unknown` to a plain object so we can read loose LHR / error fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Return `value` as a non-empty trimmed string, else `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Friendly one-liners for the Lighthouse `runtimeError.code` values that signal a
 * navigation/load failure. Anything not listed falls back to the LHR's own
 * `runtimeError.message` (and then to a generic line) in {@link runtimeErrorMessage}.
 */
const RUNTIME_ERROR_MESSAGES: Record<string, string> = {
  // DNS could not resolve the host.
  DNS_FAILURE: "the site's address could not be resolved (DNS lookup failed)",
  // The main document request failed outright (connection refused/reset, TLS, etc.).
  FAILED_DOCUMENT_REQUEST: "the page could not be loaded (the server did not respond)",
  ERRORED_DOCUMENT_REQUEST: "the page could not be loaded (the server returned an error)",
  // Chrome never reached a usable navigation/paint state.
  NO_NAVSTART: "the page never started loading",
  NO_FCP: "the page loaded but never rendered any content",
  NO_LCP: "the page loaded but never rendered its main content",
  // Lighthouse's own navigation timeout.
  PAGE_HUNG: "the page hung and never finished loading",
  TARGET_CRASHED: "the browser tab crashed while loading the page",
  // Insecure / invalid TLS.
  INSECURE_DOCUMENT_REQUEST: "the page could not be loaded securely (invalid certificate)",
};

/**
 * Inspect an LHR for a non-empty `runtimeError` and, if present, return a
 * friendly one-line reason; otherwise return `null` (the run succeeded).
 *
 * Pure: takes the loosely-typed LHR record and returns a string or null.
 */
export function runtimeErrorMessage(lhr: unknown): string | null {
  if (!isRecord(lhr)) return null;
  const runtimeError = lhr.runtimeError;
  if (!isRecord(runtimeError)) return null;

  const code = nonEmptyString(runtimeError.code);
  const rawMessage = nonEmptyString(runtimeError.message);

  // A `code` of "NO_ERROR" (or no code and no message) means there was no real
  // failure — treat it as success.
  if ((code === undefined || code === "NO_ERROR") && rawMessage === undefined) {
    return null;
  }
  if (code === "NO_ERROR") return null;

  const friendly = code ? RUNTIME_ERROR_MESSAGES[code] : undefined;
  if (friendly) {
    return `Lighthouse could not audit the page: ${friendly}.`;
  }

  // Unknown code: surface Lighthouse's own message if we have one, else the code.
  const detail = rawMessage ?? code;
  if (detail) {
    return `Lighthouse could not audit the page: ${detail}`;
  }
  return null;
}

/** Extract a lowercased message+code blob from a thrown value for substring matching. */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = isRecord(err) ? nonEmptyString((err as Record<string, unknown>).code) : undefined;
    return `${err.message} ${code ?? ""}`.toLowerCase();
  }
  if (isRecord(err)) {
    const message = nonEmptyString(err.message) ?? "";
    const code = nonEmptyString(err.code) ?? "";
    return `${message} ${code}`.toLowerCase();
  }
  return String(err).toLowerCase();
}

/** The original thrown message, trimmed, for the generic fallback. */
function originalMessage(err: unknown): string {
  if (err instanceof Error) return err.message.trim();
  if (isRecord(err)) {
    const message = nonEmptyString(err.message);
    if (message) return message;
  }
  return String(err).trim();
}

/**
 * Turn a thrown engine / launcher / network error into a friendly, actionable
 * one-line message that always names the `url` for context.
 *
 * Recognised classes (by message/code substring):
 *  - Chrome launch/detection failure → a "Could not launch Chrome…" preflight line.
 *  - DNS / unreachable host           → a "could not connect / resolve" line.
 *  - Timeout                          → a "took too long" line.
 *  - Anything else                    → the trimmed original message + the url.
 *
 * Pure: `unknown` + url → string.
 */
export function classifyAuditError(err: unknown, url: string): string {
  const text = errorText(err);

  // --- Chrome launch / detection failures (PRD §8 preflight) ---------------
  // chrome-launcher throws these when no browser is installed or the spawned
  // Chrome never opened its remote-debugging port.
  const chromeLaunchFailure =
    text.includes("no chrome installations found") ||
    text.includes("unable to connect to chrome") ||
    text.includes("chrome-launcher") ||
    text.includes("chrome_path") ||
    text.includes("no chrome found") ||
    text.includes("connection_timeout") ||
    // ECONNREFUSED specifically against the local debugging port.
    (text.includes("econnrefused") &&
      (text.includes("127.0.0.1") ||
        text.includes("localhost") ||
        text.includes("debugging") ||
        text.includes("chrome")));

  if (chromeLaunchFailure) {
    return (
      `Could not launch Chrome to audit ${url}. ` +
      `Make sure Google Chrome (or Chromium) is installed and runnable. ` +
      `If it is installed in a non-standard location, set the CHROME_PATH environment variable.`
    );
  }

  // --- DNS / unreachable host ----------------------------------------------
  if (text.includes("enotfound") || text.includes("getaddrinfo")) {
    return `Could not resolve ${url} — the site's address may be wrong or the host is unreachable.`;
  }
  if (text.includes("econnrefused")) {
    return `Could not connect to ${url} — the server refused the connection.`;
  }
  if (
    text.includes("econnreset") ||
    text.includes("ehostunreach") ||
    text.includes("enetunreach")
  ) {
    return `Could not reach ${url} — the connection was reset or the host is unreachable.`;
  }
  if (text.includes("cert") && text.includes("err_cert")) {
    return `Could not load ${url} securely — the site's certificate is invalid.`;
  }

  // --- Timeouts ------------------------------------------------------------
  if (text.includes("timed out") || text.includes("timeout") || text.includes("etimedout")) {
    return `Audit of ${url} took too long and timed out.`;
  }

  // --- Generic fallback: keep the original message, add the url for context.
  const original = originalMessage(err);
  if (original && original.toLowerCase().includes(url.toLowerCase())) {
    // The message already names the url; don't duplicate it.
    return original;
  }
  return original
    ? `Audit of ${url} failed: ${original}`
    : `Audit of ${url} failed for an unknown reason.`;
}
