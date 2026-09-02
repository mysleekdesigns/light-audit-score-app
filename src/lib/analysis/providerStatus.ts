/**
 * The shape `GET /api/settings/ai-provider` returns — the one description of
 * "which AI will run an analysis" that the server produces and the client reads.
 *
 * Types only, and deliberately credential-free: a provider's key is represented
 * by the NAME of its env var plus a boolean, never a value. Keeping this module
 * pure means client components can type the response without pulling any server
 * code into the bundle.
 */

import type { AnalysisProviderId } from "@/lib/analysis/types";

/** One model the user has pulled into a local Ollama. */
export interface OllamaModel {
  /** Full tag, e.g. `"llama3.1:8b"` — this is what goes in `LH_ANALYSIS_MODEL`. */
  name: string;
  /** Parameter count as Ollama reports it, e.g. `"8.0B"`. */
  parameterSize?: string;
  /** Quantization, e.g. `"Q4_K_M"`. */
  quantization?: string;
  /** On-disk size in bytes. */
  sizeBytes?: number;
}

/** What a detection probe found on the local machine. */
export interface OllamaStatus {
  running: boolean;
  /** Root URL that was probed (redacted of any userinfo). */
  baseUrl: string | null;
  models: OllamaModel[];
}

/** Everything the settings panel and the analysis empty state need to be honest. */
export interface AiProviderStatus {
  /** The provider an analysis would use right now. */
  provider: AnalysisProviderId;
  /** Its short human label. */
  label: string;
  /** The driver behind it. */
  driver: string;
  /** Model id, or `""` when the provider picks its own default. */
  model: string;
  /** Endpoint for OpenAI-compatible providers, redacted; `null` for Claude. */
  baseUrl: string | null;
  /** Whether this provider can do web research at all (capability tier). */
  canWebResearch: boolean;
  /** Whether a research server is actually resolvable right now. */
  researchConfigured: boolean;
  /** Env var this provider's key would live in, if it uses one. Never the key. */
  apiKeyEnv: string | null;
  /** Whether that env var is set. Presence only. */
  hasApiKey: boolean;
  /** What the user still has to set before this provider can run, if anything. */
  missing: string | null;
  /** Local Ollama detection (skipped when the caller passes `?probe=0`). */
  ollama: OllamaStatus;
}
