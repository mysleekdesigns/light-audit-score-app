/**
 * The OpenAI-compatible driver — one HTTP shape, many backends.
 *
 * Anything that speaks OpenAI's `/chat/completions` runs here: a local Ollama
 * model (`http://localhost:11434/v1`), LM Studio, vLLM, OpenRouter, OpenAI
 * itself. The provider seam decides WHICH; this file only knows "base URL + key
 * + model", which is why adding another vendor is configuration rather than code.
 *
 * Capability tier — deliberately ungrounded. We drive these models with no
 * tools, so the analysis is diagnosed from the Lighthouse data alone: no web
 * research, and citations are stripped rather than trusted, because a model
 * without a fetch tool can only invent a URL. The engine warns and the UI badges
 * the result "no web research"; an honest uncited fix beats a fabricated source.
 *
 * Structured output — small models are sloppy about JSON, so a failed fixes
 * block gets ONE narrow repair pass (reformat what you already wrote) before the
 * driver degrades to a prose-only diagnosis. It never crashes the stream.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, streamText } from "ai";

import { AnalysisError } from "@/lib/analysis/AnalysisError";
import { readProviderApiKey } from "@/lib/analysis/providers/select";
import type {
  AnalysisDriver,
  DriverResult,
  DriverRunArgs,
  ResolvedProvider,
} from "@/lib/analysis/providers/types";
import {
  FIXES_REPAIR_SYSTEM_PROMPT,
  buildRepairPrompt,
  parseFixes,
  splitDiagnosisAndFixes,
} from "@/lib/analysis/structured";
import { ANALYSIS_PROVIDER_LABELS, FIXES_OPEN } from "@/lib/analysis/types";

/** Low but non-zero: we want deterministic diagnosis, not creative writing. */
const TEMPERATURE = 0.2;
/** Enough for a full diagnosis plus a dozen fixes; keeps a runaway model bounded. */
const MAX_OUTPUT_TOKENS = 4_096;
/** The repair turn only reformats existing text, so it needs no headroom of its own. */
const REPAIR_MAX_OUTPUT_TOKENS = 3_072;
/** These endpoints are local or user-owned; one retry is plenty. */
const MAX_RETRIES = 1;

/** Build the AI SDK model handle for a resolved provider. */
function createModel(provider: ResolvedProvider) {
  if (!provider.baseUrl) {
    throw new AnalysisError(
      "provider_not_configured",
      provider.missing ?? "This provider has no base URL configured.",
    );
  }
  if (!provider.model) {
    throw new AnalysisError(
      "provider_not_configured",
      provider.missing ?? "This provider has no model configured.",
    );
  }

  const apiKey = readProviderApiKey(provider, process.env);
  const client = createOpenAICompatible({
    name: provider.id,
    baseURL: provider.baseUrl,
    // Omitted entirely when absent — Ollama and LM Studio need no key, and an
    // empty Authorization header upsets some proxies.
    ...(apiKey ? { apiKey } : {}),
    includeUsage: true,
  });
  return client.chatModel(provider.model);
}

/**
 * Turn a transport failure into something a user can act on. A refused socket on
 * localhost means "Ollama isn't running", not "the AI broke".
 */
function toAnalysisError(err: unknown, provider: ResolvedProvider): AnalysisError {
  const label = ANALYSIS_PROVIDER_LABELS[provider.id];
  const message = err instanceof Error ? err.message : String(err);

  if (APICallError.isInstance(err)) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return new AnalysisError(
        "provider_not_configured",
        `${label} rejected the credentials${
          provider.apiKeyEnv ? ` — check ${provider.apiKeyEnv}` : ""
        }.`,
      );
    }
    if (err.statusCode === 404) {
      return new AnalysisError(
        "provider_not_configured",
        `${label} does not have a model named "${provider.model}". Check the model id.`,
      );
    }
    if (err.statusCode === 429) {
      return new AnalysisError(
        "rate_limited",
        `${label} is rate limiting this request. Wait a moment and try again.`,
      );
    }
  }

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket/i.test(message)) {
    return new AnalysisError(
      "provider_unavailable",
      provider.id === "ollama"
        ? `Could not reach Ollama at ${provider.baseUrl}. Start it with \`ollama serve\` and make sure \`${provider.model}\` is pulled.`
        : `Could not reach ${label} at ${provider.baseUrl}.`,
    );
  }

  return new AnalysisError("agent_error", message);
}

/** Run one analysis against an OpenAI-compatible endpoint. */
async function run(args: DriverRunArgs): Promise<DriverResult> {
  const { provider, systemPrompt, userPrompt, signal, onEvent } = args;
  const warnings: string[] = [
    "No web research on this provider — fixes are diagnosed from the audit data alone and carry no citations.",
  ];

  const model = createModel(provider);

  onEvent({
    type: "status",
    phase: "preflight",
    message: `Connecting ${ANALYSIS_PROVIDER_LABELS[provider.id]}…`,
    model: provider.model,
    auth: provider.apiKeyEnv && process.env[provider.apiKeyEnv] ? "api-key" : "unknown",
    // No research server on this path — an empty list is the honest answer.
    mcp: [],
  });
  onEvent({ type: "status", phase: "diagnosing", message: "Reading the audit data…" });

  let rawText = "";
  let emittedDiagnosisLen = 0;
  let sawWriting = false;

  /**
   * Stream the *diagnosis* portion only — everything before {@link FIXES_OPEN} —
   * holding back a short tail so a sentinel forming across deltas never leaks
   * into the prose. Same discipline as the Claude driver, so the UI behaves
   * identically whichever provider is running.
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
    if (!sawWriting) {
      sawWriting = true;
      onEvent({ type: "status", phase: "writing", message: "Writing diagnosis…" });
    }
    onEvent({ type: "text-delta", delta });
  };

  try {
    const stream = streamText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      abortSignal: signal,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: MAX_RETRIES,
    });

    for await (const delta of stream.textStream) pushText(delta);
    // Surfaces a failure the stream swallowed (the SDK resolves these lazily).
    await stream.finishReason;
  } catch (err) {
    if (signal?.aborted) throw err;
    throw toAnalysisError(err, provider);
  }

  onEvent({ type: "status", phase: "finalizing", message: "Finishing up…" });

  const { diagnosis, fixesJson } = splitDiagnosisAndFixes(rawText);
  // Citations are dropped, not trusted: this model had no way to open a page.
  let parsed = parseFixes(fixesJson, { allowCitations: false });

  // One repair pass — cheap, narrow, and it rescues most small-model JSON slips.
  if (parsed.error !== null && parsed.error !== "missing_block") {
    onEvent({
      type: "status",
      phase: "finalizing",
      message: "Repairing the fixes JSON…",
    });
    const repaired = await repairFixes(model, fixesJson ?? "", signal);
    if (repaired) parsed = parseFixes(repaired, { allowCitations: false });
  }

  if (parsed.error === "missing_block") {
    // The model wrote prose and no fixes block at all. That is not a failure to
    // parse — and for a category already scoring well it is the correct answer,
    // since there is nothing to suggest. Say what happened rather than implying
    // the model produced something broken.
    warnings.push("The model returned no structured fixes, so this is a diagnosis only.");
  } else if (parsed.error !== null) {
    warnings.push(
      "The model's fixes JSON could not be parsed, so this analysis is diagnosis-only.",
    );
  }

  return {
    diagnosis: diagnosis || rawText.trim(),
    fixes: parsed.fixes,
    model: provider.model,
    warnings,
  };
}

/**
 * Ask the model to reformat its own malformed block. Returns the raw repaired
 * text, or `null` if the repair call itself failed — a failed repair degrades to
 * prose-only, it never fails the analysis.
 */
async function repairFixes(
  model: ReturnType<typeof createModel>,
  broken: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { text } = await generateText({
      model,
      system: FIXES_REPAIR_SYSTEM_PROMPT,
      prompt: buildRepairPrompt(broken, false),
      abortSignal: signal,
      temperature: 0,
      maxOutputTokens: REPAIR_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
    });
    return text.trim() || null;
  } catch {
    return null;
  }
}

/** The OpenAI-compatible driver (Ollama, LM Studio, vLLM, OpenAI, OpenRouter…). */
export const openAiCompatibleDriver: AnalysisDriver = {
  driver: "openai-compatible",
  run,
};
