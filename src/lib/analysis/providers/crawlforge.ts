/**
 * CrawlForge — the one NAMED, opt-in research MCP server.
 *
 * The research seam in `researchMcp.ts` is vendor-neutral: any MCP server the
 * user declares in a standard MCP config works. CrawlForge is the single
 * first-class option layered on top of it — a one-switch path for people who
 * would rather not hand-write an MCP config. Enabling it in Settings makes the
 * analysis agent launch `npx -y crawlforge-mcp-server@<pinned>` as its
 * research server.
 *
 * The boundaries that keep this honest:
 *   - **Opt-in, off by default.** Nothing runs, downloads, or is advertised as
 *     "on" until the user flips the switch. `npx` fetches the (pinned) package
 *     on first use — LightAudit bundles nothing.
 *   - **The user's own account.** CrawlForge meters every tool against an API
 *     key the user gets themselves (free tier at signup) and stores with
 *     CrawlForge's own wizard, `npx crawlforge-setup`, in
 *     `~/.crawlforge/config.json`. The server reads that file itself.
 *   - **No credential handling at all.** LightAudit forwards NOTHING to the
 *     server: the only credential-shaped fact it knows is whether the setup
 *     file exists (`existsSync`, never opened), reported as a boolean. That is
 *     deliberate — the Agent SDK passes MCP launch configs on the `claude`
 *     command line, so any env value we forwarded would be visible in the
 *     process list for the duration of an analysis.
 *
 * Server-only: touches the filesystem and the preference store.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResearchDeclaration } from "@/lib/analysis/providers/researchMcp";
import {
  CRAWLFORGE_PACKAGE_VERSION,
  CRAWLFORGE_VERSION_ENV,
  type CrawlforgeStatus,
  crawlforgePackageSpec,
} from "@/lib/analysis/researchStatus";
import { getBooleanSetting, setBooleanSetting } from "@/lib/db/settings";

/** The `app_settings` key holding the enable/disable preference. */
export const CRAWLFORGE_ENABLED_SETTING = "research.crawlforge.enabled";
/** CrawlForge's own config file, relative to the home dir. Existence-checked only. */
const CRAWLFORGE_CONFIG_FILE = path.join(".crawlforge", "config.json");
/** An override must be an exact release — never a range, tag, or URL. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * The version the next analysis launches: `LH_CRAWLFORGE_VERSION` when it names
 * an exact release, else the pinned default. Anything else in the env var
 * (a range, a dist-tag, a URL) is ignored rather than passed to `npx`.
 */
export function resolveCrawlforgeVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  const requested = env[CRAWLFORGE_VERSION_ENV]?.trim();
  return requested && EXACT_SEMVER.test(requested) ? requested : CRAWLFORGE_PACKAGE_VERSION;
}

/**
 * CrawlForge tools the analysis agent must NOT see. Every CrawlForge call
 * spends credits from the user's account, and a citation search needs only
 * search + read tools. These are site crawlers, batch jobs, multi-source
 * research, browser automation, monitoring, and LLM-extraction tools —
 * irrelevant here, and several can burn through credits (or minutes) in a
 * single call.
 *
 * Bare tool names; the resolver prefixes them with the research server name.
 * With `permissionMode: "bypassPermissions"` this list is the ONLY thing
 * keeping a tool out of the agent's hands, so a tool CrawlForge renames would
 * silently come back — keep it current with the server's tool list.
 */
export const CRAWLFORGE_DISALLOWED_TOOL_NAMES: readonly string[] = [
  "agent",
  "deep_research",
  "batch_scrape",
  "get_batch_results",
  "crawl_deep",
  "map_site",
  "generate_llms_txt",
  "scrape_with_actions",
  "stealth_mode",
  "track_changes",
  "serp_rank",
  "localization",
  "extract_with_llm",
  "list_ollama_models",
  "process_document",
  "scrape_template",
  "scrape_structured",
  "extract_structured",
  "extract_embedded_state",
];

/**
 * Appended to the researching system prompt when CrawlForge is the research
 * server, so the agent reaches for the right tools first instead of learning
 * a large tool surface by trial and error (each error is a metered call).
 */
export const CRAWLFORGE_PROMPT_GUIDANCE =
  "Your research tools come from CrawlForge, which meters every call against the user's credits — so be deliberate. Use mcp__research__search_web to find candidate sources, then read a page with mcp__research__scrape (request formats: [\"markdown\"]) or mcp__research__extract_content. Stick to the 2–4 authoritative sources rule; do not open pages you will not cite.";

/**
 * Whether CrawlForge's setup file exists — the one credential-shaped fact this
 * module knows, and it never opens the file. `homeDir` is a parameter so tests
 * stay off the real machine.
 */
export function crawlforgeSetupOnDisk(homeDir: string = os.homedir()): boolean {
  // A runtime location in the user's home dir — kept out of the build's file
  // trace, which otherwise flags any dynamic path as "whole project".
  return existsSync(path.join(/* turbopackIgnore: true */ homeDir, CRAWLFORGE_CONFIG_FILE));
}

/** The user's enable/disable preference. Off until they turn it on. */
export function isCrawlforgeEnabled(): boolean {
  return getBooleanSetting(CRAWLFORGE_ENABLED_SETTING, false);
}

/** Persist the enable/disable preference. Throws if the write fails. */
export function setCrawlforgeEnabled(enabled: boolean): void {
  setBooleanSetting(CRAWLFORGE_ENABLED_SETTING, enabled);
}

/** Options for {@link crawlforgeStatus}, all defaulting to the live machine. */
export interface CrawlforgeStatusOptions {
  homeDir?: string;
  /** Environment to read the version override from (tests). */
  env?: Record<string, string | undefined>;
  /** Override the stored preference (tests; callers that already read it). */
  enabled?: boolean;
}

/** Resolve the full CrawlForge status — what the switch and the engine agree on. */
export function crawlforgeStatus(options: CrawlforgeStatusOptions = {}): CrawlforgeStatus {
  const enabled = options.enabled ?? isCrawlforgeEnabled();
  const setupOnDisk = crawlforgeSetupOnDisk(options.homeDir);
  return {
    enabled,
    setupOnDisk,
    available: setupOnDisk,
    active: enabled && setupOnDisk,
    version: resolveCrawlforgeVersion(options.env),
  };
}

/**
 * The research-server declaration for CrawlForge, in the same shape a user's
 * MCP config would produce — so the generic launcher treats it identically.
 *
 * The declared env carries no credential (see the module comment): only the
 * flag that forces the package into MCP stdio mode. `--prefer-offline` reuses
 * the npx cache when the pinned version is already there, so a warm start does
 * not wait on the registry (and cannot be surprised by it).
 */
export function crawlforgeDeclaration(
  platform: NodeJS.Platform = process.platform,
  version: string = resolveCrawlforgeVersion(),
): ResearchDeclaration {
  // `npx` is a .cmd shim on Windows, which a bare spawn can't execute.
  const viaNpx = ["-y", "--prefer-offline", crawlforgePackageSpec(version)];
  const [command, args] =
    platform === "win32" ? ["cmd", ["/c", "npx", ...viaNpx]] : ["npx", viaNpx];
  return {
    command,
    args,
    declaredEnv: {
      // Force MCP stdio mode rather than relying on the package's TTY sniffing.
      CRAWLFORGE_MCP_STDIO: "true",
    },
  };
}
