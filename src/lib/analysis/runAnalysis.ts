/**
 * Server-only engine for the AI score analysis.
 *
 * Embeds the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as a headless,
 * read-only research agent that reuses the project's EXISTING CrawlForge MCP
 * server (loaded from `.mcp.json`) to diagnose a low Lighthouse category score
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

/** Built-in tools the agent may use (research comes from CrawlForge MCP, not these). */
const ALLOWED_BUILTIN_TOOLS = ["Read"];
/** Built-in tools explicitly removed — no repo edits, no shell, no built-in web (use CrawlForge). */
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
/** Per CrawlForge tool-call timeout (ms). */
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
 * Read the `crawlforge` stdio server config from the project's `.mcp.json`,
 * overlaying each env value from `process.env` when present (so secrets can move
 * to `.env` later) and falling back to the `.mcp.json` literal. Returns `null`
 * when `.mcp.json` is absent or has no crawlforge server — the analysis can still
 * diagnose, but its fixes won't be web-grounded (the route surfaces a warning).
 */
export function loadCrawlforgeMcpConfig(
  cwd = process.cwd(),
): McpStdioServerConfig | null {
  try {
    const raw = readFileSync(path.join(cwd, ".mcp.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return null;
    const server = parsed.mcpServers.crawlforge;
    if (!isRecord(server)) return null;

    const command = asString(server.command);
    if (!command) return null;
    const args = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === "string")
      : [];

    const env: Record<string, string> = {};
    if (isRecord(server.env)) {
      for (const [key, value] of Object.entries(server.env)) {
        const fromProcess = process.env[key];
        const literal = typeof value === "string" ? value : undefined;
        const resolved = fromProcess ?? literal;
        if (resolved !== undefined) env[key] = resolved;
      }
    }

    // `alwaysLoad: true` keeps the CrawlForge tools in the prompt (not deferred
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

/** A short, human label for a CrawlForge tool call, for the research log. */
function toolLabel(tool: string, input: Record<string, unknown>): string {
  const short = tool.replace(/^mcp__crawlforge__/, "");
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
  const crawlforge = loadCrawlforgeMcpConfig();
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
      // MCP config other than the one we pass inline — no duplicate crawlforge.
      settingSources: [],
      strictMcpConfig: true,
      tools: ALLOWED_BUILTIN_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      ...(crawlforge ? { mcpServers: { crawlforge } } : {}),
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
        const crawlforgeStatus = mcp.find((s) => s.name === "crawlforge");
        if (!crawlforge) {
          warnings.push("CrawlForge MCP not found in .mcp.json — fixes may be ungrounded.");
        } else if (crawlforgeStatus && crawlforgeStatus.status !== "connected") {
          warnings.push(
            `CrawlForge MCP did not connect (status: ${crawlforgeStatus.status}) — fixes may be ungrounded.`,
          );
        }
        onEvent({
          type: "status",
          phase: "preflight",
          message: "Connecting Claude + CrawlForge…",
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
