/**
 * Report branding — the optional title / logo / date block at the top of an
 * exported client report (ROADMAP Phase H).
 *
 * A report is a file the auditor emails onward, so the one thing this feature
 * has to get right is that the header carries THEIR name rather than ours. That
 * is all this module stores: four non-secret preferences in `app_settings`,
 * alongside the CrawlForge switch and the AI provider choice. Nothing
 * credential-shaped belongs here (`.claude/rules/security.md`) and nothing here
 * is credential-shaped — a name, a strapline, an image, and a boolean.
 *
 * **{@link sanitizeBranding} is the security boundary**, and it is deliberately
 * pure so it can be unit-tested exhaustively without a database. Everything it
 * returns is emitted into an HTML document that leaves this machine:
 *
 *  - `title` / `subtitle` go through `@/lib/text/displaySafe`, so no stored
 *    value can span lines, carry a bidi override, or pad itself into looking
 *    like structure in the header it is printed into.
 *  - `logoDataUri` is matched against a strict `data:image/…;base64,…`
 *    allow-list. Two separate reasons, and both are load-bearing:
 *
 *      1. **`data:` only** — the exported report must render with the network
 *         disabled and must not phone home from the recipient's machine, so a
 *         remote `https:` logo is not merely a worse choice, it is a broken
 *         image plus a beacon. `ReportBranding`'s own docblock makes this
 *         normative; assembly enforces it, the renderer enforces it again, and
 *         this store refuses to let one in in the first place.
 *      2. **No SVG** — `image/svg+xml` is a script-bearing document, not a
 *         picture. It is rejected explicitly rather than by omission, because
 *         "we forgot to list it" and "we decided against it" are different
 *         states and only one of them survives a refactor.
 *
 *    The allow-listed charset (`A–Z a–z 0–9 + / =`) also contains no `"`, `<`,
 *    `>` or `'`, so the value cannot break out of the attribute it is printed
 *    into even before the renderer escapes it. That is a consequence of the
 *    allow-list, not a reason to skip the escaping.
 *
 * Reads follow `@/lib/db/settings`' log-and-swallow discipline — a header block
 * that cannot be read degrades to {@link EMPTY_BRANDING}, never to an export
 * that fails. Writes throw, so the route can answer honestly when the setting
 * did not stick.
 */

import {
  BRANDING_LIMITS,
  EMPTY_BRANDING,
  sanitizeLogoDataUri,
  type ReportBranding,
} from "@/lib/export/report-model";
import {
  getAppSetting,
  getBooleanSetting,
  setAppSetting,
  setBooleanSetting,
} from "@/lib/db/settings";
import { safeText } from "@/lib/text/displaySafe";

/** `app_settings` key holding the header's title line. */
export const BRANDING_TITLE_SETTING = "report.branding.title";
/** `app_settings` key holding the header's strapline. */
export const BRANDING_SUBTITLE_SETTING = "report.branding.subtitle";
/** `app_settings` key holding the logo's `data:` URI. */
export const BRANDING_LOGO_SETTING = "report.branding.logo";
/** `app_settings` key holding the print-the-date preference. */
export const BRANDING_SHOW_DATE_SETTING = "report.branding.showDate";

/*
 * The four limits below are RE-EXPORTS of `BRANDING_LIMITS` in
 * `@/lib/export/report-model`, which is where they are defined and reasoned
 * about. They are not duplicated here — these are aliases, so there is exactly
 * one number behind each name.
 *
 * They have to live in the contract module rather than in this one because the
 * Settings panel needs the same values to label its inputs and refuse an
 * oversized file BEFORE a round-trip, and the panel runs in the browser: an
 * import of this file would drag `better-sqlite3` into the client bundle. The
 * names are kept for callers that already read them from the store.
 */

/**
 * Title cap. A report header is one line at display size; 80 characters is
 * about where an agency name stops being a name and starts being a sentence,
 * and past it the block wraps into the page it is supposed to sit above.
 */
export const BRANDING_TITLE_MAX = BRANDING_LIMITS.titleMax;

/** Subtitle cap — a strapline gets twice the room and still has to be one line. */
export const BRANDING_SUBTITLE_MAX = BRANDING_LIMITS.subtitleMax;

/**
 * Decoded-payload cap for the logo, in bytes.
 *
 * A settings row is read on every export and on every visit to the Settings
 * page, and it is base64 — about a third larger again on disk. 256 KB is a
 * generous logo (a 512px PNG lands nearer 30 KB) and a bounded row; without a
 * cap, one drag-and-dropped screenshot turns the preference table into
 * megabytes and every exported report with it.
 */
export const BRANDING_LOGO_MAX_BYTES = BRANDING_LIMITS.logoMaxBytes;

/**
 * Image types a logo may be. `svg+xml` is absent BY DECISION — see
 * {@link BRANDING_LIMITS}. Exported so the picker and this store cannot drift
 * apart on what "an image" means.
 */
export const BRANDING_LOGO_MIME_TYPES = BRANDING_LIMITS.logoMimeTypes;

/**
 * The logo validator now lives in the contract (`@/lib/export/report-model`).
 *
 * It moved there because FOUR layers need the same answer — this store, report
 * assembly, the renderer, and the Settings panel — and only this one can reach a
 * database. Phase H's security review found the consequence of that: assembly
 * had a prefix-only check while claiming to be "the check that decides", and the
 * panel carried a third hand-rolled copy of the regex. One pure function in the
 * contract removes the possibility.
 *
 * Re-exported under the original name so existing callers and tests are unaffected.
 */
export { sanitizeLogoDataUri };

/** A plain object — not an array, not null — before we read fields off it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn an untrusted value into a valid {@link ReportBranding}. Pure, never
 * throws, and never all-or-nothing: one bad field falls back to its own default
 * and the user keeps the rest. Losing a typed-out agency name because the logo
 * was a bad PNG would be a worse bug than the bad PNG.
 */
export function sanitizeBranding(input: unknown): ReportBranding {
  const source = isRecord(input) ? input : {};
  return {
    title:
      typeof source.title === "string" ? safeText(source.title, BRANDING_TITLE_MAX) : "",
    subtitle:
      typeof source.subtitle === "string"
        ? safeText(source.subtitle, BRANDING_SUBTITLE_MAX)
        : "",
    logoDataUri: sanitizeLogoDataUri(source.logoDataUri),
    // Default true, matching EMPTY_BRANDING: only an explicit `false` turns the
    // date off, so a missing or garbage field prints the date rather than
    // silently dropping it from a client's report.
    showDate: source.showDate !== false,
  };
}

/**
 * The stored branding. Degrades to {@link EMPTY_BRANDING} on any failure — an
 * unreadable preference must never be what stops an export from being produced.
 */
export function getReportBranding(): ReportBranding {
  try {
    return sanitizeBranding({
      title: getAppSetting(BRANDING_TITLE_SETTING),
      subtitle: getAppSetting(BRANDING_SUBTITLE_SETTING),
      logoDataUri: getAppSetting(BRANDING_LOGO_SETTING),
      showDate: getBooleanSetting(BRANDING_SHOW_DATE_SETTING, true),
    });
  } catch {
    // `getAppSetting` already log-and-swallows a read failure, so reaching here
    // means something stranger — but the rule is the same either way: an
    // unreadable preference costs the report its letterhead, never the report.
    return EMPTY_BRANDING;
  }
}

/**
 * Write the branding and answer with what was stored, so the panel can
 * reconcile against the truth rather than against what it hoped it sent — the
 * user needs to see that their SVG did not take before they mail the report.
 *
 * Throws if the write fails, per `@/lib/db/settings`' discipline.
 */
export function setReportBranding(input: unknown): ReportBranding {
  const branding = sanitizeBranding(input);
  setAppSetting(BRANDING_TITLE_SETTING, branding.title);
  setAppSetting(BRANDING_SUBTITLE_SETTING, branding.subtitle);
  setAppSetting(BRANDING_LOGO_SETTING, branding.logoDataUri);
  setBooleanSetting(BRANDING_SHOW_DATE_SETTING, branding.showDate);
  return branding;
}
