/**
 * `get_history` — the local archive, as an agent sees it (ROADMAP Phase G).
 *
 * This is the tool that makes the other three worth having. `audit_url` returns
 * one run id; `compare_runs` and `check_budget` need one it did not just make.
 * Without a way to ask "what have we already measured for this page?", an agent
 * can only ever compare a run against another run it paid to produce in the same
 * turn — which is the one comparison that tells you nothing about a regression.
 *
 * ## What it deliberately does NOT return
 *
 * The rows in SQLite carry far more than this: Core Web Vitals, the resolved
 * `AuditOptions`, the host environment, CrUX field data, report filenames. None
 * of it crosses. The plan's rule is "an agent pays for every token of a
 * Lighthouse report", and a *listing* is the worst possible place to spend that
 * budget — it is the call an agent makes speculatively, often, and usually to
 * extract exactly one string (a run id). So the projection is identity, verdict
 * and scores, and everything else is a screen in the app or a second, deliberate
 * call to `compare_runs`.
 *
 * Two omissions are judgement calls rather than obvious ones, and are recorded
 * here so a reviewer does not have to guess:
 *
 *  - **`errorMessage` is dropped.** `status: "error"` already tells the agent
 *    the run is not comparable, and the message itself is engine- and
 *    page-derived text of unbounded length. A listing of fifty failures should
 *    not be able to become fifty paragraphs of Chrome's opinions.
 *  - **No `hasReport` flag.** `compare_runs` needs a stored report, and a legacy
 *    or pruned run has none, so a boolean here would save the agent a failed
 *    call. It is left out because the field list for this tool was specified
 *    exactly; the failure it would prevent is already a one-line, actionable
 *    tool error.
 *
 * ## Matching
 *
 * Lookup goes through {@link auditUrlKey} on BOTH `url` (what was requested) and
 * `finalUrl` (where the page ended up), because either is a reasonable thing for
 * a caller to have in hand — an agent that read a redirect target out of an
 * earlier diff should still find the run. The key form drops the fragment and
 * the bare trailing slash, so `https://x.test`, `https://x.test/` and
 * `https://x.test/#top` are one page, which is the whole reason that helper is
 * shared rather than re-derived per caller.
 *
 * SECURITY: `url` is the caller's own string round-tripped through SQLite and
 * `finalUrl` is chosen by whatever the audited site redirected to. Both are
 * stripped of the control/bidi class and clamped before they enter a result —
 * see {@link displaySafe}.
 */

import { listHistory, type HistoryRow } from "@/lib/db/persistence";
import type { AuditSource, CategoryScores, FormFactor } from "@/lib/lighthouse/types";
import {
  optionalEnum,
  optionalInteger,
  optionalString,
  rejectUnknownArgs,
} from "@/lib/mcp/args";
import { McpToolError, jsonResult, type McpTool, type McpToolResult } from "@/lib/mcp/types";
import { safeText } from "@/lib/text/displaySafe";
import { auditUrlKey } from "@/lib/urls/normalizeAuditUrl";

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/** Rows returned when the caller does not say. Enough to see a trend, cheap to read. */
export const DEFAULT_HISTORY_LIMIT = 10;

/**
 * Ceiling on `limit`.
 *
 * Not a database limit — `listHistory()` reads every row regardless — but a
 * CONTEXT limit, and it was 50 until the Phase G security review priced the
 * worst case honestly (L-c): the bound is `limit` × {@link MAX_REQUESTED_URL},
 * doubled because `jsonResult` emits the payload as text AND as structured
 * content, so 50 rows of long tracking URLs is a six-figure character count, not
 * "a few thousand tokens". 25 halves that and is still more history than any
 * single question needs; an agent that wants the whole archive wants a CSV
 * export, which the app has.
 */
export const MAX_HISTORY_LIMIT = 25;

/**
 * Clamp on the REQUESTED url, set to `MAX_ARG_CHARS` on purpose.
 *
 * This string is round-trippable input: the obvious next move for an agent
 * reading a history row is to pass its `url` back to `audit_url`, and a
 * truncated address would silently audit a different page. 2048 is the ceiling
 * every browser and server already imposes on a URL, so no real address is
 * touched; the bound exists only so an unbounded string cannot reach the window.
 */
const MAX_REQUESTED_URL = 2_048;

/**
 * Longest timestamp echoed into a payload. An ISO-8601 instant is 24 characters;
 * this is room for any legitimate variant and none for a story.
 */
const MAX_TIMESTAMP_CHARS = 64;

/**
 * Clamp on `finalUrl`, deliberately much tighter than {@link MAX_REQUESTED_URL}.
 *
 * The asymmetry is the point. `url` is what the caller asked for and may be sent
 * back to another tool; `finalUrl` is what the PAGE said — attacker-chosen, and
 * informational here (it tells the agent a redirect happened, nothing more). It
 * is never an input to anything, so 300 costs nothing and bounds the one field
 * on this surface an audited site controls end to end.
 */
const MAX_FINAL_URL = 300;

/**
 * The categories this run actually scored.
 *
 * `rowToHistory` fills every category key, using `null` for "this run has no
 * score for it" — a failed run, a category that was not selected, a row written
 * before Lighthouse 13.3 added a fifth. To a reader, `null` and *absent* are the
 * same fact, so the null entries are pure token cost in a payload the plan asks
 * to keep compact. The run's `status` already says whether to expect scores at
 * all, so nothing is lost by omitting them.
 */
function scoredOnly(scores: CategoryScores): CategoryScores {
  const out: CategoryScores = {};
  for (const [category, score] of Object.entries(scores)) {
    if (typeof score === "number") out[category as keyof CategoryScores] = score;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Payload                                                                     */
/* -------------------------------------------------------------------------- */

/** One archived run, projected down to what an agent can act on. */
export type HistoryEntry = {
  /** The id to pass to `compare_runs` / `check_budget`. */
  runId: string;
  /** The URL as it was requested. Safe to hand back to `audit_url`. */
  url: string;
  /** Where the page finished, when it differed from `url`; `null` otherwise. */
  finalUrl: string | null;
  device: FormFactor;
  status: "done" | "error";
  /** Which engine produced it — a local Chrome run or PageSpeed Insights. */
  source: AuditSource;
  /** 0–100 per category; only the categories this run actually scored. */
  scores: CategoryScores;
  /** ISO time Lighthouse ran; `null` for a failed run. */
  fetchTime: string | null;
  /** ISO time the row was archived. Always present — the sort key. */
  createdAt: string;
};

/** What `get_history` returns. */
export type GetHistoryPayload = {
  /** Newest first. */
  runs: HistoryEntry[];
  /** `runs.length` — stated so a reader never has to count. */
  returned: number;
  /**
   * Matches BEFORE `limit`.
   *
   * The one field that keeps this tool honest. Ten rows out of ten and ten rows
   * out of four hundred are different answers to "has this page been audited
   * before?", and an agent that cannot tell them apart will conclude it has seen
   * the whole archive whenever the window happens to be full.
   */
  matched: number;
  /** Present only when nothing matched: what to do instead. */
  note?: string;
};

/* -------------------------------------------------------------------------- */
/* Tool                                                                        */
/* -------------------------------------------------------------------------- */

const ARGUMENT_NAMES = ["url", "limit", "device", "status"] as const;

/** Whether one archived run is the page the caller asked about. */
function matchesUrlKey(row: HistoryRow, key: string): boolean {
  if (auditUrlKey(row.url) === key) return true;
  return row.finalUrl !== null && auditUrlKey(row.finalUrl) === key;
}

/** Project one row. `finalUrl` collapses to `null` when it says nothing new. */
function projectRow(row: HistoryRow): HistoryEntry {
  const url = safeText(row.url, MAX_REQUESTED_URL);
  const finalUrl =
    row.finalUrl === null || row.finalUrl === row.url
      ? null
      : safeText(row.finalUrl, MAX_FINAL_URL);
  return {
    runId: row.id,
    url,
    finalUrl,
    device: row.formFactor,
    status: row.status,
    source: row.source,
    scores: scoredOnly(row.scores),
    // Clamped like every other stored string, and for the same reason as in
    // `compare_runs`: it originates as `pickString(lhr, "fetchTime")` — a report
    // field that is never parsed as a date, only carried. Lighthouse authors it
    // today, so this is consistency rather than a live threat, and three tools
    // reading one field three different ways was the actual defect (Phase G
    // security re-review, L2).
    fetchTime: row.fetchTime === null ? null : safeText(row.fetchTime, MAX_TIMESTAMP_CHARS),
    createdAt: safeText(row.createdAt, MAX_TIMESTAMP_CHARS),
  };
}

/**
 * What to say when nothing matched.
 *
 * An empty archive is a valid answer, not a failure — so this is a `note` on a
 * successful result rather than an {@link McpToolError}. It still has to be
 * actionable, and the actionable part is *which* of the two things went wrong:
 * a page nobody has audited on this machine, or filters that excluded every run
 * of a page that has been.
 */
function emptyNote(hasUrl: boolean, hasFilters: boolean): string {
  const filtered = hasFilters ? " with those filters" : "";
  const subject = hasUrl
    ? `No stored run matches that URL${filtered}.`
    : `No runs match${filtered}.`;
  const advice = hasFilters
    ? ' Drop "device"/"status", or audit the page with audit_url first.'
    : " Audit the page with audit_url first.";
  return `${subject}${advice} This archive only holds audits made on this machine.`;
}

export const getHistoryTool: McpTool = {
  name: "get_history",
  title: "Recent audit runs",
  description:
    "List runs already in this machine's audit archive, newest first. Use it to find " +
    "the run id to pass to compare_runs or check_budget, and to check whether a page " +
    "has been audited before spending a fresh audit on it. Returns identity, status " +
    "and category scores only — call compare_runs for what actually changed. " +
    "Matching on url ignores a trailing slash and a #fragment.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Only runs of this page. A trailing slash and a #fragment are ignored, and " +
          "a run that redirected to this URL matches too. Omit for the whole archive.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_HISTORY_LIMIT,
        default: DEFAULT_HISTORY_LIMIT,
        description: "How many runs to return. The response also reports the total before this cap.",
      },
      device: {
        type: "string",
        enum: ["mobile", "desktop"],
        description: "Only runs on this emulated device. Omit for both.",
      },
      status: {
        type: "string",
        enum: ["done", "error"],
        description:
          'Only runs that completed ("done") or only runs that failed ("error"). ' +
          "Omit for both. Only a done run has scores or a report to compare.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "Recent audit runs",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },

  async handler(args: Record<string, unknown>): Promise<McpToolResult> {
    rejectUnknownArgs(args, ARGUMENT_NAMES);

    const rawUrl = optionalString(args, "url");
    const limit = optionalInteger(args, "limit", { min: 1, max: MAX_HISTORY_LIMIT })
      ?? DEFAULT_HISTORY_LIMIT;
    const device = optionalEnum(args, "device", ["mobile", "desktop"] as const);
    const status = optionalEnum(args, "status", ["done", "error"] as const);

    // An unparseable `url` is a rejection, not an empty list: "no runs for
    // ftp://x" would read to a model as "this page has never been audited",
    // which is a different and much more expensive conclusion than "that is not
    // an address I can look up". The string itself is never echoed — it is
    // caller-controlled text, and args.ts sets the rule that only argument NAMES
    // go into a message.
    let key: string | null = null;
    if (rawUrl !== undefined) {
      key = auditUrlKey(rawUrl);
      if (key === null) {
        throw new McpToolError(
          '"url" must be an http(s) page address, e.g. "https://example.com/pricing". ' +
            "Pass the page you audited, not a run id.",
        );
      }
    }

    // `listHistory()` is already newest-first and that ordering is load-bearing
    // (the archive must open on the audit you just ran), so this filters and
    // slices without ever re-sorting.
    const matched = listHistory().filter((row) => {
      if (key !== null && !matchesUrlKey(row, key)) return false;
      if (device !== undefined && row.formFactor !== device) return false;
      if (status !== undefined && row.status !== status) return false;
      return true;
    });

    const runs = matched.slice(0, limit).map(projectRow);
    const payload: GetHistoryPayload = {
      runs,
      returned: runs.length,
      matched: matched.length,
    };
    if (runs.length === 0) {
      payload.note = emptyNote(
        key !== null,
        device !== undefined || status !== undefined,
      );
    }
    return jsonResult(payload);
  },
};
