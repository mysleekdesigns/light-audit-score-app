/**
 * Resolve the OPTIONAL web-research MCP server the Claude driver may drive.
 *
 * Two ways a research server gets here, checked in this order:
 *
 *   1. **CrawlForge** (`crawlforge.ts`) — the one named, opt-in integration.
 *      When the user has enabled it in Settings AND a key is detectable, the
 *      agent launches `npx -y crawlforge-mcp-server`. Off by default.
 *   2. **A user-declared server** in a standard MCP config — the vendor-neutral
 *      path. LightAudit Score reads the config and launches whatever it declares.
 *
 * Either way the server is SEPARATE software running under the user's control,
 * authenticated with the user's own account. This module never sources a
 * credential of its own: CrawlForge reads its key from its own setup file, and
 * for a config-declared server only the `env` block the USER wrote is overlaid
 * from `process.env` at launch. Nothing configured → `null`, and the analysis
 * still diagnoses from the Lighthouse data, badged as ungrounded.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

import {
  CRAWLFORGE_DISALLOWED_TOOL_NAMES,
  CRAWLFORGE_PROMPT_GUIDANCE,
  type CrawlforgeStatusOptions,
  crawlforgeDeclaration,
  crawlforgeStatus,
} from "@/lib/analysis/providers/crawlforge";
import type { ResearchSource, ResearchStatus } from "@/lib/analysis/researchStatus";
import { asString, isRecord } from "@/lib/lighthouse/parseLhr";

/**
 * Path to the MCP config that declares the research server. Defaults to
 * `<cwd>/.mcp.json` (the standard MCP config format), overridable so a packaged
 * or `npx` install can point at a config living outside the app directory.
 */
const RESEARCH_CONFIG_PATH_ENV = "LH_RESEARCH_MCP_CONFIG";
/** Which server in that config to use. Defaults to `research`. */
const RESEARCH_SERVER_NAME_ENV = "LH_RESEARCH_MCP_SERVER";
/** Conventional server name callers are expected to use. */
const DEFAULT_RESEARCH_SERVER = "research";
/** Per research-tool-call timeout (ms). */
const MCP_TOOL_TIMEOUT_MS = 90_000;

/** The MCP server name the driver registers the research tools under. */
export const RESEARCH_MCP_NAME = "research";

/**
 * One server declaration exactly as its source states it — command, args, and
 * the RAW `env` block with its values still unresolved.
 *
 * `declaredEnv` entries: a string is a fixed literal; a non-string value (a
 * config file's `null`, say) means "forward this variable from `process.env`
 * if it is set there, else omit it".
 *
 * Keeping this separate from {@link researchLaunchConfig} is deliberate: the
 * research server owns its own credentials, so the code paths that only need to
 * know *whether* a server is declared must never resolve them.
 */
export interface ResearchDeclaration {
  command: string;
  args: string[];
  /** The declared `env` block, values NOT yet read from `process.env`. */
  declaredEnv: Record<string, unknown>;
}

/**
 * Detection overrides for resolution. Production callers pass nothing; tests
 * use them to keep the CrawlForge probe (env + home dir + stored preference)
 * off the real machine.
 */
export interface ResearchResolveOptions {
  crawlforge?: CrawlforgeStatusOptions;
}

/** A research server the next analysis would launch, plus how to drive it. */
export interface ResolvedResearchServer {
  source: ResearchSource;
  declaration: ResearchDeclaration;
  /**
   * Fully-qualified tool names (`mcp__research__<tool>`) to strip from the
   * agent — a server may expose far more than a citation search needs.
   */
  disallowedTools: string[];
  /** Server-specific guidance appended to the researching system prompt. */
  promptGuidance: string | null;
}

/**
 * Find and validate a research server declared in a standard MCP config,
 * stopping short of touching any credential.
 *
 * Server selection, in order:
 *   1. the name in `LH_RESEARCH_MCP_SERVER`, if set;
 *   2. a server literally named `research`;
 *   3. the only server in the config, when there is exactly one.
 * Anything else is ambiguous and returns `null` rather than guessing.
 */
function resolveConfigDeclaration(cwd: string): ResearchDeclaration | null {
  // Runtime, user-supplied locations: deliberately outside the build's file
  // trace (the ignore comments), which otherwise flags them as "whole project".
  const configPath =
    process.env[RESEARCH_CONFIG_PATH_ENV]?.trim() ||
    path.join(/* turbopackIgnore: true */ cwd, ".mcp.json");

  try {
    const parsed = JSON.parse(
      readFileSync(/* turbopackIgnore: true */ configPath, "utf8"),
    ) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return null;
    const servers = parsed.mcpServers;

    const requested = process.env[RESEARCH_SERVER_NAME_ENV]?.trim();
    const names = Object.keys(servers);
    const chosen =
      requested ??
      (DEFAULT_RESEARCH_SERVER in servers
        ? DEFAULT_RESEARCH_SERVER
        : names.length === 1
          ? names[0]
          : undefined);
    if (!chosen) return null;

    const server = servers[chosen];
    if (!isRecord(server)) return null;

    const command = asString(server.command);
    if (!command) return null;
    const args = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === "string")
      : [];

    return {
      command,
      args,
      declaredEnv: isRecord(server.env) ? server.env : {},
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the research server the next analysis would launch, without
 * materializing its environment.
 *
 * CrawlForge wins when it is enabled and available — the Settings switch is the
 * most explicit signal the user can give — otherwise the declared config is
 * used. `null` when neither applies: the analysis then runs at the data-only
 * tier. `cwd` locates a default `.mcp.json`; tests point it at a temp dir.
 */
export function resolveResearchServer(
  cwd = process.cwd(),
  options: ResearchResolveOptions = {},
): ResolvedResearchServer | null {
  const crawlforge = crawlforgeStatus(options.crawlforge);
  if (crawlforge.active) {
    return {
      source: "crawlforge",
      declaration: crawlforgeDeclaration(process.platform, crawlforge.version),
      disallowedTools: CRAWLFORGE_DISALLOWED_TOOL_NAMES.map(
        (tool) => `mcp__${RESEARCH_MCP_NAME}__${tool}`,
      ),
      promptGuidance: CRAWLFORGE_PROMPT_GUIDANCE,
    };
  }

  const declaration = resolveConfigDeclaration(cwd);
  if (!declaration) return null;
  return { source: "config", declaration, disallowedTools: [], promptGuidance: null };
}

/**
 * Turn a resolved server into the SDK launch config, with its declared
 * environment materialized.
 *
 * Each declared env value is overlaid from `process.env` when present, falling
 * back to the literal in the declaration (string literals only). We pass
 * through what the user configured; we never source a credential ourselves —
 * and this is the ONLY place that reads them, reached only when a server is
 * actually about to be launched.
 *
 * Caveat for anyone declaring a secret here: the Agent SDK hands this config
 * to the `claude` CLI as a command-line flag, so a declared env VALUE is
 * visible in the process list while an analysis runs. CrawlForge declares
 * none for that reason.
 */
export function researchLaunchConfig(server: ResolvedResearchServer): McpStdioServerConfig {
  const { declaration } = server;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(declaration.declaredEnv)) {
    const fromProcess = process.env[key];
    const literal = typeof value === "string" ? value : undefined;
    const resolved = fromProcess ?? literal;
    if (resolved !== undefined) env[key] = resolved;
  }

  // `alwaysLoad: true` keeps the research tools in the prompt (not deferred
  // behind tool-search) AND blocks startup until the server connects — without
  // it the agent often starts before the stdio server is ready and never gets
  // the web tools, leaving fixes ungrounded.
  return {
    type: "stdio",
    command: declaration.command,
    args: declaration.args,
    env,
    timeout: MCP_TOOL_TIMEOUT_MS,
    alwaysLoad: true,
  };
}

/**
 * The launch config for whichever research server resolves right now, or
 * `null` when nothing is configured. Callers that only need to know *whether*
 * research is available want {@link hasResearchMcpConfig}, which skips the env
 * overlay.
 */
export function loadResearchMcpConfig(
  cwd = process.cwd(),
  options: ResearchResolveOptions = {},
): McpStdioServerConfig | null {
  const server = resolveResearchServer(cwd, options);
  return server ? researchLaunchConfig(server) : null;
}

/**
 * Whether a research server is resolvable right now.
 *
 * This is what decides the analysis capability TIER: a provider that supports
 * web research still can't do any without a server to drive, and prompting it as
 * a researcher anyway makes it narrate the shortfall (or invent a source)
 * instead of giving an honest data-only answer.
 */
export function hasResearchMcpConfig(
  cwd = process.cwd(),
  options: ResearchResolveOptions = {},
): boolean {
  return resolveResearchServer(cwd, options) !== null;
}

/**
 * The status the settings endpoints report: whether research is on, through
 * which server, and everything the CrawlForge switch needs. Presence booleans
 * only — never a command, argument, or environment value.
 */
export function researchStatus(
  cwd = process.cwd(),
  options: ResearchResolveOptions = {},
): ResearchStatus {
  const crawlforge = crawlforgeStatus(options.crawlforge);
  // Resolve with the status already in hand so the two can't disagree.
  const server = resolveResearchServer(cwd, {
    crawlforge: { ...options.crawlforge, enabled: crawlforge.enabled },
  });
  return {
    configured: server !== null,
    source: server?.source ?? null,
    configDeclared: resolveConfigDeclaration(cwd) !== null,
    crawlforge,
  };
}
