/**
 * The one text pipeline for anything untrusted that gets echoed back
 * (ROADMAP Phase G).
 *
 * Every string a tool returns that did not originate here — a `finalUrl` after
 * redirects, a Chrome error message, an audit title out of a stored report, an
 * argument name a model invented — is page- or caller-derived, and it lands in
 * an agent's transcript. That is a context where an ESC, a CR or an RTL override
 * is not a rendering curiosity: it is how a tool result forges the conversation
 * around it, or makes `…/gnp.exe` read as `…/exe.png`.
 *
 * It lives here, under no feature's name, because it has four callers that do
 * not otherwise know about each other: the MCP tool payloads, the JSON-RPC error
 * path, the shared URL normaliser, and the CLI's terminal output. Phase G found
 * out why that matters — the four tool modules were each written with their own
 * copy, in two subtly different dialects, and the *weaker* dialect was the one
 * guarding every error message (security review, M1). A sanitiser that exists
 * six times is a sanitiser that will be six different strengths within a year.
 * (`displaySafe` in `src/lib/ci/reporters.ts` deliberately keeps its own copy;
 * its docblock explains why, and that decision predates this file.)
 */

/**
 * Neutralise the characters that let a page forge a line rather than occupy one.
 *
 * Two passes, and the order matters:
 *
 *  1. **C0/C1 controls become a SPACE, not nothing.** Deleting them merges the
 *     words either side — `"foo\nbar"` would become `foobar`, quietly inventing
 *     a token that was never in the report. A space keeps the text honest, and
 *     the collapse below tidies the result.
 *  2. **The invisible/bidi set is removed outright** (soft hyphen, zero-width
 *     spaces, the LTR/RTL overrides and isolates). These have no legitimate
 *     place in a machine-read payload, and substituting a space for them would
 *     be a visible edit to text that is supposed to read normally.
 *
 * Then whitespace collapses to single spaces and the ends are trimmed, so no
 * value can span lines in a log or pad itself into looking like structure.
 *
 * The classes are written as explicit escapes rather than as the characters
 * themselves: written literally they are invisible in a diff, and a formatter or
 * a copy-paste that ate one would silently weaken this with nothing to see.
 */
export function displaySafe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(
      /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The full pipeline: strip, then clamp to `max` characters.
 *
 * Clamping is not optional and not merely tidy. A `data:` URL is a legitimate
 * value in a stored report and can be megabytes; an agent pays for every one of
 * those tokens, and the plan's whole payload rule ("an agent pays for every
 * token of a Lighthouse report") dies on a single unbounded field.
 */
export function safeText(value: string, max: number): string {
  const cleaned = displaySafe(value);
  if (max <= 0) return "";
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}
