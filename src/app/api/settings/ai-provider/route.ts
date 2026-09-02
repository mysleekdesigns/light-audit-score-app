/**
 * `GET /api/settings/ai-provider` — what AI the analysis engine will use, and
 * what else is available on this machine.
 *
 * Mirrors `psi-status` / `research-status`: it resolves exactly what
 * `runAnalysis` resolves, so what the settings panel shows is what will actually
 * run. It also probes Ollama so the panel can list the models the user has
 * already pulled — a picker beats asking someone to remember a tag. Callers that
 * only need the resolved provider (the analysis empty state) pass `?probe=0` to
 * skip that network round-trip.
 *
 * It NEVER returns a credential: the resolved provider carries the NAME of the
 * env var a key lives in, and this endpoint reports only whether that var is
 * set. Base URLs are stripped of any embedded userinfo before they cross the wire.
 */

import { loadResearchMcpConfig } from "@/lib/analysis/providers/researchMcp";
import { probeOllama } from "@/lib/analysis/providers/ollama";
import {
  resolveAnalysisProvider,
  resolveOllamaBaseUrl,
} from "@/lib/analysis/providers/select";
import type { AiProviderStatus } from "@/lib/analysis/providerStatus";
import { ANALYSIS_PROVIDER_LABELS } from "@/lib/analysis/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drop anything secret-shaped from a URL before returning it: `user:pass@` and
 * any query string (some vendors put the key there). Unparseable input is
 * dropped entirely rather than echoed.
 */
function redactUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<Response> {
  const provider = resolveAnalysisProvider(process.env);
  const ollamaBaseUrl = resolveOllamaBaseUrl(process.env);

  // Probe only when asked and when Ollama is plausibly in play: it's the
  // selected provider, or nothing was selected and we can suggest it.
  const wantsProbe = new URL(request.url).searchParams.get("probe") !== "0";
  const relevant = provider.id === "ollama" || provider.id === "claude";
  const ollama =
    wantsProbe && relevant
      ? await probeOllama(ollamaBaseUrl)
      : { running: false, baseUrl: ollamaBaseUrl, models: [] };

  const body: AiProviderStatus = {
    provider: provider.id,
    label: ANALYSIS_PROVIDER_LABELS[provider.id],
    driver: provider.driver,
    model: provider.model,
    baseUrl: redactUrl(provider.baseUrl),
    canWebResearch: provider.canWebResearch,
    researchConfigured: loadResearchMcpConfig() !== null,
    // Presence only — the key itself never leaves the server.
    apiKeyEnv: provider.apiKeyEnv,
    hasApiKey: Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]?.trim()),
    missing: provider.missing,
    ollama: {
      running: ollama.running,
      baseUrl: redactUrl(ollama.baseUrl),
      models: ollama.models,
    },
  };

  return Response.json(body, { status: 200 });
}
