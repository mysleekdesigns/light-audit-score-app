/**
 * `audit_url` — run one Lighthouse audit and hand back its scores (ROADMAP Phase G).
 *
 * The only tool here that *does* anything: it launches headless Chrome against a
 * URL the caller named, waits for the batch to settle, and archives the run in
 * the same SQLite history the app writes. Everything else in this directory
 * reads what is already on disk.
 *
 * ## Reuse, don't fork
 *
 * The entire body of work is `resolveAuditOptions` → `runBatchToCompletion` →
 * read the persisted row. No second engine, no second settlement rule, and — the
 * one that matters most — **no second definition of what got measured**: the
 * payload is projected from `outcome.rows[0]`, the row in SQLite, exactly as
 * `scripts/audit-cli.ts` judges the rows and not the in-memory job result. If
 * persistence broke, this tool reports a failure rather than a green score for a
 * run the archive never received, which is the same property decision 1 of the
 * CI contract buys the pipeline (`src/lib/ci/types.ts`).
 *
 * ## Silence
 *
 * Nothing here writes to stdout, and nothing it imports may either: the process
 * this runs in speaks JSON-RPC frames over stdout, and one stray `console.log`
 * anywhere in the import graph drops the client's connection (invariant 1 in
 * `scripts/mcp-server.ts`). That is why `runBatchToCompletion` is called with no
 * `onEvent` — the progress sink the CLI passes is precisely the thing an MCP
 * server must not have.
 *
 * ## What is deliberately NOT returned
 *
 * The LHR, the audit list, the opportunities, the filmstrip. The plan's line is
 * "an agent pays for every token of a Lighthouse report", and a single LHR is
 * routinely megabytes. Scores, Core Web Vitals and a run id are the whole useful
 * surface; the rest is a screen in the app, where a person can look at it for
 * free, and `runId` is the join back to it.
 */

import { runBatchToCompletion } from "@/lib/ci/runBatch";
import type { HistoryRow } from "@/lib/db/persistence";
import { resolveAuditOptions } from "@/lib/lighthouse/options";
import {
  LIGHTHOUSE_CATEGORIES,
  MAX_RUNS,
  METRIC_IDS,
  MIN_RUNS,
  type FormFactor,
  type LighthouseCategory,
  type MetricId,
} from "@/lib/lighthouse/types";
import {
  optionalEnum,
  optionalEnumArray,
  optionalInteger,
  rejectUnknownArgs,
  requireString,
} from "@/lib/mcp/args";
import {
  McpToolError,
  jsonResult,
  type McpTool,
  type McpToolResult,
} from "@/lib/mcp/types";
import { safeText } from "@/lib/text/displaySafe";
import { getAuditQueue } from "@/lib/queue/AuditQueue";
import {
  UrlNormalizeError,
  normalizeAuditUrl,
} from "@/lib/urls/normalizeAuditUrl";

/** The arguments this tool accepts; `rejectUnknownArgs` enforces the list. */
const AUDIT_URL_ARGS = ["url", "device", "categories", "runs"] as const;

/** The concrete form factors an audit can run. `"both"` is not offered — see the schema. */
const DEVICES: readonly FormFactor[] = ["mobile", "desktop"];

/**
 * Runs to take the median of, when the caller does not say — **1, not the app's 3.**
 *
 * The app defaults to 3 because Lighthouse's performance score is genuinely
 * noisy run-to-run and a person watching a progress bar can absorb the wait. An
 * agent can do neither: it blocks synchronously inside one tool call with no
 * event stream to watch, so median-of-3 triples a wait it cannot see progress
 * during and cannot cancel. One run answers "did that change help?" in a third
 * of the time, and a caller that actually needs a number to trust can pass
 * `runs: 3` — which the tool description tells it, in those words.
 */
export const DEFAULT_AGENT_RUNS = 1;

/** Longest URL echoed into a payload. Matches the CI reporters' own URL budget. */
const MAX_URL_CHARS = 300;

/** Longest failure message echoed into a payload. @see MAX_URL_CHARS */
const MAX_ERROR_CHARS = 400;

/** The compact result of one audit. Deliberately not an LHR — see the module docblock. */
export interface AuditUrlPayload {
  /** The archived run. Feed it to `check_budget` and `compare_runs`. */
  runId: string;
  /** The URL as requested, exactly as History stores it. */
  url: string;
  /** Where the page actually resolved after redirects; `null` for a failed run. */
  finalUrl: string | null;
  device: FormFactor;
  status: "done" | "error";
  /** How many runs the median was taken over; `null` for a failed run. */
  runs: number | null;
  /** Median category scores, 0–100. A category that was not scored is ABSENT. */
  scores: Partial<Record<LighthouseCategory, number>>;
  /** Median Core Web Vitals as raw numbers; `null` when the run measured none. */
  metrics: Partial<Record<MetricId, number>> | null;
  batchId: string;
  /** ISO time the median run fetched the page; `null` for a failed run. */
  fetchTime: string | null;
  /** Present only on a failed run. UNTRUSTED page-derived text, sanitised. */
  errorMessage?: string;
}

/**
 * Scores in canonical category order, absent where there is no number.
 *
 * A `HistoryRow` always carries all five keys, most of them `null` on a failed
 * or partial run, and `null` means "not scored" three different ways (the
 * category wasn't selected, it ran and produced nothing, or the whole run
 * failed). Emitting those nulls would spend tokens on five keys to say nothing
 * — so a missing key IS the "not scored" answer, and the caller already knows
 * which categories it asked for. Canonical order rather than insertion order so
 * two runs of the same page serialise identically and a diff of two payloads is
 * about the numbers.
 */
function projectScores(
  scores: HistoryRow["scores"],
): Partial<Record<LighthouseCategory, number>> {
  const out: Partial<Record<LighthouseCategory, number>> = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const value = scores[category];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[category] = value;
    }
  }
  return out;
}

/**
 * Core Web Vitals reduced to one number each.
 *
 * A `MetricValue` is `{ numericValue, displayValue, score }`; keeping all three
 * for six metrics is roughly three times the tokens to say the same thing, and
 * the two dropped fields are both derivable — `displayValue` is a formatting of
 * `numericValue`, and the 0–1 metric score is Lighthouse's own curve, which the
 * category score already summarises. The units are stated in the tool
 * description instead of repeated in every payload: milliseconds for the
 * timings, unitless for `cumulative-layout-shift`.
 *
 * `null` (rather than `{}`) when nothing was measured, so "the run failed" and
 * "every metric came back empty" do not read as an object worth inspecting.
 */
function projectMetrics(
  metrics: HistoryRow["metrics"],
): Partial<Record<MetricId, number>> | null {
  if (metrics === null) return null;
  const out: Partial<Record<MetricId, number>> = {};
  for (const id of METRIC_IDS) {
    const value = metrics[id]?.numericValue;
    if (typeof value === "number" && Number.isFinite(value)) out[id] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * One persisted run as the tool's payload. Pure, so the projection is testable
 * without launching Chrome — which is the whole reason it is a named export.
 */
export function projectAuditRow(row: HistoryRow): AuditUrlPayload {
  const payload: AuditUrlPayload = {
    runId: row.id,
    url: safeText(row.url, MAX_URL_CHARS),
    finalUrl:
      row.finalUrl === null ? null : safeText(row.finalUrl, MAX_URL_CHARS),
    device: row.formFactor,
    status: row.status,
    runs: row.runs,
    scores: projectScores(row.scores),
    metrics: projectMetrics(row.metrics),
    batchId: row.batchId,
    fetchTime: row.fetchTime,
  };
  // Only on failure, and only ever from the row: a `done` run has no failure to
  // describe, and an empty string there would read as an unexplained error.
  if (row.status === "error") {
    payload.errorMessage = safeText(
      row.errorMessage ?? "unknown error",
      MAX_ERROR_CHARS,
    );
  }
  return payload;
}

const DESCRIPTION = `Run a Lighthouse audit against one URL on this machine and return its scores.

This is the slow tool: it launches headless Chrome, takes roughly 15-60 seconds per run, \
and is the only tool here that touches the network. The run is archived in the same local \
history the app writes, and the "runId" it returns is the input to check_budget (does this \
run clear a bar?) and compare_runs (what changed since an earlier run?).

"runs" defaults to 1, NOT the app's default of 3. You block on this call with no progress to \
watch, so median-of-3 triples a wait you cannot see. Pass runs: 3 to match what the app does \
by default, and do so before trusting a performance number for anything but a rough \
comparison — Lighthouse's performance score is genuinely noisy run to run.

Returns median category scores (0-100) and Core Web Vitals, never the Lighthouse report \
itself; open the run in the app for waterfalls, opportunities and the full audit list. Metric \
values are raw numbers: milliseconds for the timings, unitless for cumulative-layout-shift. \
A category or metric missing from the result was not scored.

An audit that FAILS still returns a payload — with an "errorMessage" and its "runId", because \
the failed run is archived like any other — flagged as an error result.`;

export const auditUrlTool: McpTool = {
  name: "audit_url",
  title: "Run a Lighthouse audit",
  description: DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The page to audit. http/https only; a bare host gets https://. Must not carry a username or password.",
      },
      device: {
        type: "string",
        enum: [...DEVICES],
        default: "mobile",
        description:
          "Emulated device. Mobile is the stricter of the two and is what Lighthouse and PageSpeed Insights report by default.",
      },
      categories: {
        type: "array",
        items: { type: "string", enum: [...LIGHTHOUSE_CATEGORIES] },
        default: [...LIGHTHOUSE_CATEGORIES],
        description:
          "Categories to score. Fewer categories is a faster audit; performance is the expensive one.",
      },
      runs: {
        type: "integer",
        minimum: MIN_RUNS,
        maximum: MAX_RUNS,
        default: DEFAULT_AGENT_RUNS,
        description:
          "Runs to take the median of. Defaults to 1 to keep the call short; 3 is what the app uses and what smooths out run-to-run variance.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  annotations: {
    // The one tool that writes: it archives a run and it fetches a URL the
    // caller chose. `destructiveHint: false` because it only ever appends —
    // nothing it does removes or overwrites an existing run.
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },

  async handler(args: Record<string, unknown>): Promise<McpToolResult> {
    rejectUnknownArgs(args, AUDIT_URL_ARGS);

    const raw = requireString(args, "url");
    let url: string;
    try {
      url = normalizeAuditUrl(raw);
    } catch (error) {
      // These messages were written for exactly this audience: they name what
      // is wrong with the target and, for a credentialed URL, what to do
      // instead. Passing them through unchanged is the point of the shared
      // normaliser.
      if (error instanceof UrlNormalizeError) {
        throw new McpToolError(error.message);
      }
      throw error;
    }

    const device = optionalEnum(args, "device", DEVICES) ?? "mobile";
    const categories = optionalEnumArray(
      args,
      "categories",
      LIGHTHOUSE_CATEGORIES,
    );
    const runs =
      optionalInteger(args, "runs", { min: MIN_RUNS, max: MAX_RUNS }) ??
      DEFAULT_AGENT_RUNS;

    // `categories` is passed through even when undefined: the app's own schema
    // owns the "all five" default, and re-stating it here is how the tool and
    // the app would eventually disagree about what a full audit is.
    const options = resolveAuditOptions({
      formFactor: device,
      categories,
      runs,
    });

    // No `onEvent`. Silence is mandatory — see the module docblock. Concurrency
    // 1 because there is exactly one URL; anything else would only mislead a
    // reader of the batch row.
    const queue = getAuditQueue();
    const outcome = await runBatchToCompletion(queue, {
      urls: [url],
      device,
      options,
      concurrency: 1,
    });

    const row = outcome.rows[0];
    if (!row) {
      // Decision 1 of the CI contract, applied to a single audit: with no row
      // there is nothing that was measured, and inventing a payload from the
      // in-memory job result would report a score the archive does not have.
      throw new McpToolError(
        outcome.batch.status === "cancelled"
          ? "The audit was cancelled before any run reached the archive, so there is nothing to report. Try again."
          : "The audit finished but archived nothing, so there is no run to report. The local database or its reports directory is probably unwritable — check the server's stderr log, then try again.",
      );
    }

    // Release the ~1 MB LHR the queue retains for this run (Phase G security
    // review, M2). The retention exists so a report route can serve a run that
    // has not been persisted yet; here the row IS persisted, and this process
    // reads reports from disk (`loadRunLhr` tries the file first and the queue
    // only as a fallback). Left in place it is a slow leak with a shape nothing
    // else in the app has: an MCP server lives for a whole coding session, so an
    // afternoon of audit-driven development would retain every LHR of the day.
    //
    // Conditional on the report actually being on disk, deliberately. If the
    // file failed to write, the in-memory copy is the only remaining way to diff
    // this run, and trading a rare "no stored report" for a bounded heap would
    // be the wrong way round — the leak is the common case, the missing file is
    // not.
    if (row.hasJsonReport) queue.forgetJobResults(row.id);

    const result = jsonResult({ ...projectAuditRow(row) });
    // A failed audit is a real answer, not a transport fault: the agent gets the
    // full payload (including the `runId` of the archived failure) and the flag
    // that says not to read the scores as a measurement.
    if (row.status === "error") result.isError = true;
    return result;
  },
};
