/**
 * The Claude driver — the premium analysis path, unchanged from the single-driver
 * engine that preceded the provider seam.
 *
 * It embeds the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as a
 * headless, read-only research agent, optionally driving a user-configured
 * research MCP server so every fix cites a page the model actually opened. Auth
 * is the user's own Claude Code / Max login on this machine (or their
 * `ANTHROPIC_API_KEY`): we never set a key and we omit the SDK `env` option so
 * the spawned subprocess inherits `process.env`, and therefore those creds.
 *
 * Streams progress through {@link AnalysisStreamEvent} exactly as before —
 * status / tool-use / tool-result / text-delta — and returns a
 * {@link DriverResult}; the engine owns the terminal `done`/`error` frames.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

import { asNumber, asString, isRecord } from "@/lib/lighthouse/parseLhr";
import { AnalysisError } from "@/lib/analysis/AnalysisError";
import {
  RESEARCH_MCP_NAME,
  loadResearchMcpConfig,
} from "@/lib/analysis/providers/researchMcp";
import type { AnalysisDriver, DriverResult, DriverRunArgs } from "@/lib/analysis/providers/types";
import { parseFixes, splitDiagnosisAndFixes } from "@/lib/analysis/structured";
import { redactUrlsInText } from "@/lib/redactUrl";
import { FIXES_OPEN } from "@/lib/analysis/types";

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

/** Extract a streamed text delta from a partial `stream_event` SDK message. */
function partialTextDelta(event: unknown): string | null {
  if (!isRecord(event)) return null;
  if (event.type !== "content_block_delta") return null;
  const delta = isRecord(event.delta) ? event.delta : undefined;
  if (!delta || delta.type !== "text_delta") return null;
  return asString(delta.text) ?? null;
}

/**
 * Render an MCP server's status for a user-facing warning.
 *
 * The SDK types this as a bare `string`, and the warning is persisted to
 * `analyses.warnings` and rendered in the UI, so bound it rather than passing it
 * through: a short lower-case token describing a server the USER declared.
 */
function describeMcpStatus(status: string | undefined): string {
  if (status === undefined) return "not reported";
  const cleaned = status.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim();
  return cleaned ? cleaned.slice(0, 32) : "unknown";
}

/**
 * Whether an agent failure is the user hitting their own plan limit (Claude's
 * rolling 5-hour window) rather than something broken — worth a friendly
 * "try again later" instead of a red error.
 */
function isRateLimit(message: string): boolean {
  return /rate.?limit|usage limit|quota|429|too many requests/i.test(message);
}

/** Run one analysis on the Claude Agent SDK. */
async function run(args: DriverRunArgs): Promise<DriverResult> {
  const { provider, systemPrompt, userPrompt, webResearch, signal, onEvent } = args;

  const research = loadResearchMcpConfig();
  const warnings: string[] = [];
  /**
   * Whether the research tools are genuinely in the agent's hands — the gate on
   * whether a citation is believable.
   *
   * Starts `false` and is only raised by POSITIVE evidence in the init message
   * below: the engine prompted for research, a server was declared, and the SDK
   * reports it connected. Inferring it from the absence of a failure would trust
   * every gap — a config that changed between the engine's read and ours, a
   * server the SDK never lists, an init frame that never arrives — and each of
   * those is a run with no fetch tool whose invented URLs would be persisted as
   * sources.
   */
  let researchAvailable = false;
  /** Whether the session ever reported its MCP state — see the `result` branch. */
  let sawInit = false;

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
      ...(provider.model ? { model: provider.model } : {}),
      systemPrompt,
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
      ...(research ? { mcpServers: { [RESEARCH_MCP_NAME]: research } } : {}),
      // NOTE: `env` is intentionally omitted — passing it REPLACES the subprocess
      // env and would strip the Claude Code OAuth credentials + PATH.
    },
  });

  let resolvedModel = provider.model;
  let rawText = "";
  let emittedDiagnosisLen = 0;
  let sawToolUse = false;
  let sawWriting = false;
  let result: DriverResult | null = null;

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
        const researchStatus = mcp.find((s) => s.name === RESEARCH_MCP_NAME);
        // Guarded: a resumed or compacted session can init twice, and the tier
        // is settled by the first one.
        if (!sawInit) {
          sawInit = true;
          researchAvailable =
            webResearch && research !== null && researchStatus?.status === "connected";
          if (!research) {
            // Not a failure, and not a surprise to the model either: the engine
            // already prompted it as a data-only analyst, so say what the reader
            // actually got rather than hedging with "may be".
            warnings.push(
              "No research MCP server configured — this analysis comes from the Lighthouse data alone, with no cited sources.",
            );
          } else if (!researchAvailable) {
            // A server was declared but its tools are not in hand. Two ways that
            // happens, and they need different words: saying "did not connect"
            // about a server we just read as `connected` would flatly contradict
            // the status in the same sentence.
            warnings.push(
              researchStatus?.status === "connected"
                ? "A research MCP server was configured after this analysis started — the model was prompted without research tools, so its fixes are uncited."
                : `Research MCP server did not connect (status: ${describeMcpStatus(researchStatus?.status)}) — fixes are ungrounded and uncited.`,
            );
          }
        }
        onEvent({
          type: "status",
          phase: "preflight",
          message: research
            ? "Connecting Claude + research tools…"
            : "Connecting Claude…",
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

      // 5. Terminal result → parse and hand the engine a DriverResult.
      if (message.type === "result") {
        if (message.subtype !== "success") {
          const errors = Array.isArray(message.errors)
            ? message.errors.filter((e): e is string => typeof e === "string").join("; ")
            : "";
          // SDK-authored text. This driver spawns the research server with the
          // user's own third-party credentials, so nothing it says reaches the
          // client without a scrub first.
          const detail = redactUrlsInText(
            errors || `Analysis ended early (${asString(message.subtype) ?? "unknown"}).`,
          );
          throw new AnalysisError(
            isRateLimit(detail) ? "rate_limited" : "agent_error",
            detail,
          );
        }

        onEvent({ type: "status", phase: "finalizing", message: "Finishing up…" });

        // Prefer the authoritative final text; fall back to the streamed text.
        const finalText = asString(message.result) || rawText;
        const { diagnosis, fixesJson } = splitDiagnosisAndFixes(finalText);
        // A session that never announced its MCP state is ungrounded by default,
        // and the init branch that normally explains that never ran. Say it here
        // instead: stripping citations silently would leave the persisted record
        // indistinguishable from a genuinely researched run.
        if (!sawInit && !researchAvailable) {
          warnings.push(
            "Web research was unavailable for this analysis — fixes are ungrounded and uncited.",
          );
        }

        // Citations only survive when the agent actually held a fetch tool: with
        // none, any URL it produced is a guess, however confidently phrased.
        const parsed = parseFixes(fixesJson, { allowCitations: researchAvailable });
        if (parsed.error !== null) {
          warnings.push("Could not parse structured fixes from the model output.");
        }

        result = {
          diagnosis: diagnosis || finalText.trim(),
          fixes: parsed.fixes,
          model: resolvedModel || "claude",
          costUsd: asNumber(message.total_cost_usd) ?? undefined,
          turns: asNumber(message.num_turns) ?? undefined,
          warnings,
        };
      }
    }
  } catch (err) {
    if (err instanceof AnalysisError) throw err;
    // Abort is an expected control-flow signal, not a failure — re-raise as-is so
    // the route can distinguish it (client disconnect / timeout) from agent errors.
    if (abortController.signal.aborted) throw err;
    const message = redactUrlsInText(err instanceof Error ? err.message : String(err));
    throw new AnalysisError(
      isRateLimit(message) ? "rate_limited" : "agent_error",
      message,
    );
  }

  if (!result) {
    throw new AnalysisError("agent_error", "The analysis ended without a result.");
  }
  return result;
}

/** The Claude Agent SDK driver. */
export const claudeDriver: AnalysisDriver = { driver: "claude", run };
