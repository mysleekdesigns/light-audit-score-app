/**
 * Browser-side access to `/api/settings/report-branding`.
 *
 * The two halves follow the house split the other settings clients keep: the
 * read degrades to `null` ("unknown"), because not knowing whether a report
 * header is configured is never worth a red banner; the write DOES throw,
 * because a Save that silently didn't stick is worse than one that says so.
 *
 * The write resolves with the branding the SERVER now holds rather than with
 * what was sent. That is the whole reason the endpoint answers with a body: the
 * store's allow-list can refuse a logo the browser happily read (an SVG, an
 * oversized file), and the panel has to repaint from the truth so the user sees
 * it before they mail the report.
 */

import type { ReportBranding } from "@/lib/export/report-model";

const ENDPOINT = "/api/settings/report-branding";

/** Fetch the stored report branding. `null` on any failure. */
export async function getReportBranding(
  options: { signal?: AbortSignal } = {},
): Promise<ReportBranding | null> {
  try {
    const response = await fetch(ENDPOINT, {
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as ReportBranding;
  } catch {
    return null;
  }
}

/**
 * Save the report branding. Resolves with what the server actually stored;
 * rejects with a user-readable message when it could not be saved.
 */
export async function saveReportBranding(
  next: ReportBranding,
): Promise<ReportBranding> {
  const response = await fetch(ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  if (!response.ok) {
    let message = "Could not save the report header.";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new Error(message);
  }
  return (await response.json()) as ReportBranding;
}
