/**
 * Shared contract for the AI score-analysis feature.
 *
 * A user clicks a Lighthouse category score (Performance / Accessibility /
 * Best Practices / SEO / Agentic Browsing) and the app runs the Claude Agent SDK — reusing the
 * user's configured research MCP server for web research — to (1) diagnose why that category
 * scored low from the audit data and (2) propose prioritized, source-cited fixes.
 *
 * This module is the single seam both sides code against:
 *  - the server engine (`runAnalysis.ts`) and route emit {@link AnalysisStreamEvent}s
 *    and persist an {@link AnalysisResult};
 *  - the browser hook (`useAnalysisStream`) folds the events and the client
 *    (`auditClient.getAnalysis`) reads a persisted {@link AnalysisResult}.
 *
 * Keep it import-light (types only, no runtime/SDK imports) so it is safe to
 * import from both client and server code.
 */

import type { LighthouseCategory } from "@/lib/lighthouse/types";

/**
 * The score a user can analyze — any member of `LIGHTHOUSE_CATEGORIES`. It
 * tracks that list by definition, so Lighthouse 13.3's fifth category (Agentic
 * Browsing) is analysable with no change here or at the API seam (the analyze
 * route validates against the same list).
 */
export type AnalysisCategory = LighthouseCategory;

/**
 * AI backends the analysis can run on. All three are the USER's own: `claude`
 * uses their Claude Code/Max login or their `ANTHROPIC_API_KEY`; `ollama` talks
 * to a model they installed locally; `openai-compatible` is any base URL + key +
 * model they supply. LightAudit Score ships no AI credential of its own.
 *
 * Additive: new ids may be appended, and readers must tolerate an unknown one
 * (see `parseProviderModel`).
 */
export const ANALYSIS_PROVIDER_IDS = [
  "claude",
  "ollama",
  "openai-compatible",
] as const;

/** One of {@link ANALYSIS_PROVIDER_IDS}. */
export type AnalysisProviderId = (typeof ANALYSIS_PROVIDER_IDS)[number];

/** Short human labels for the provider badge / settings copy. */
export const ANALYSIS_PROVIDER_LABELS: Record<AnalysisProviderId, string> = {
  claude: "Claude",
  ollama: "Ollama",
  "openai-compatible": "Custom",
};

/** A web source the agent actually fetched while researching a fix. */
export interface AnalysisCitation {
  /** Absolute URL of the source. */
  url: string;
  /** Optional human title (falls back to the hostname in the UI). */
  title?: string;
}

/** Relative urgency of a fix, used for ordering + the priority chip. */
export type FixPriority = "high" | "medium" | "low";

/** One concrete, web-researched remediation for a low score. */
export interface Fix {
  /** Short imperative title, e.g. "Defer offscreen images". */
  title: string;
  /** Why it matters / how it moves this category's score. */
  why: string;
  /** Ordered, concrete steps to apply the fix. */
  steps: string[];
  /** Relative urgency (drives ordering + the priority chip). */
  priority: FixPriority;
  /** One or more sources backing this fix (every fix must cite ≥1). */
  citations: AnalysisCitation[];
}

/**
 * The full result of analyzing one category of one run — streamed on completion
 * (`done`) and persisted so reopening the run shows it instantly without
 * re-spending tokens. Keyed by `(runId, category)`.
 */
export interface AnalysisResult {
  /** The run analyzed (== report runId == job id). */
  runId: string;
  /** Which category was analyzed. */
  category: AnalysisCategory;
  /** The 0–100 score at analysis time (null if that category wasn't scored). */
  categoryScore: number | null;
  /** Prose diagnosis (markdown) explaining why the score is low. */
  diagnosis: string;
  /** Prioritized, cited fixes. */
  fixes: Fix[];
  /** Deduped union of every citation across all fixes (for a "sources" footer). */
  sources: AnalysisCitation[];
  /**
   * Provider + model that produced the analysis, encoded `"<provider>/<model>"`
   * (e.g. `"ollama/llama3.1:8b"`). Read it with `parseProviderModel`, which also
   * tolerates the bare model ids written before providers existed.
   */
  model: string;
  /** ISO timestamp the analysis was produced. */
  createdAt: string;
  /** Total API cost in USD, when the SDK reports it. */
  costUsd?: number;
  /** Number of agentic turns taken. */
  turns?: number;
  /** Soft warnings (e.g. research MCP not connected → fixes ungrounded). */
  warnings?: string[];
}

/** Coarse phase of an in-flight analysis, surfaced as a status line. */
export type AnalysisPhase =
  | "preflight"
  | "diagnosing"
  | "researching"
  | "writing"
  | "finalizing";

/** How the Agent SDK authenticated (drives the "not logged in" error path). */
export type AnalysisAuth = "oauth" | "api-key" | "unknown";

/** One MCP server's connection status from the SDK `init` message. */
export interface AnalysisMcpStatus {
  name: string;
  status: string;
}

/**
 * Discriminated union of Server-Sent Events the analyze route emits. Each event's
 * `type` is also its SSE `event:` name, so values must be SSE-safe (no spaces).
 * Mirrors the style of `ProgressEvent` in `@/lib/queue/types`.
 */
export type AnalysisStreamEvent =
  | {
      type: "status";
      phase: AnalysisPhase;
      message?: string;
      model?: string;
      auth?: AnalysisAuth;
      mcp?: AnalysisMcpStatus[];
    }
  | {
      type: "tool-use";
      /** SDK tool_use block id (correlates with `tool-result`). */
      id: string;
      /** Raw tool name, e.g. "mcp__research__search_web". */
      tool: string;
      /** Human label for the research log, e.g. "Researching: core web vitals". */
      label: string;
      /** The search query, when the tool call carried one. */
      query?: string;
      /** The fetched URL, when the tool call carried one. */
      url?: string;
    }
  | { type: "tool-result"; id: string; ok: boolean }
  | { type: "text-delta"; delta: string }
  | { type: "fix"; index: number; fix: Fix }
  | { type: "done"; analysis: AnalysisResult }
  | { type: "error"; code: AnalysisErrorCode; message: string };

/** Stable, machine-readable error codes the analyze route can surface. */
export type AnalysisErrorCode =
  | "invalid_category"
  | "report_not_found"
  | "category_not_run"
  | "analysis_in_progress"
  | "analysis_timeout"
  | "claude_auth_required"
  | "agent_error"
  // Added with the provider seam — consumers treat unknown codes generically.
  | "invalid_provider"
  | "provider_not_configured"
  | "provider_unavailable"
  | "rate_limited";

/** Sentinel framing the agent wraps its final fixes JSON in (parsed server-side). */
export const FIXES_OPEN = "<<<FIXES_JSON>>>";
export const FIXES_CLOSE = "<<<END_FIXES_JSON>>>";
