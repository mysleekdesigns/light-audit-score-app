/**
 * The shape `GET /api/settings/research-status` and `PUT /api/settings/crawlforge`
 * return — the one description of "can the next analysis research the web, and
 * through what" that the server produces and the client reads.
 *
 * Types and plain string constants only, and deliberately credential-free:
 * every credential is represented as a boolean (the setup file exists or it
 * doesn't), never a value. Keeping this module pure means client components
 * can type the response and print the right commands without pulling any
 * server code into the bundle.
 */

/** Where a resolved research server came from. */
export type ResearchSource = "crawlforge" | "config";

/** Everything the settings panel needs to say about CrawlForge, honestly. */
export interface CrawlforgeStatus {
  /** The user's preference (the Settings switch). Off by default. */
  enabled: boolean;
  /**
   * CrawlForge's own setup file exists (`npx crawlforge-setup` has been run).
   * That file is where the server reads its key from; LightAudit Score only checks
   * that it is there.
   */
  setupOnDisk: boolean;
  /** The server can authenticate itself — today, `setupOnDisk`. */
  available: boolean;
  /** Enabled AND available: the next analysis will actually launch it. */
  active: boolean;
  /** The exact package version the next analysis would launch. */
  version: string;
}

/** What the next analysis would do about web research. */
export interface ResearchStatus {
  /** A research server is resolvable right now (the analysis capability tier). */
  configured: boolean;
  /** Which server that is, or `null` when none resolves. */
  source: ResearchSource | null;
  /**
   * A server is declared in an MCP config, whether or not it is the one in use
   * (CrawlForge takes precedence when active) — so the panel can say so.
   */
  configDeclared: boolean;
  /** The named, opt-in option. */
  crawlforge: CrawlforgeStatus;
}

/** The npm package name. */
export const CRAWLFORGE_PACKAGE_NAME = "crawlforge-mcp-server";
/**
 * The exact version `npx` runs by default. Pinned deliberately: an unpinned
 * `npx -y` would execute whatever was published last, install scripts
 * included, with the user's privileges. Bump this in a reviewed commit — or
 * move ahead of it locally with `LH_CRAWLFORGE_VERSION` (exact semver only).
 */
export const CRAWLFORGE_PACKAGE_VERSION = "5.6.0";
/** Env var that overrides the pinned version for this install. */
export const CRAWLFORGE_VERSION_ENV = "LH_CRAWLFORGE_VERSION";
/** The `npx` package spec for a given version — name@version. */
export function crawlforgePackageSpec(version: string): string {
  return `${CRAWLFORGE_PACKAGE_NAME}@${version}`;
}
/** Where a new user gets a key (free tier, no card). */
export const CRAWLFORGE_SIGNUP_URL = "https://www.crawlforge.dev/signup";
/** CrawlForge's own setup wizard — validates a key and stores it in its config. */
export const CRAWLFORGE_SETUP_COMMAND = "npx crawlforge-setup";
/** Where that wizard stores the key, for display only. */
export const CRAWLFORGE_CONFIG_FILE_DISPLAY = "~/.crawlforge/config.json";
