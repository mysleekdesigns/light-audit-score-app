/**
 * Server-side loading of a stored Lighthouse report (ROADMAP Phase E).
 *
 * SERVER ONLY — unlike its neighbours in this directory (`extract.ts`,
 * `report-diff.ts`, the `*-view` modules), which are pure, this module reads the
 * filesystem, the SQLite archive and the in-memory queue. It is the ONE place
 * that turns a run id into an LHR, extracted from `GET /api/reports/:runId/trace`
 * when the Phase E diff route needed the same thing for two runs at once.
 *
 * Extracting it was not tidiness: the trace route's read carries a specific,
 * reviewed security posture — a DB-resolved path so caller input never reaches
 * `path.join`, a peak-memory ceiling, an absent file that falls through instead
 * of 500ing, and a present-but-corrupt file that does NOT. A second route
 * re-deriving that from memory is how two routes end up with two postures.
 *
 * Degradation ladder, unchanged from Phase D:
 *  1. the persisted LHR on disk (`getRunReport(runId).jsonPath`);
 *  2. the in-memory queue result (`result.median.lhr`) — what makes a run that
 *     just finished, or one from before persistence, readable;
 *  3. `not_found` when neither has an LHR.
 */

import { promises as fs } from "node:fs";

import { getRunReport } from "@/lib/db/persistence";
import type { LighthouseResult } from "@/lib/lighthouse/types";
import { getAuditQueue } from "@/lib/queue/AuditQueue";

/**
 * Refuse to read a report far larger than one can legitimately be.
 *
 * The ceiling is set against PEAK MEMORY, not file size, because a route that
 * projects a report holds far more than the file: the UTF-8 string, the parsed
 * object graph (an LHR is a great many small objects and strings, so several
 * times the text), the projection, and the serialized response — all live at
 * once. 8 MB is over 5× the largest report observed here (1.5 MB) and still
 * bounds the whole chain to something a local server can absorb.
 *
 * A caller that loads TWO reports for one request should halve it (see
 * `LoadReportOptions.maxBytes`), so the pair costs no more peak memory than a
 * single-report route.
 */
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/** Why a load did not produce an LHR. */
export type LoadReportFailure =
  /** No DB row with a stored report, and nothing in the queue. Ordinary. */
  | "not_found"
  /** The file is present but exceeds the ceiling. A real fault. */
  | "too_large"
  /** The file is present but is not parseable JSON. A real fault. */
  | "unparseable";

/** A loaded report, or the reason there is none. */
export type LoadReportResult =
  | {
      status: "ok";
      lhr: LighthouseResult;
      /**
       * The id to echo when a route puts one in its response body
       * (`.claude/rules/security.md`: no request data is reflected).
       *
       * Stated exactly, because the earlier wording ("never the caller's
       * string") was not true on every branch and an overclaimed guarantee is
       * worse than none: when the report came from DISK this is the id SQLite
       * round-tripped, so the caller's string never appears. When it came from
       * the in-memory QUEUE — a run that finished but is not persisted — there
       * is no row to round-trip through, and this is the caller's own string.
       *
       * That branch is still safe to echo, but for a different reason: the value
       * reached here only by matching an existing job key exactly, and job ids
       * are nanoids, so it cannot be steered to arbitrary content. It is a
       * lookup result, not free text. Do not weaken that to "caller input is
       * fine to echo" — the constraint is the exact match, and it is what makes
       * the difference.
       */
      runId: string;
    }
  | { status: "error"; reason: LoadReportFailure };

export interface LoadReportOptions {
  /** Per-report size ceiling; defaults to {@link MAX_REPORT_BYTES}. */
  maxBytes?: number;
}

/**
 * Whether a run still resolves to a report source.
 *
 * Separate from {@link loadRunLhr} because it is the cheap check an in-process
 * MEMO must consult before serving a hit: deleting a run — or "Clear history" —
 * has to actually remove it, and a cache that answers from memory is exactly how
 * a deleted run keeps being served for the life of the process (ROADMAP Phase C's
 * M2 is the standing precedent). The DB stays authoritative for EXISTENCE; the
 * memo only saves the expensive part.
 *
 * The queue arm below is a second such cache, and it used to defeat exactly that
 * rule: the queue retains every finished run's LHR and nothing pruned it, so a
 * deleted run stayed readable here — Phase E's security review found it (M1).
 * `deleteRun` / `clearHistory` now call `forgetQueuedResults`, so a queue hit
 * means the run genuinely still exists rather than merely having existed once.
 * Keep it that way: any new deletion path owes this map the same call.
 */
export function runReportResolves(runId: string): boolean {
  return (
    getRunReport(runId)?.jsonPath != null ||
    getAuditQueue().getJobResult(runId) !== undefined
  );
}

/** Read a file, returning `null` (rather than throwing) when absent/unreadable. */
async function readPersistedFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Whether the file at `path` is small enough to read. A missing file returns
 * true so the read below is what reports it — a stat failure must not be
 * mistaken for an oversized report.
 */
async function withinSizeLimit(path: string, maxBytes: number): Promise<boolean> {
  try {
    return (await fs.stat(path)).size <= maxBytes;
  } catch {
    return true;
  }
}

/**
 * Load one run's LHR, disk first and the live queue second.
 *
 * A file that is PRESENT but unreadable is the one case that does not fall
 * through to the queue: an absent report is ordinary (a legacy or pruned run),
 * a corrupt or oversized one is a real fault worth surfacing, and masking it
 * with an in-memory result that only exists for the few minutes after a run
 * would make the failure intermittent.
 */
export async function loadRunLhr(
  runId: string,
  options: LoadReportOptions = {},
): Promise<LoadReportResult> {
  const maxBytes = options.maxBytes ?? MAX_REPORT_BYTES;
  const persisted = getRunReport(runId);

  if (persisted?.jsonPath) {
    if (!(await withinSizeLimit(persisted.jsonPath, maxBytes))) {
      return { status: "error", reason: "too_large" };
    }
    const json = await readPersistedFile(persisted.jsonPath);
    if (json !== null) {
      try {
        return {
          status: "ok",
          lhr: JSON.parse(json) as LighthouseResult,
          runId: persisted.id,
        };
      } catch {
        return { status: "error", reason: "unparseable" };
      }
    }
  }

  const inMemory = getAuditQueue().getJobResult(runId)?.median.lhr ?? null;
  if (inMemory) {
    return { status: "ok", lhr: inMemory, runId: persisted?.id ?? runId };
  }

  return { status: "error", reason: "not_found" };
}
