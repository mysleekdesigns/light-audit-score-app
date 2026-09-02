/**
 * Resolve the OPTIONAL web-research MCP server the Claude driver may drive.
 *
 * LightAudit does NOT bundle, install, advertise, or credential a research
 * server: it is SEPARATE software the user installs and authenticates
 * themselves. All this module does is read a standard MCP config and describe
 * what it declares. Nothing is configured → `null`, and the analysis still
 * diagnoses from the Lighthouse data, badged as ungrounded.
 *
 * Extracted from `runAnalysis.ts` when the provider seam landed; the behaviour
 * (and the env var names) are unchanged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

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
 * One server declaration exactly as the config states it — command, args, and
 * the RAW `env` block with its values still unresolved.
 *
 * Keeping this separate from {@link loadResearchMcpConfig} is deliberate: the
 * research server owns its own credentials, so the code path that only needs to
 * know *whether* a server is declared must never resolve them.
 */
interface ResearchDeclaration {
  command: string;
  args: string[];
  /** The declared `env` block, values NOT yet read from `process.env`. */
  declaredEnv: Record<string, unknown>;
}

/**
 * Find and validate the declared research server, stopping short of touching
 * any credential.
 *
 * Server selection, in order:
 *   1. the name in `LH_RESEARCH_MCP_SERVER`, if set;
 *   2. a server literally named `research`;
 *   3. the only server in the config, when there is exactly one.
 * Anything else is ambiguous and returns `null` rather than guessing.
 */
function resolveResearchDeclaration(cwd: string): ResearchDeclaration | null {
  const configPath =
    process.env[RESEARCH_CONFIG_PATH_ENV]?.trim() || path.join(cwd, ".mcp.json");

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
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
 * Resolve the research MCP server the analysis agent should launch, with its
 * declared environment materialized.
 *
 * Returns `null` when nothing is configured — the analysis still diagnoses from
 * the Lighthouse data, it just can't cite web sources (the engine drops to the
 * data-only tier and warns). Callers that only need to know *whether* research
 * is available want {@link hasResearchMcpConfig}, which skips the env overlay.
 */
export function loadResearchMcpConfig(
  cwd = process.cwd(),
): McpStdioServerConfig | null {
  const declaration = resolveResearchDeclaration(cwd);
  if (!declaration) return null;

  // Overlay each declared env value from process.env when present, falling back
  // to the literal in the config. We pass through what the user configured; we
  // never source a credential ourselves — and this is the ONLY place that reads
  // them, reached only when a server is actually about to be launched.
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
 * Whether a research server is resolvable right now.
 *
 * This is what decides the analysis capability TIER: a provider that supports
 * web research still can't do any without a server to drive, and prompting it as
 * a researcher anyway makes it narrate the shortfall (or invent a source)
 * instead of giving an honest data-only answer.
 */
export function hasResearchMcpConfig(cwd = process.cwd()): boolean {
  return resolveResearchDeclaration(cwd) !== null;
}
