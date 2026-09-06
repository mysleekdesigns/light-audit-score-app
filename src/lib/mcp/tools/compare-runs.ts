/**
 * `compare_runs` — Phase E's audit-level diff, projected down for an agent
 * (ROADMAP Phase G).
 *
 * Same question as `GET /api/reports/:runId/diff?baseline=<id>` and the same
 * answer computed by the same differ: **why did we drop 8 points?** What differs
 * is the reader. The route serves a browser that renders a filterable table and
 * a request waterfall; this serves a model that pays for every token and cannot
 * scroll past the ones it does not need.
 *
 * ## Ordering
 *
 * `baselineRunId` is the EARLIER / reference run, `comparisonRunId` the LATER /
 * subject run — the route's convention, restated as two named arguments because
 * a tool call has no path segment to carry it. Everything downstream depends on
 * it: a negative `scoreDeltas.performance` means the comparison run is worse,
 * and a positive `savingsDeltaMs` means it wastes more. Swapping the two ids
 * produces a valid, exactly inverted answer, which is why the argument
 * descriptions say which is which rather than leaving it to the names.
 *
 * ## The projection is the point
 *
 * A raw {@link RunDiff} carries up to 80 audit deltas, 20 opportunities and
 * three lists of 40 request rows, each row holding a URL of up to 2048
 * characters chosen by the audited page. That is a fine payload for a table and
 * an absurd one for a context window — a single call could plausibly cost more
 * than the audit that produced it. So {@link projectRunDiff} keeps what an agent
 * can act on and drops what it cannot:
 *
 *  - **Dropped: the request URL lists.** Unbounded in content and page-
 *    controlled, and mostly analytics churn — against two real reports of one
 *    page, 19 of 32 request keys came out added/removed and nearly all were the
 *    same beacons re-requested with a fresh cache-buster (see `resourceRows` in
 *    `@/lib/compare/what-changed-view`). What survives is the summary that is
 *    immune to that churn: counts, and the signed byte and request deltas.
 *  - **Dropped: audit `description`.** 280 characters of Lighthouse's standing
 *    advice per audit, which the model on the other end already knows. The audit
 *    `id` is the lookup key for it, and the app shows the text for free.
 *  - **Dropped: `categories`, `weight`, `basis`, and both display values.** The
 *    scores and the note carry the finding; these carry how the differ reached
 *    it. `basis: "presence"` still survives in spirit, as the note the audit row
 *    prints instead of a story about movement.
 *  - **Kept, and load-bearing: `truncated`.** Both caps are windows onto a
 *    ranked list, and a model that cannot tell "3 audits moved" from "3 of 60
 *    audits moved" will confidently report the wrong cause.
 *
 * ## Posture, inherited rather than re-derived
 *
 * From the diff route (`@/app/api/reports/[runId]/diff/route.ts`), whose reviews
 * these decisions came out of:
 *  - both ids are bounded BEFORE any lookup, and an over-long one is refused
 *    without being echoed;
 *  - both are resolved through SQLite, so caller input never reaches `path.join`;
 *  - each report is capped at HALF the single-report ceiling, because both are
 *    live at once;
 *  - an absent report is an ordinary, actionable error (pruned or legacy), while
 *    a present-but-corrupt one is a distinct fault that says so.
 *
 * There is no memo here, unlike the route. The route caches because a browser
 * re-requests the same diff on every render and it is reachable blind from
 * another loopback port; an agent asks once, per turn, over a pipe it opened
 * itself, and a cache would only add a way to serve a deleted run.
 */

import {
  auditNumericNote,
  auditPresenceNote,
  summarizeRunDiff,
  worstRegressedCategory,
  formatNumericDelta,
  formatSignedInt,
  MAX_TITLE,
  NO_CHANGE,
  type RunDiffSummary,
} from "@/lib/compare/what-changed-view";
import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import {
  optionalInteger,
  rejectUnknownArgs,
  requireString,
} from "@/lib/mcp/args";
import { McpToolError, jsonResult, type McpTool, type McpToolResult } from "@/lib/mcp/types";
import { safeText } from "@/lib/text/displaySafe";
import type {
  AuditDelta,
  DeltaStatus,
  OpportunityDelta,
  RunDiff,
} from "@/lib/reports/diff-types";
import {
  MAX_REPORT_BYTES,
  loadRunLhr,
  runReportResolves,
  type LoadReportFailure,
} from "@/lib/reports/loadReport";
import { extractRunDiff } from "@/lib/reports/report-diff";
import { ABSENT } from "@/lib/reports/waterfall-view";
import { CATEGORY_LABELS } from "@/lib/scores";

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Upper bound on a run id this tool will look up.
 *
 * 64, matched to the diff route's own `MAX_RUN_ID_LENGTH` deliberately: this is
 * a second door into the very same lookup, and two doors into one lookup must
 * not disagree about what an id may be. Ids are nanoids (21 chars); the ceiling
 * exists so an unbounded string never reaches a lookup, not because 64 means
 * anything.
 */
export const MAX_RUN_ID_LENGTH = 64;

/** Audits listed when the caller does not say. */
export const DEFAULT_MAX_AUDITS = 8;
/** Opportunities listed when the caller does not say. */
export const DEFAULT_MAX_OPPORTUNITIES = 5;
/**
 * Ceiling on either list.
 *
 * Far below the contract's own 80/20. The differ's caps bound what a *table* may
 * hold; these bound what is worth a model's attention, and past a couple of
 * dozen ranked rows an agent is reading noise it will summarise back into three
 * findings anyway.
 */
export const MAX_LISTED_DELTAS = 25;

/**
 * Clamp on `finalUrl`.
 *
 * Informational on this surface: `urlMismatch` is decided by the differ on the
 * FULL strings before anything is clamped, so shortening here cannot change the
 * verdict — it only bounds a value the audited page chose end to end.
 */
const MAX_FINAL_URL = 300;

/** Clamp on a Lighthouse audit/opportunity id. Real ones are short slugs. */
const MAX_AUDIT_ID = 100;

/* -------------------------------------------------------------------------- */
/* Payload                                                                     */
/* -------------------------------------------------------------------------- */

/** Identity and headline scores for one side of the comparison. */
export type CompareSide = {
  runId: string;
  /** Where the run finished; `""` when the report did not record one. */
  finalUrl: string;
  /** ISO time Lighthouse ran; `""` when the report did not record one. */
  fetchTime: string;
  /** 0–100 per category; only the categories this run actually scored. */
  scores: CategoryScores;
};

/** One audit that moved, ranked by the differ. */
export type CompareAudit = {
  /** Lighthouse audit id — the key to look the full advice up by. */
  id: string;
  title: string;
  status: DeltaStatus;
  /** 0–100, on the same scale as the category scores; `null` when unscored/absent. */
  baselineScore: number | null;
  /** @see baselineScore */
  comparisonScore: number | null;
  /** Signed score points, `comparison − baseline`; `null` when either side has none. */
  scoreDelta: number | null;
  /**
   * The measurement beside the score — `"+340 KB"`, `"+1.24 s"` — or which side
   * a presence-only audit was on. Absent when the numbers already say it all.
   *
   * This is the field the whole contract exists for: "we dropped 8 points"
   * becomes actionable only when the bytes appear next to the score.
   */
  note?: string;
};

/** One performance opportunity whose estimated savings moved. */
export type CompareOpportunity = {
  id: string;
  title: string;
  status: DeltaStatus;
  /** Estimated savings in ms; `null` when absent or unquantified. */
  baselineSavingsMs: number | null;
  /** @see baselineSavingsMs */
  comparisonSavingsMs: number | null;
  /**
   * `comparison − baseline` savings in ms. POSITIVE means the comparison run
   * wastes MORE — a regression. `null` when either side is missing.
   */
  savingsDeltaMs: number | null;
};

/**
 * The request-level half, as counts only.
 *
 * Every figure here is summed over the page, which is what makes it worth
 * keeping when the per-URL rows are not: a beacon re-requested with a fresh
 * cache-buster appears in both `added` and `removed` and moves neither
 * `requestCountDelta` nor `transferSizeDelta`.
 */
export type CompareResources = {
  /** URL keys only the comparison run requested (pre-cap total). */
  added: number;
  /** URL keys only the baseline run requested (pre-cap total). */
  removed: number;
  /** URL keys both requested whose size or count moved (pre-cap total). */
  changed: number;
  /** URL keys both requested that did not move at all. */
  unchanged: number;
  /** Signed change in the number of REQUESTS (not URL keys). */
  requestCountDelta: number;
  /** Signed change in total transfer bytes. */
  transferSizeDelta: number;
  /**
   * True when either report carried no usable network trace — "one of these runs
   * predates the feature", which is not the same claim as "the page fetched
   * nothing". Every count above is meaningless when this is true.
   */
  unavailable: boolean;
};

/** What `compare_runs` returns. */
export type CompareRunsPayload = {
  /** One line an agent can quote verbatim before it reads anything else. */
  summary: string;
  /** The earlier / reference run. */
  baseline: CompareSide;
  /** The later / subject run. */
  comparison: CompareSide;
  /**
   * Signed score points per category, `comparison − baseline`.
   *
   * A category scored in only one of the two runs is ABSENT rather than zero —
   * the house rule that a missing value is silence, not a measurement. Diffing
   * against an implied 0 would report a catastrophic regression every time a run
   * simply did not select a category.
   */
  scoreDeltas: Partial<Record<LighthouseCategory, number>>;
  /** The worst movers first, capped by `maxAudits`. */
  audits: CompareAudit[];
  /** The biggest savings regressions first, capped by `maxOpportunities`. */
  opportunities: CompareOpportunity[];
  resources: CompareResources;
  /** Audits present in both runs that did not move. */
  unchangedAuditCount: number;
  /**
   * True when the two runs finished on different URLs. Not an error — a redirect
   * target can legitimately change — but it means this may be a comparison of
   * two different pages, and every number above should be read that way.
   */
  urlMismatch: boolean;
  /**
   * How many movers were left out of each list. Both zero means the lists are
   * complete; anything else means the agent is looking at a window and should
   * raise the cap before concluding it has seen everything that moved.
   */
  truncated: { audits: number; opportunities: number };
};

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

/** The categories a run actually scored; see `scoreDeltas` on omitting the rest. */
function scoredOnly(scores: CategoryScores): CategoryScores {
  const out: CategoryScores = {};
  for (const [category, score] of Object.entries(scores)) {
    if (typeof score === "number") out[category as keyof CategoryScores] = score;
  }
  return out;
}

/** An audit's 0–1 score on the 0–100 scale every other surface here shows. */
function toPoints(score: number | null): number | null {
  return score === null || !Number.isFinite(score) ? null : Math.round(score * 100);
}

/** A raw millisecond figure, rounded. Lighthouse emits fractions nobody can act on. */
function toWholeMs(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value);
}

/**
 * A signed delta derived from the two ROUNDED values rather than by scaling the
 * contract's own delta.
 *
 * The contract carries `scoreDelta` on the 0–1 scale, and `Math.round(delta *
 * 100)` can disagree by a point with `round(after) − round(before)` when the two
 * roundings go opposite ways. A table can live with that; a model reading
 * `91 → 85 (−7)` cannot, and will either "correct" the arithmetic or report the
 * discrepancy as a finding. The differ still decides WHETHER there is a delta —
 * `null` in, `null` out — so nothing is being re-diffed here, only re-rounded.
 */
function pointsDelta(
  before: number | null,
  after: number | null,
  contractDelta: number | null,
): number | null {
  if (contractDelta === null || before === null || after === null) return null;
  return after - before;
}

/**
 * The note beside an audit row.
 *
 * Three sources in priority order, all borrowed from the card's own view logic
 * so the tool and the screen say the same thing about the same audit:
 * presence first (a one-sided audit has no story about movement), then the
 * measurement beside a scored audit, then — for a SCORELESS diagnostic, whose
 * score columns are both `null` — the measurement itself, which is the only
 * thing that row has to report.
 *
 * Every branch returns generated text over numbers, so nothing page-derived
 * reaches it and it needs no clamp of its own.
 */
function auditNote(delta: AuditDelta): string | undefined {
  const presence = auditPresenceNote(delta);
  if (presence !== null) return presence;

  const scoredNote = auditNumericNote(delta);
  if (scoredNote !== null) return scoredNote;

  if (delta.baselineScore === null && delta.comparisonScore === null) {
    const numeric = formatNumericDelta(delta.numericDelta, delta.numericUnit);
    if (numeric !== ABSENT && numeric !== NO_CHANGE) return numeric;
  }
  return undefined;
}

function projectAudit(delta: AuditDelta): CompareAudit {
  const baselineScore = toPoints(delta.baselineScore);
  const comparisonScore = toPoints(delta.comparisonScore);
  const audit: CompareAudit = {
    id: safeText(delta.id, MAX_AUDIT_ID),
    title: safeText(delta.title, MAX_TITLE),
    status: delta.status,
    baselineScore,
    comparisonScore,
    scoreDelta: pointsDelta(baselineScore, comparisonScore, delta.scoreDelta),
  };
  const note = auditNote(delta);
  if (note !== undefined) audit.note = note;
  return audit;
}

function projectOpportunity(delta: OpportunityDelta): CompareOpportunity {
  const baselineSavingsMs = toWholeMs(delta.baselineSavingsMs);
  const comparisonSavingsMs = toWholeMs(delta.comparisonSavingsMs);
  return {
    id: safeText(delta.id, MAX_AUDIT_ID),
    title: safeText(delta.title, MAX_TITLE),
    status: delta.status,
    baselineSavingsMs,
    comparisonSavingsMs,
    savingsDeltaMs: pointsDelta(
      baselineSavingsMs,
      comparisonSavingsMs,
      delta.savingsDeltaMs,
    ),
  };
}

/** Signed score points per category, for the categories BOTH runs scored. */
function categoryDeltas(
  baseline: CategoryScores,
  comparison: CategoryScores,
): Partial<Record<LighthouseCategory, number>> {
  const deltas: Partial<Record<LighthouseCategory, number>> = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const before = baseline[category];
    const after = comparison[category];
    if (typeof before !== "number" || typeof after !== "number") continue;
    deltas[category] = after - before;
  }
  return deltas;
}

/**
 * The one-line headline.
 *
 * Counts come from the diff's PRE-CAP totals, not from the capped lists below
 * it: this sentence is about the two runs, and the caps are about this payload.
 * Saying "3 audits moved" when 60 did, because the caller asked for three rows,
 * would be the one place a compact payload turns into a false one.
 */
function summaryLine(diff: RunDiff, summary: RunDiffSummary): string {
  const worst = worstRegressedCategory(diff.baseline.scores, diff.comparison.scores);
  const before = diff.baseline.scores[worst];
  const after = diff.comparison.scores[worst];
  const parts = [
    typeof before === "number" && typeof after === "number"
      ? `${CATEGORY_LABELS[worst]} ${before} → ${after} (${formatSignedInt(after - before)})`
      : `${CATEGORY_LABELS[worst]} was not scored in both runs`,
    `${summary.auditsTotal} audits moved`,
    `${summary.opportunitiesTotal} opportunities moved`,
    summary.resourcesUnavailable
      ? "one report has no request data"
      : `requests ${summary.requestCountDelta} (${summary.transferDelta})`,
  ];
  if (diff.urlMismatch) parts.push("the runs finished on different URLs");
  return parts.join(" · ");
}

/** How many movers a cap left out. Counts from the PRE-cap total, never the list. */
function omitted(total: number, shown: number): number {
  return Math.max(0, total - shown);
}

/**
 * Project a {@link RunDiff} into the tool payload.
 *
 * Exported and pure so the interesting half of this module — the caps, the
 * truncation counts, the clamping, and the absence of any request URL — is
 * testable against a hand-built diff, with no database, no report on disk and no
 * Lighthouse anywhere in the process.
 */
export function projectRunDiff(
  diff: RunDiff,
  limits: { maxAudits: number; maxOpportunities: number },
): CompareRunsPayload {
  const summary = summarizeRunDiff(diff);
  const audits = diff.audits.slice(0, limits.maxAudits).map(projectAudit);
  const opportunities = diff.opportunities
    .slice(0, limits.maxOpportunities)
    .map(projectOpportunity);

  return {
    summary: summaryLine(diff, summary),
    baseline: projectSide(diff.baseline),
    comparison: projectSide(diff.comparison),
    scoreDeltas: categoryDeltas(diff.baseline.scores, diff.comparison.scores),
    audits,
    opportunities,
    resources: {
      added: diff.totals.resourcesAdded,
      removed: diff.totals.resourcesRemoved,
      changed: diff.totals.resourcesChanged,
      unchanged: diff.resources.unchangedCount,
      requestCountDelta: diff.resources.requestCountDelta,
      transferSizeDelta: diff.resources.transferSizeDelta,
      unavailable: diff.resources.unavailable,
    },
    unchangedAuditCount: diff.unchangedAuditCount,
    urlMismatch: diff.urlMismatch,
    truncated: {
      audits: omitted(diff.totals.audits, audits.length),
      opportunities: omitted(diff.totals.opportunities, opportunities.length),
    },
  };
}

function projectSide(side: RunDiff["baseline"]): CompareSide {
  return {
    // Sanitised like its neighbours even though it cannot be free text today:
    // `runReportResolves` admits an id only if SQLite has a row for it, and
    // `loadRunLhr` returns the id the DB resolved. That invariant lives two
    // modules away, so relying on it here would make this echo's safety depend
    // on someone not relaxing a fallback branch (Phase G security review, L-a).
    runId: safeText(side.runId, MAX_RUN_ID_LENGTH),
    finalUrl: safeText(side.finalUrl, MAX_FINAL_URL),
    fetchTime: safeText(side.fetchTime, 40),
    scores: scoredOnly(side.scores),
  };
}

/* -------------------------------------------------------------------------- */
/* Tool                                                                        */
/* -------------------------------------------------------------------------- */

const ARGUMENT_NAMES = [
  "baselineRunId",
  "comparisonRunId",
  "maxAudits",
  "maxOpportunities",
] as const;

/**
 * The error for a run with nothing to diff.
 *
 * Names the ARGUMENT, never the id. Which of the two is wrong is the only fact
 * that makes this fixable in one retry, and the id itself is caller-controlled
 * text this tool has no reason to echo — the rule `./args` sets for every other
 * rejection on this surface.
 */
function noStoredReport(argument: string): McpToolError {
  return new McpToolError(
    `"${argument}" names no run with a stored report. That is ordinary — the run may ` +
      "have failed, been pruned, or predate report storage. Call get_history and pick a " +
      'run whose status is "done".',
  );
}

/** Map a load failure onto the error the caller should see. */
function loadFailure(argument: string, reason: LoadReportFailure): McpToolError {
  if (reason === "not_found") return noStoredReport(argument);
  return new McpToolError(
    `The stored report for "${argument}" is present but unreadable — it is ` +
      `${reason === "too_large" ? "larger than this server will parse" : "not valid JSON"}. ` +
      "No other argument will fix this; re-audit the page to replace the report.",
  );
}

export const compareRunsTool: McpTool = {
  name: "compare_runs",
  title: "Compare two runs",
  description:
    "Diff two completed runs of a page and say what changed: per-category score deltas, " +
    "the audits and opportunities that moved (worst first), and a request/transfer " +
    "summary. This is the tool that answers \"why did we drop 8 points?\". " +
    "baselineRunId is the earlier/reference run and comparisonRunId the later/subject " +
    "run, so a negative score delta means the comparison run got worse. Both runs must " +
    "still have a stored report — get_history lists the ids.",
  inputSchema: {
    type: "object",
    properties: {
      baselineRunId: {
        type: "string",
        description: "Run id of the EARLIER / reference run, from get_history or audit_url.",
      },
      comparisonRunId: {
        type: "string",
        description:
          "Run id of the LATER / subject run — the one the answer is about. Must differ " +
          "from baselineRunId.",
      },
      maxAudits: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LISTED_DELTAS,
        default: DEFAULT_MAX_AUDITS,
        description:
          "How many moved audits to list, worst first. The response reports how many " +
          "were left out.",
      },
      maxOpportunities: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LISTED_DELTAS,
        default: DEFAULT_MAX_OPPORTUNITIES,
        description:
          "How many moved opportunities to list, biggest regression first. The response " +
          "reports how many were left out.",
      },
    },
    required: ["baselineRunId", "comparisonRunId"],
    additionalProperties: false,
  },
  annotations: {
    title: "Compare two runs",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },

  async handler(args: Record<string, unknown>): Promise<McpToolResult> {
    rejectUnknownArgs(args, ARGUMENT_NAMES);

    // Bounded BEFORE any lookup, and `requireString` reports the ceiling without
    // echoing the value — an over-long id least of all.
    const baselineRunId = requireString(args, "baselineRunId", MAX_RUN_ID_LENGTH);
    const comparisonRunId = requireString(args, "comparisonRunId", MAX_RUN_ID_LENGTH);
    const maxAudits =
      optionalInteger(args, "maxAudits", { min: 1, max: MAX_LISTED_DELTAS }) ??
      DEFAULT_MAX_AUDITS;
    const maxOpportunities =
      optionalInteger(args, "maxOpportunities", { min: 1, max: MAX_LISTED_DELTAS }) ??
      DEFAULT_MAX_OPPORTUNITIES;

    if (baselineRunId === comparisonRunId) {
      throw new McpToolError(
        "baselineRunId and comparisonRunId must be two different runs — a run diffed " +
          "against itself reports nothing. Call get_history to find an earlier run of " +
          "the same page.",
      );
    }

    // Existence first, and per-argument, so the agent learns WHICH id is stale
    // in one round trip. The DB probe is cheap; the two reads it guards are not.
    if (!runReportResolves(baselineRunId)) throw noStoredReport("baselineRunId");
    if (!runReportResolves(comparisonRunId)) throw noStoredReport("comparisonRunId");

    // Halved on purpose: both reports are live at once, so the pair costs no more
    // peak memory than a single-report read.
    const options = { maxBytes: MAX_REPORT_BYTES / 2 };
    const [baseline, comparison] = await Promise.all([
      loadRunLhr(baselineRunId, options),
      loadRunLhr(comparisonRunId, options),
    ]);
    if (baseline.status === "error") throw loadFailure("baselineRunId", baseline.reason);
    if (comparison.status === "error") {
      throw loadFailure("comparisonRunId", comparison.reason);
    }

    // The differs are contractually total — a report missing an audit yields an
    // empty result rather than throwing. This is the backstop for a file that is
    // valid JSON but not a report at all, which must reach the agent as advice
    // rather than as the dispatcher's generic "failed unexpectedly".
    let diff: RunDiff;
    try {
      diff = extractRunDiff({
        // Both sides carry the id the loader resolved, not the raw argument.
        baseline: { lhr: baseline.lhr, runId: baseline.runId },
        comparison: { lhr: comparison.lhr, runId: comparison.runId },
      });
    } catch {
      throw new McpToolError(
        "Those two stored reports could not be diffed — at least one is valid JSON but " +
          "not a Lighthouse report. Re-audit the page to replace it.",
      );
    }

    return jsonResult(projectRunDiff(diff, { maxAudits, maxOpportunities }));
  },
};
