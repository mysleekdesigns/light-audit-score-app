"use client";

/**
 * Browser-side trigger for the client-ready HTML report (ROADMAP Phase H).
 *
 * `POST /api/export/batch/:batchId` builds a single self-contained HTML document
 * for one batch — the server reads SQLite and up to sixty stored LHRs to do it —
 * and this is what asks for it and hands the result to the user as a file.
 *
 * **Why a fetch rather than an `<a download>`.** The other two exports serialize
 * data the page already holds, so they are pure client work and cannot fail. This
 * one is a server round-trip over stored reports that takes real time and can
 * genuinely go wrong (a batch deleted in another tab, a corrupt report file). A
 * plain anchor would answer either of those by silently downloading an error
 * envelope named `.html`, which the user would open and be baffled by. Fetching
 * lets the caller show a spinner and turn a failure into a sentence.
 *
 * It also has to be a POST, and the reason is in the route's docblock: the pass
 * thresholds the report is judged against live in `localStorage`, so the client
 * is the only party that knows them.
 */

import { downloadTextFile } from "@/lib/export/download";
import type { CategoryThresholds } from "@/lib/settings/defaults";

/**
 * The filename the server chose, read back out of `Content-Disposition`.
 *
 * The header is ours — `attachment; filename="lighthouse-report-<id>-<stamp>.html"`,
 * built in the route from a nanoid slice and a timestamp — so this parse is a
 * convenience, not a security boundary, and it deliberately accepts only the
 * exact shape the route emits. Anything else falls back to the caller's name
 * rather than trusting a header to name a file on the user's disk.
 */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="(lighthouse-report-[A-Za-z0-9_-]+-[0-9T:-]+\.html)"/.exec(
    header,
  );
  return match?.[1] ?? null;
}

/**
 * Build and download the HTML report for one batch.
 *
 * Resolves with the filename that was saved. Rejects with a user-readable
 * message — the route's own, when it sent a structured error — so the caller can
 * put it straight into a toast.
 */
export async function downloadBatchReport(args: {
  batchId: string;
  thresholds: CategoryThresholds;
  /** Used only if the server somehow sent no usable `Content-Disposition`. */
  fallbackFilename: string;
  signal?: AbortSignal;
}): Promise<string> {
  const response = await fetch(
    `/api/export/batch/${encodeURIComponent(args.batchId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholds: args.thresholds }),
      cache: "no-store",
      signal: args.signal,
    },
  );

  if (!response.ok) {
    let message = "The report could not be built.";
    try {
      // The route answers failures through `@/lib/api/errors`, whose envelope is
      // `{ error: { message, code } }` — not the flat `{ error: string }` the
      // settings endpoints use. Read the nested shape, and fall back rather than
      // showing the user a JSON fragment.
      const body = (await response.json()) as { error?: { message?: unknown } };
      const detail = body.error?.message;
      if (typeof detail === "string" && detail) message = detail;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new Error(message);
  }

  const html = await response.text();
  const filename =
    filenameFromDisposition(response.headers.get("Content-Disposition")) ??
    args.fallbackFilename;

  downloadTextFile(filename, html, "text/html;charset=utf-8");
  return filename;
}
