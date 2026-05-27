"use client";

/**
 * Browser download + bulk-open helpers (PRD §6 Phase 7 — export).
 *
 * The thin DOM layer the export UI calls after the pure serializers in
 * `./exporters.ts` produce a string: trigger a file download via an object URL,
 * and open many stored reports in new tabs. Kept apart from the serializers so
 * the latter stay node-testable; these touch `document` / `window` and run only
 * in the browser.
 */

/**
 * Trigger a client-side file download of `content`. Creates a Blob object URL,
 * clicks a transient `<a download>`, then revokes the URL on the next tick.
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Download a `.json` file (UTF-8 JSON). */
export function downloadJson(filename: string, json: string): void {
  downloadTextFile(filename, json, "application/json;charset=utf-8");
}

/** Download a `.csv` file (UTF-8 CSV). */
export function downloadCsv(filename: string, csv: string): void {
  downloadTextFile(filename, csv, "text/csv;charset=utf-8");
}

/**
 * Open each URL in a new background tab. Returns the number of tabs that opened;
 * a count below `urls.length` means the browser's popup blocker stopped some
 * (only the first window.open in a user gesture is reliably allowed) — callers
 * can surface that to the user.
 */
export function openUrlsInNewTabs(urls: string[]): number {
  let opened = 0;
  for (const url of urls) {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (win) opened += 1;
  }
  return opened;
}

/** A filesystem-safe timestamp slug (e.g. `2026-05-26T10-00-05`) for filenames. */
export function timestampSlug(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace(/:/g, "-");
}
