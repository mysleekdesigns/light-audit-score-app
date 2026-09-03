/**
 * `GET|PUT|DELETE /api/settings/ai-provider` — what AI the analysis engine will
 * use, what else is available on this machine, and the one choice the panel
 * can save.
 *
 * `GET` mirrors `psi-status` / `research-status`: it resolves exactly what
 * `runAnalysis` resolves, so what the settings panel shows is what will actually
 * run. It also probes Ollama so the panel can list the models the user has
 * already pulled — a picker beats asking someone to remember a tag — and
 * reports how `.env` has configured the other two switches (Claude's pinned
 * model; the custom endpoint, redacted, plus key presence). Callers that only
 * need the resolved provider (the analysis empty state) pass `?probe=0` to
 * skip the Ollama round-trip.
 *
 * `PUT { provider, model? }` saves the panel's choice to `app_settings`, where
 * it overrides `LH_ANALYSIS_PROVIDER` / `LH_ANALYSIS_MODEL` until `DELETE`
 * clears it. Both answer with the same status `GET` returns, probe included, so
 * the panel repaints from one round-trip. What is saved is a provider id and a
 * model tag — the body accepts nothing else, and in particular no endpoint URL
 * and no key: those stay in `.env`, which is why a custom endpoint `.env` has
 * not configured cannot be chosen here.
 *
 * It NEVER returns a credential: the resolved provider carries the NAME of the
 * env var a key lives in, and this endpoint reports only whether that var is
 * set. Base URLs are stripped of any embedded userinfo before they cross the wire.
 */

import { z } from "zod";

import { hasResearchMcpConfig } from "@/lib/analysis/providers/researchMcp";
import { redactUrl } from "@/lib/redactUrl";
import { probeOllama } from "@/lib/analysis/providers/ollama";
import {
  clearProviderPreference,
  resolveConfiguredProvider,
  setProviderPreference,
} from "@/lib/analysis/providers/preference";
import {
  MAX_MODEL_ID_LENGTH,
  MODEL_ID_PATTERN,
  normalizeProviderId,
  resolveAnalysisProvider,
  resolveOllamaBaseUrl,
} from "@/lib/analysis/providers/select";
import type { AiProviderStatus } from "@/lib/analysis/providerStatus";
import { ANALYSIS_PROVIDER_IDS, ANALYSIS_PROVIDER_LABELS } from "@/lib/analysis/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().trim().max(MAX_MODEL_ID_LENGTH).optional(),
});

/** Whether the env var a resolved provider names for its key is set. Presence only. */
function keyPresent(apiKeyEnv: string | null): boolean {
  return Boolean(apiKeyEnv && process.env[apiKeyEnv]?.trim());
}

/** What would run right now, plus — when asked — what Ollama has installed. */
async function currentStatus(probe: boolean): Promise<AiProviderStatus> {
  const provider = resolveConfiguredProvider();
  const ollamaBaseUrl = resolveOllamaBaseUrl(process.env);
  // How `.env` has set up the other switches, independent of what is selected.
  const claude = resolveAnalysisProvider(process.env, { provider: "claude" });
  const custom = resolveAnalysisProvider(process.env, { provider: "openai-compatible" });

  // Probe only when asked and when Ollama is plausibly in play: it's the
  // selected provider, or nothing was selected and we can suggest it.
  const relevant = provider.id === "ollama" || provider.id === "claude";
  const ollama =
    probe && relevant
      ? await probeOllama(ollamaBaseUrl)
      : { running: false, baseUrl: ollamaBaseUrl, models: [] };

  return {
    provider: provider.id,
    source: provider.source,
    label: ANALYSIS_PROVIDER_LABELS[provider.id],
    driver: provider.driver,
    model: provider.model,
    baseUrl: redactUrl(provider.baseUrl),
    canWebResearch: provider.canWebResearch,
    // The same predicate `runAnalysis` resolves the tier with, so the panel
    // cannot promise research the next analysis won't do.
    researchConfigured: hasResearchMcpConfig(),
    // Presence only — the key itself never leaves the server.
    apiKeyEnv: provider.apiKeyEnv,
    hasApiKey: keyPresent(provider.apiKeyEnv),
    missing: provider.missing,
    ollama: {
      running: ollama.running,
      baseUrl: redactUrl(ollama.baseUrl),
      models: ollama.models,
    },
    claude: { model: claude.model },
    custom: {
      configured: custom.baseUrl !== null,
      baseUrl: redactUrl(custom.baseUrl),
      hasApiKey: keyPresent(custom.apiKeyEnv),
      model: custom.model,
    },
  };
}

/** A 400 with a message the panel can show as-is. */
function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

/** The 500 a write answers with when the preference store would not take it. */
function storeFailed(what: string, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[settings] could not ${what} the AI provider choice: ${message}`);
  return Response.json(
    { error: "Could not save the setting. Check that the data directory is writable." },
    { status: 500 },
  );
}

export async function GET(request: Request): Promise<Response> {
  const wantsProbe = new URL(request.url).searchParams.get("probe") !== "0";
  return Response.json(await currentStatus(wantsProbe), { status: 200 });
}

export async function PUT(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be JSON.");
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      'Expected a body of the form { "provider": "claude" | "ollama" | "openai-compatible", "model"?: "<id>" }.',
    );
  }
  const provider = normalizeProviderId(parsed.data.provider);
  if (!provider) {
    return badRequest(`"provider" must be one of: ${ANALYSIS_PROVIDER_IDS.join(", ")}.`);
  }
  const model = parsed.data.model ?? "";
  if (model && !MODEL_ID_PATTERN.test(model)) {
    return badRequest('"model" must be a model id — no spaces or control characters.');
  }
  // Only Claude has a default model of its own; every other provider needs one.
  if (!model && provider !== "claude") {
    return badRequest(`"model" is required for the ${ANALYSIS_PROVIDER_LABELS[provider]} provider.`);
  }
  // The endpoint and key live in .env only. Choosing an endpoint .env has not
  // configured would just take the working selection offline until cleared.
  if (provider === "openai-compatible") {
    const check = resolveAnalysisProvider(process.env, { provider, model });
    if (check.missing) {
      return badRequest(`${check.missing.replace(/\.$/, "")} in .env, then restart the server.`);
    }
  }

  try {
    setProviderPreference({ provider, model });
  } catch (err) {
    return storeFailed("save", err);
  }
  return Response.json(await currentStatus(true), { status: 200 });
}

export async function DELETE(): Promise<Response> {
  try {
    clearProviderPreference();
  } catch (err) {
    return storeFailed("clear", err);
  }
  return Response.json(await currentStatus(true), { status: 200 });
}
