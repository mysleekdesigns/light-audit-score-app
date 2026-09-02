/**
 * Server-only engine for the AI score analysis.
 *
 * Embeds the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as a headless,
 * read-only research agent that drives a user-configured research MCP server (a
 * SEPARATE app the user installs and authenticates themselves) to diagnose a low
 * Lighthouse category score
 * and propose cited fixes. Auth is the developer's Claude Code login on this
 * machine — we never set `ANTHROPIC_API_KEY`, and we omit the SDK `env` option so
 * the spawned subprocess inherits `process.env` (and therefore the OAuth creds).
 *
 * The function streams progress to the caller via `onEvent` (status / tool-use /
 * tool-result / text-delta / fix) and RETURNS the final {@link AnalysisResult}.
 * It THROWS {@link AnalysisError} on auth/agent failure; the route owns the
 * terminal `done` / `error` SSE frames and persistence. Node runtime only.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { query, type McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { asNumber, asString, isRecord } from "@/lib/lighthouse/parseLhr";
import type {
  FieldData,
  FormFactor,
  LighthouseResult,
} from "@/lib/lighthouse/types";
import { buildAnalysisInput } from "@/lib/analysis/extract";
import { ANALYSIS_SYSTEM_PROMPT, buildUserPrompt } from "@/lib/analysis/buildPrompt";
import {
  FIXES_CLOSE,
  FIXES_OPEN,
  type AnalysisCategory,
  type AnalysisCitation,
  type AnalysisErrorCode,
  type AnalysisResult,
  type AnalysisStreamEvent,
  type Fix,
  type FixPriority,
} from "@/lib/analysis/types";

/** Built-in tools the agent may use (research comes from the MCP server, not these). */
const ALLOWED_BUILTIN_TOOLS = ["Read"];
/** Built-in tools removed — no repo edits, no shell, no built-in web (use the MCP server). */
const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
];

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_USD = 1;
/** Per research-tool-call timeout (ms). */
const MCP_TOOL_TIMEOUT_MS = 90_000;

/** Typed failure surfaced to the route (mapped to an `error` SSE frame). */
export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;
  constructor(code: AnalysisErrorCode, message: string) {
    super(message);
    this.name = "AnalysisError";
    this.code = code;
  }
}

export interface RunAnalysisArgs {
  runId: string;
  category: AnalysisCategory;
  lhr: LighthouseResult;
  formFactor: FormFactor;
  /** CrUX field data for PSI runs (grounds the diagnosis in real-world data). */
  field?: FieldData | null;
  /** Optional model override; defaults to the Claude Code default model. */
  model?: string;
  /** Aborts the underlying `query()` (client disconnect / timeout). */
  signal?: AbortSignal;
  /** Progress sink — forwarded to SSE by the route. */
  onEvent: (event: AnalysisStreamEvent) => void;
}

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

/**
 * Resolve the research MCP server the analysis agent should use.
 *
 * LightAudit does NOT bundle, install, or manage a research server, and it never
 * stores that server's credentials — the server is a SEPARATE application the
 * user installs and configures themselves, and it owns its own auth. All we do is
 * read a standard MCP config and launch what it declares.
 *
 * Server selection, in order:
 *   1. the name in `LH_RESEARCH_MCP_SERVER`, if set;
 *   2. a server literally named `research`;
 *   3. the only server in the config, when there is exactly one.
 * Anything else is ambiguous and returns `null` rather than guessing.
 *
 * Returns `null` when nothing is configured — the analysis still diagnoses from
 * the Lighthouse data, it just can't cite web sources (the route warns).
 */
export function loadResearchMcpConfig(
  cwd = process.cwd(),
): McpStdioServerConfig | null {
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

    // Overlay each declared env value from process.env when present, falling back
    // to the literal in the config. We pass through what the user configured; we
    // never source a credential ourselves.
    const env: Record<string, string> = {};
    if (isRecord(server.env)) {
      for (const [key, value] of Object.entries(server.env)) {
        const fromProcess = process.env[key];
        const literal = typeof value === "string" ? value : undefined;
        const resolved = fromProcess ?? literal;
        if (resolved !== undefined) env[key] = resolved;
      }
    }

    // `alwaysLoad: true` keeps the research tools in the prompt (not deferred
    // behind tool-search) AND blocks startup until the server connects — without
    // it the agent often starts before the stdio server is ready and never gets
    // the web tools, leaving fixes ungrounded.
    return {
      type: "stdio",
      command,
      args,
      env,
      timeout: MCP_TOOL_TIMEOUT_MS,
      alwaysLoad: true,
    };
  } catch {
    return null;
  }
}

/** A short, human label for a research tool call, for the research log. */
function toolLabel(tool: string, input: Record<string, unknown>): string {
  const short = tool.replace(/^mcp__.+?__/, "");
  const query = asString(input.query);
  const url = asString(input.url);
  if (short.includes("search") && query) return `Researching: ${query}`;
  if (short.includes("research") && query) return `Deep research: ${query}`;
  if (url) {
    try {
      return `Reading: ${new URL(url).hostname}`;
    } catch {
      return `Reading: ${url}`;
    }
  }
  return `Using ${short || tool}`;
}

/** Split the agent's final text into the markdown diagnosis and the fixes JSON. */
function splitDiagnosisAndFixes(text: string): {
  diagnosis: string;
  fixesJson: string | null;
} {
  const open = text.indexOf(FIXES_OPEN);
  if (open === -1) return { diagnosis: text.trim(), fixesJson: null };
  const diagnosis = text.slice(0, open).trim();
  const after = text.slice(open + FIXES_OPEN.length);
  const close = after.indexOf(FIXES_CLOSE);
  const fixesJson = (close === -1 ? after : after.slice(0, close)).trim();
  return { diagnosis, fixesJson };
}

/** Coerce one raw priority value into a {@link FixPriority} (default "medium"). */
function coercePriority(value: unknown): FixPriority {
  return value === "high" || value === "low" ? value : "medium";
}

/** Coerce a raw citations array into {@link AnalysisCitation}[], dropping bad entries. */
function coerceCitations(value: unknown): AnalysisCitation[] {
  if (!Array.isArray(value)) return [];
  const out: AnalysisCitation[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const url = asString(entry.url);
    if (!url) continue;
    out.push({ url, title: asString(entry.title) });
  }
  return out;
}

/**
 * Parse the fixes JSON block into validated {@link Fix}[]. Tolerant: strips
 * stray markdown code fences and ignores malformed entries. Returns `[]` (the
 * route adds a warning) rather than throwing on bad/absent JSON.
 */
function parseFixes(fixesJson: string | null): Fix[] {
  if (!fixesJson) return [];
  const cleaned = fixesJson
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const rawFixes = isRecord(parsed) && Array.isArray(parsed.fixes) ? parsed.fixes : [];
  const fixes: Fix[] = [];
  for (const raw of rawFixes) {
    if (!isRecord(raw)) continue;
    const title = asString(raw.title);
    if (!title) continue;
    const steps = Array.isArray(raw.steps)
      ? raw.steps.filter((s): s is string => typeof s === "string")
      : [];
    fixes.push({
      title,
      why: asString(raw.why) ?? "",
      steps,
      priority: coercePriority(raw.priority),
      citations: coerceCitations(raw.citations),
    });
  }
  return fixes;
}

/** Deduped union of every citation across all fixes, preserving first-seen order. */
function collectSources(fixes: Fix[]): AnalysisCitation[] {
  const seen = new Set<string>();
  const sources: AnalysisCitation[] = [];
  for (const fix of fixes) {
    for (const citation of fix.citations) {
      if (seen.has(citation.url)) continue;
      seen.add(citation.url);
      sources.push(citation);
    }
  }
  return sources;
}

/** Extract a streamed text delta from a partial `stream_event` SDK message. */
function partialTextDelta(event: unknown): string | null {
  if (!isRecord(event)) return null;
  if (event.type !== "content_block_delta") return null;
  const delta = isRecord(event.delta) ? event.delta : undefined;
  if (!delta || delta.type !== "text_delta") return null;
  return asString(delta.text) ?? null;
}

/**
 * Run the analysis agent end-to-end. Streams progress via `onEvent`, returns the
 * final {@link AnalysisResult}, and throws {@link AnalysisError} on auth/agent failure.
 */
export async function runAnalysis(args: RunAnalysisArgs): Promise<AnalysisResult> {
  const { runId, category, lhr, formFactor, field, model, signal, onEvent } = args;

  const input = buildAnalysisInput({ lhr, category, formFactor, field });
  const userPrompt = buildUserPrompt(input);
  const research = loadResearchMcpConfig();
  const warnings: string[] = [];

  // Bridge an external AbortSignal (client disconnect / timeout) into the SDK.
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const stream = query({
    prompt: userPrompt,
    options: {
      abortController,
      cwd: process.cwd(),
      ...(model ? { model } : {}),
      systemPrompt: ANALYSIS_SYSTEM_PROMPT,
      maxTurns: DEFAULT_MAX_TURNS,
      maxBudgetUsd: Number(process.env.ANALYSIS_MAX_USD ?? DEFAULT_MAX_USD),
      includePartialMessages: true,
      // Fully non-interactive: bypass prompts (safety comes from the tool allow/deny
      // lists below, not from interactive approval, which a headless route can't do).
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // SDK isolation: ignore on-disk settings (CLAUDE.md, allow rules) AND any
      // MCP config other than the one we pass inline — no duplicate server.
      settingSources: [],
      strictMcpConfig: true,
      tools: ALLOWED_BUILTIN_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      ...(research ? { mcpServers: { research } } : {}),
      // NOTE: `env` is intentionally omitted — passing it REPLACES the subprocess
      // env and would strip the Claude Code OAuth credentials + PATH.
    },
  });

  let resolvedModel = model ?? "";
  let rawText = "";
  let emittedDiagnosisLen = 0;
  let sawToolUse = false;
  let sawWriting = false;
  let result: AnalysisResult | null = null;

  /**
   * Append assistant text and stream the *diagnosis* portion only — everything
   * before {@link FIXES_OPEN}. Holds back a short tail so a partial sentinel
   * forming across deltas is never emitted as diagnosis prose.
   */
  const pushText = (chunk: string): void => {
    if (!chunk) return;
    rawText += chunk;
    const open = rawText.indexOf(FIXES_OPEN);
    const safeEnd =
      open !== -1 ? open : Math.max(0, rawText.length - FIXES_OPEN.length);
    if (safeEnd <= emittedDiagnosisLen) return;
    const delta = rawText.slice(emittedDiagnosisLen, safeEnd);
    emittedDiagnosisLen = safeEnd;
    if (!sawWriting && sawToolUse) {
      sawWriting = true;
      onEvent({ type: "status", phase: "writing", message: "Writing diagnosis…" });
    }
    onEvent({ type: "text-delta", delta });
  };

  try {
    for await (const message of stream) {
      if (!isRecord(message)) continue;

      // 1. Session init: report auth + MCP connection, then enter "diagnosing".
      if (message.type === "system" && message.subtype === "init") {
        resolvedModel = asString(message.model) ?? resolvedModel;
        const apiKeySource = asString(message.apiKeySource);
        const auth =
          apiKeySource === "oauth"
            ? "oauth"
            : apiKeySource
              ? "api-key"
              : "unknown";
        const mcp = Array.isArray(message.mcp_servers)
          ? message.mcp_servers
              .filter(isRecord)
              .map((s) => ({
                name: asString(s.name) ?? "",
                status: asString(s.status) ?? "",
              }))
          : [];
        const researchStatus = mcp.find((s) => s.name === "research");
        if (!research) {
          warnings.push(
            "No research MCP server configured — fixes may be ungrounded.",
          );
        } else if (researchStatus && researchStatus.status !== "connected") {
          warnings.push(
            `Research MCP server did not connect (status: ${researchStatus.status}) — fixes may be ungrounded.`,
          );
        }
        onEvent({
          type: "status",
          phase: "preflight",
          message: "Connecting Claude + research tools…",
          model: resolvedModel,
          auth,
          mcp,
        });
        onEvent({ type: "status", phase: "diagnosing", message: "Reading the audit data…" });
        continue;
      }

      // 2. Partial assistant text → stream the diagnosis live.
      if (message.type === "stream_event") {
        const delta = partialTextDelta(message.event);
        if (delta) pushText(delta);
        continue;
      }

      // 3. Assistant turn: surface tool calls (and catch auth failures).
      if (message.type === "assistant") {
        if (message.error === "authentication_failed" || message.error === "oauth_org_not_allowed") {
          throw new AnalysisError(
            "claude_auth_required",
            "Claude Code is not logged in on this machine. Run `claude` (or `claude login`) once, then retry.",
          );
        }
        const content = isRecord(message.message) ? message.message.content : undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block) || block.type !== "tool_use") continue;
            const id = asString(block.id) ?? "";
            const tool = asString(block.name) ?? "";
            const toolInput = isRecord(block.input) ? block.input : {};
            if (!sawToolUse) {
              sawToolUse = true;
              onEvent({ type: "status", phase: "researching", message: "Researching fixes on the web…" });
            }
            onEvent({
              type: "tool-use",
              id,
              tool,
              label: toolLabel(tool, toolInput),
              query: asString(toolInput.query),
              url: asString(toolInput.url),
            });
          }
        }
        continue;
      }

      // 4. Tool results → mark the matching research step done.
      if (message.type === "user") {
        const content = isRecord(message.message) ? message.message.content : undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block) || block.type !== "tool_result") continue;
            onEvent({
              type: "tool-result",
              id: asString(block.tool_use_id) ?? "",
              ok: block.is_error !== true,
            });
          }
        }
        continue;
      }

      // 5. Terminal result → parse, emit fixes, build the AnalysisResult.
      if (message.type === "result") {
        if (message.subtype !== "success") {
          const errors = Array.isArray(message.errors)
            ? message.errors.filter((e): e is string => typeof e === "string").join("; ")
            : "";
          throw new AnalysisError(
            "agent_error",
            errors || `Analysis ended early (${asString(message.subtype) ?? "unknown"}).`,
          );
        }

        onEvent({ type: "status", phase: "finalizing", message: "Finishing up…" });

        // Prefer the authoritative final text; fall back to the streamed text.
        const finalText = asString(message.result) || rawText;
        const { diagnosis, fixesJson } = splitDiagnosisAndFixes(finalText);
        const fixes = parseFixes(fixesJson);
        if (fixes.length === 0) {
          warnings.push("Could not parse structured fixes from the model output.");
        }
        fixes.forEach((fix, index) => onEvent({ type: "fix", index, fix }));

        result = {
          runId,
          category,
          categoryScore: input.categoryScore,
          diagnosis: diagnosis || finalText.trim(),
          fixes,
          sources: collectSources(fixes),
          model: resolvedModel || "claude",
          createdAt: new Date().toISOString(),
          costUsd: asNumber(message.total_cost_usd) ?? undefined,
          turns: asNumber(message.num_turns) ?? undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
    }
  } catch (err) {
    if (err instanceof AnalysisError) throw err;
    // Abort is an expected control-flow signal, not a failure — re-raise as-is so
    // the route can distinguish it (client disconnect / timeout) from agent errors.
    if (abortController.signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AnalysisError("agent_error", message);
  }

  if (!result) {
    throw new AnalysisError("agent_error", "The analysis ended without a result.");
  }
  return result;
}
