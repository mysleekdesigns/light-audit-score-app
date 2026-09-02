/**
 * Browser-side access to the web-research settings endpoints.
 *
 * `getResearchStatus` reads `GET /api/settings/research-status`; a failure is
 * "unknown" (`null`) rather than an error — not knowing whether research is
 * configured is never worth a red banner. `setCrawlforgeEnabled` writes the one
 * preference the panel owns and DOES throw on failure, because a switch that
 * silently didn't stick is worse than one that says so.
 */

import type { ResearchStatus } from "@/lib/analysis/researchStatus";

/** Fetch the current research status. `null` on any failure. */
export async function getResearchStatus(
  options: { signal?: AbortSignal } = {},
): Promise<ResearchStatus | null> {
  try {
    const response = await fetch("/api/settings/research-status", {
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as ResearchStatus;
  } catch {
    return null;
  }
}

/**
 * Flip the CrawlForge switch. Resolves with the status the server now reports;
 * rejects with a user-readable message when the preference could not be saved.
 */
export async function setCrawlforgeEnabled(enabled: boolean): Promise<ResearchStatus> {
  const response = await fetch("/api/settings/crawlforge", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    let message = "Could not save the setting.";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new Error(message);
  }
  return (await response.json()) as ResearchStatus;
}
