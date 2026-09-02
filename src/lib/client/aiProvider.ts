/**
 * Browser-side read of `GET /api/settings/ai-provider`.
 *
 * Two surfaces need it: the settings panel (with Ollama detection, so the user
 * can see which local models are installed) and the analysis empty state (which
 * only needs the resolved provider, so it skips the probe). Both treat a failure
 * as "unknown" rather than an error — not knowing which AI is configured is
 * never worth a red banner.
 */

import type { AiProviderStatus } from "@/lib/analysis/providerStatus";

/**
 * Fetch the resolved AI provider. `probe: false` skips Ollama detection, which
 * is a network round-trip to localhost the caller may not need.
 *
 * Returns `null` on any failure — callers degrade to generic copy.
 */
export async function getAiProviderStatus(
  options: { probe?: boolean; signal?: AbortSignal } = {},
): Promise<AiProviderStatus | null> {
  const query = options.probe === false ? "?probe=0" : "";
  try {
    const response = await fetch(`/api/settings/ai-provider${query}`, {
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as AiProviderStatus;
  } catch {
    return null;
  }
}
