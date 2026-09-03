/**
 * Server-only engine for the AI score analysis — the provider-independent half.
 *
 * It owns everything that must be identical whichever AI runs the job: turning
 * the LHR into a bounded input, choosing the prompts for the resolved provider's
 * capability tier, invoking the driver, collecting sources, and assembling the
 * {@link AnalysisResult}. The model work itself lives behind the
 * {@link AnalysisDriver} seam (`providers/`), which is what keeps
 * {@link AnalysisStreamEvent} frozen: a new backend is a new driver, never a
 * change to the hook or the analysis panels.
 *
 * Auth is ALWAYS the user's own — their Claude login, their provider key from
 * `process.env`, or a local Ollama needing none. LightAudit ships no AI
 * credential.
 *
 * The function streams progress to the caller via `onEvent` (status / tool-use /
 * tool-result / text-delta / fix) and RETURNS the final {@link AnalysisResult}.
 * It THROWS {@link AnalysisError} on auth/provider/agent failure; the route owns
 * the terminal `done` / `error` SSE frames and persistence. Node runtime only.
 */

import type { FieldData, FormFactor, LighthouseResult } from "@/lib/lighthouse/types";
import { AnalysisError } from "@/lib/analysis/AnalysisError";
import { buildAnalysisInput } from "@/lib/analysis/extract";
import { analysisSystemPrompt, buildUserPrompt } from "@/lib/analysis/buildPrompt";
import { formatProviderModel } from "@/lib/analysis/providerModel";
import { claudeDriver } from "@/lib/analysis/providers/claude";
import { openAiCompatibleDriver } from "@/lib/analysis/providers/openaiCompatible";
import { resolveResearchServer } from "@/lib/analysis/providers/researchMcp";
import { resolveConfiguredProvider } from "@/lib/analysis/providers/preference";
import type { ProviderOverride } from "@/lib/analysis/providers/select";
import type { AnalysisDriver, ResolvedProvider } from "@/lib/analysis/providers/types";
import { collectSources } from "@/lib/analysis/structured";
import type {
  AnalysisCategory,
  AnalysisResult,
  AnalysisStreamEvent,
} from "@/lib/analysis/types";

export { AnalysisError } from "@/lib/analysis/AnalysisError";
// Both moved out of this file when the provider seam landed; re-exported so the
// engine stays the one import site callers already know.
export {
  hasResearchMcpConfig,
  loadResearchMcpConfig,
} from "@/lib/analysis/providers/researchMcp";

/** Every driver, keyed by the id a {@link ResolvedProvider} names. */
const DRIVERS: Record<string, AnalysisDriver> = {
  claude: claudeDriver,
  "openai-compatible": openAiCompatibleDriver,
};

export interface RunAnalysisArgs {
  runId: string;
  category: AnalysisCategory;
  lhr: LighthouseResult;
  formFactor: FormFactor;
  /** CrUX field data for PSI runs (grounds the diagnosis in real-world data). */
  field?: FieldData | null;
  /** Optional model override; defaults to the provider's configured model. */
  model?: string;
  /** Optional provider override for this analysis; defaults to the Settings choice, then the env selection. */
  provider?: string;
  /** Aborts the underlying model call (client disconnect / timeout). */
  signal?: AbortSignal;
  /** Progress sink — forwarded to SSE by the route. */
  onEvent: (event: AnalysisStreamEvent) => void;
}

/** Resolve the provider for a request, rejecting an unusable configuration. */
function selectProvider(override: ProviderOverride): ResolvedProvider {
  const provider = resolveConfiguredProvider(override);
  if (provider.missing) {
    throw new AnalysisError("provider_not_configured", provider.missing);
  }
  const driver = DRIVERS[provider.driver];
  if (!driver) {
    throw new AnalysisError(
      "invalid_provider",
      `No driver is registered for "${provider.driver}".`,
    );
  }
  return provider;
}

/**
 * Run the analysis end-to-end on whichever provider is configured. Streams
 * progress via `onEvent`, returns the final {@link AnalysisResult}, and throws
 * {@link AnalysisError} on failure.
 */
export async function runAnalysis(args: RunAnalysisArgs): Promise<AnalysisResult> {
  const { runId, category, lhr, formFactor, field, model, provider, signal, onEvent } =
    args;

  const resolved = selectProvider({ provider, model });
  const driver = DRIVERS[resolved.driver];

  const input = buildAnalysisInput({ lhr, category, formFactor, field });
  // The capability tier picks the prompt pair: the researching agent when the
  // provider can cite what it fetched, the honest data-only analyst when it can't.
  //
  // It takes BOTH halves — a provider that supports research and a research
  // server to drive. Claude supports it, but the server is optional user-supplied
  // software, so `canWebResearch` alone would promise tools that may not exist:
  // the agent would then either narrate the shortfall mid-diagnosis or reach for
  // a URL it never opened. Resolving the tier from the config instead means an
  // unconfigured install gets a clean, honestly uncited analysis.
  //
  // Resolved here (not just tested) because the server may carry guidance for
  // the prompt — which tools to reach for, and what they cost the user.
  const research = resolved.canWebResearch ? resolveResearchServer() : null;
  const webResearch = research !== null;

  const result = await driver.run({
    provider: resolved,
    systemPrompt: analysisSystemPrompt(webResearch, {
      researchGuidance: research?.promptGuidance,
    }),
    userPrompt: buildUserPrompt(input, { webResearch }),
    webResearch,
    signal,
    onEvent,
  });

  result.fixes.forEach((fix, index) => onEvent({ type: "fix", index, fix }));

  return {
    runId,
    category,
    categoryScore: input.categoryScore,
    diagnosis: result.diagnosis,
    fixes: result.fixes,
    sources: collectSources(result.fixes),
    // Provider AND model, so every analysis can be badged with what produced it.
    model: formatProviderModel(resolved.id, result.model),
    createdAt: new Date().toISOString(),
    costUsd: result.costUsd,
    turns: result.turns,
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  };
}
