/**
 * Browser-side access to `/api/settings/ai-provider`.
 *
 * Two surfaces read it: the settings panel (with Ollama detection, so the user
 * can see which local models are installed) and the analysis empty state (which
 * only needs the resolved provider, so it skips the probe). Both treat a read
 * failure as "unknown" rather than an error — not knowing which AI is
 * configured is never worth a red banner.
 *
 * The settings panel also writes through it: saving an installed model as the
 * analysis provider, and clearing that choice again. Those DO throw on failure,
 * because a click that silently didn't stick is worse than one that says so.
 */

import type { AiProviderStatus } from "@/lib/analysis/providerStatus";
import type { AnalysisProviderId } from "@/lib/analysis/types";

const ENDPOINT = "/api/settings/ai-provider";

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
    const response = await fetch(`${ENDPOINT}${query}`, {
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as AiProviderStatus;
  } catch {
    return null;
  }
}

/** What the panel can save: a provider and, for anything but Claude, a model tag. */
export interface AiProviderChoice {
  provider: AnalysisProviderId;
  model?: string;
}

/** The server's error message when it sent one, else a generic line. */
async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Non-JSON error body — keep the generic message.
  }
  return "Could not save the setting.";
}

/** Send one write and hand back the status the server now reports. */
async function write(init: RequestInit): Promise<AiProviderStatus> {
  const response = await fetch(ENDPOINT, init);
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as AiProviderStatus;
}

/**
 * Save `choice` as the provider for every analysis from here on. Resolves with
 * the status the server now reports; rejects with a user-readable message.
 */
export function saveAiProviderChoice(choice: AiProviderChoice): Promise<AiProviderStatus> {
  return write({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(choice),
  });
}

/** Forget the saved choice, so `.env` (or the default) decides again. */
export function clearAiProviderChoice(): Promise<AiProviderStatus> {
  return write({ method: "DELETE" });
}
