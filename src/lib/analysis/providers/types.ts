/**
 * The `AnalysisProvider` seam: what every AI backend must look like from the
 * engine's side.
 *
 * `runAnalysis.ts` owns everything provider-independent — turning the LHR into a
 * bounded input, building the prompts, collecting sources, assembling the
 * {@link AnalysisResult} — and hands the model work to one {@link AnalysisDriver}.
 * A driver's ONLY job is to produce a diagnosis + fixes while adapting whatever
 * its SDK streams into {@link AnalysisStreamEvent}s. That is what keeps the
 * frozen contract frozen: adding a driver never touches `useAnalysisStream` or
 * the analysis panels.
 *
 * Import-light and server-agnostic (types only) so both drivers and the settings
 * route can depend on it.
 */

import type {
  AnalysisProviderId,
  AnalysisStreamEvent,
  Fix,
} from "@/lib/analysis/types";

/** Which implementation backs a provider. Several providers can share one. */
export type AnalysisDriverId = "claude" | "openai-compatible";

/**
 * A fully-resolved choice of AI backend: which provider, which model, where it
 * lives, and what it is capable of. Produced by `resolveAnalysisProvider` from
 * the environment (plus an optional per-analysis override).
 *
 * Deliberately carries the NAME of the env var holding the API key rather than
 * the key itself, so this object is safe to hand to the settings endpoint.
 */
export interface ResolvedProvider {
  /** The provider the user selected (drives labels + the analysis badge). */
  id: AnalysisProviderId;
  /** The driver implementing it. */
  driver: AnalysisDriverId;
  /** Model id to run. Empty means "let the driver use its own default". */
  model: string;
  /** OpenAI-compatible chat-completions base URL; `null` for the Claude driver. */
  baseUrl: string | null;
  /** Env var NAME holding this provider's API key, if it uses one. Never the key. */
  apiKeyEnv: string | null;
  /**
   * Whether this provider can do web research **at all** — a static property of
   * the backend, not of the current machine. Claude can (through a
   * user-configured research MCP server); a local model driving no tools cannot,
   * so its fixes are LHR-data-only and must be badged ungrounded.
   *
   * This is a capability, NOT the tier a given run executes at: research also
   * needs a server to drive. The effective tier is this AND
   * `hasResearchMcpConfig()`, resolved by `runAnalysis` and passed to the driver
   * as {@link DriverRunArgs.webResearch}.
   */
  canWebResearch: boolean;
  /** What the user still has to set before this provider can run, if anything. */
  missing: string | null;
}

/** Everything a driver needs for one analysis. */
export interface DriverRunArgs {
  provider: ResolvedProvider;
  /** Role + process + output-format instructions for this capability tier. */
  systemPrompt: string;
  /** The serialized audit data + task. */
  userPrompt: string;
  /**
   * The EFFECTIVE tier the prompts above were built at: whether this run can
   * really research the web (provider capability AND a resolvable research
   * server). Drivers must honour it — chiefly by refusing citations when it is
   * false, since a model with no fetch tool can only have invented them.
   */
  webResearch: boolean;
  /** Aborts the underlying model call (client disconnect / timeout). */
  signal?: AbortSignal;
  /** Progress sink — forwarded to SSE by the route. */
  onEvent: (event: AnalysisStreamEvent) => void;
}

/** What a driver hands back. `runAnalysis` turns this into an `AnalysisResult`. */
export interface DriverResult {
  /** Prose diagnosis (markdown). */
  diagnosis: string;
  /** Parsed, validated fixes — `[]` when the model's JSON was unrecoverable. */
  fixes: Fix[];
  /** The model id actually used, as the provider reported it. */
  model: string;
  /** Total API cost in USD, when the driver can know it. */
  costUsd?: number;
  /** Number of agentic turns taken, when meaningful. */
  turns?: number;
  /** Soft warnings (ungrounded fixes, prose-only degrade, …). */
  warnings: string[];
}

/** One AI backend, adapted to the frozen stream contract. */
export interface AnalysisDriver {
  readonly driver: AnalysisDriverId;
  run(args: DriverRunArgs): Promise<DriverResult>;
}
