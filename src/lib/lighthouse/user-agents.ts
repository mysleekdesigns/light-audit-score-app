/**
 * User-agent presets for the optional `emulatedUserAgent` parity lever.
 *
 * Bot-sensitive sites (e.g. Cloudflare-fronted apps like example.com) can serve
 * different content to an automated/headless engine, which shifts the
 * environment-sensitive Best Practices audits. Pinning the page UA to a real
 * desktop/mobile Chrome makes the site serve the same markup a developer's
 * browser gets. `"default"` passes no override (Lighthouse uses its
 * config-default device UA).
 *
 * We persist the *preset key* (stable, tiny) in settings and resolve to a UA
 * string only when assembling engine options — see {@link resolveUserAgentPreset}.
 * Kept pure (no React/DOM/Node) so it's safe to import from client and server.
 */

export type UserAgentPreset = "default" | "desktop-chrome" | "mobile-chrome";

/** Canonical preset list, in select display order. */
export const USER_AGENT_PRESETS: readonly UserAgentPreset[] = [
  "default",
  "desktop-chrome",
  "mobile-chrome",
] as const;

/** Human labels for the UA preset select. */
export const USER_AGENT_PRESET_LABELS: Record<UserAgentPreset, string> = {
  default: "Default (device UA)",
  "desktop-chrome": "Desktop Chrome",
  "mobile-chrome": "Mobile Chrome",
};

/** Concrete UA strings for the non-default presets (recent stable Chrome). */
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MOBILE_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

/**
 * Resolve a UA preset key to the `emulatedUserAgent` string to pass to the engine,
 * or `undefined` for `"default"` / any unknown key (→ no override, engine omits
 * the flag and Lighthouse uses its config-default device UA).
 */
export function resolveUserAgentPreset(
  preset: UserAgentPreset | undefined,
): string | undefined {
  switch (preset) {
    case "desktop-chrome":
      return DESKTOP_CHROME_UA;
    case "mobile-chrome":
      return MOBILE_CHROME_UA;
    default:
      return undefined;
  }
}

/** Narrow an arbitrary value to a valid UA preset key, defaulting to "default". */
export function sanitizeUserAgentPreset(value: unknown): UserAgentPreset {
  return USER_AGENT_PRESETS.includes(value as UserAgentPreset)
    ? (value as UserAgentPreset)
    : "default";
}
