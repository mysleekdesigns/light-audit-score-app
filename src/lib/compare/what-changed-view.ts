/**
 * Pure presentation logic for the What Changed card (ROADMAP Phase E).
 *
 * Same division of labour as Phase D's `waterfall-view`, and for the same
 * reason: Vitest runs `environment: "node"` in this project — no jsdom, no
 * testing-library — so anything a reviewer could get *wrong* lives here, where
 * it can be tested directly, and `what-changed-card.tsx` does nothing but map
 * these results onto markup. The filters, the signed number formatting, the
 * status marks and — most importantly — the empty-state predicates are all
 * decisions, not rendering.
 *
 * The empty states are the part worth being pedantic about. "Nothing changed",
 * "your filter hides everything", "nothing moved in THIS section" and "one of
 * these reports predates the network trace" look identical if you only check
 * `list.length === 0`, and three of the four would be a lie. Each gets its own
 * reason here so the card can say WHY, which is the standard Phase D set.
 *
 * Every function is total. A stored report can be years old, a hostile page can
 * serve anything, and either side of the diff can be missing a value entirely —
 * so `null` scores, absent numeric units, empty display values and zero-length
 * lists are all ordinary inputs that must produce something renderable.
 *
 * SECURITY: the `url`/`path`/`host` reached through {@link resourceLabel} are
 * chosen by the page under audit (see the module note on `@/lib/reports/
 * diff-types`). Nothing here builds markup or an href — it only formats,
 * reorders and clamps — so the escaping obligation stays with the component,
 * which renders every one of these strings as text and links none of them.
 */

import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import type {
  AuditDelta,
  DeltaStatus,
  OpportunityDelta,
  ResourceDelta,
  ResourceDiff,
  RunDiff,
} from "@/lib/reports/diff-types";
import {
  ABSENT,
  clampText,
  formatBytes,
  formatDuration,
  hostOf,
  requestLabel,
  type RequestLabel,
} from "@/lib/reports/waterfall-view";

/* -------------------------------------------------------------------------- */
/* Status marks                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The chip each {@link DeltaStatus} renders as. The abbreviation is the meaning,
 * not the colour — the same rule Phase D's `RB` / `3P` marks follow, so the
 * tables still read correctly in greyscale and to a screen reader.
 */
export const DELTA_MARKS: Record<DeltaStatus, { abbr: string; label: string }> = {
  regressed: { abbr: "WORSE", label: "Regressed" },
  improved: { abbr: "BETTER", label: "Improved" },
  unchanged: { abbr: "SAME", label: "Unchanged" },
  added: { abbr: "NEW", label: "Newly present" },
  removed: { abbr: "GONE", label: "Disappeared" },
};

/** How a row's change should be *tinted* — a reinforcement of the printed mark. */
export type DeltaTone = "worse" | "better" | "neutral";

/**
 * The tone for a status.
 *
 * `added` and `removed` are deliberately NEUTRAL, echoing the contract: a newly
 * present *passing* audit is not a regression, and a disappeared audit usually
 * means Lighthouse marked it not-applicable rather than that the page improved.
 * Painting either red would invent a verdict the differ refused to make.
 */
export function deltaTone(status: DeltaStatus): DeltaTone {
  if (status === "regressed") return "worse";
  if (status === "improved") return "better";
  return "neutral";
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** What every formatter here prints for a real delta of exactly zero. */
export const NO_CHANGE = "±0";

/** Longest Lighthouse-authored label (title / display value) put into the DOM. */
export const MAX_TITLE = 160;

/** Signed integer with the house convention: `+8`, `-8`, `±0`, `—`. */
export function formatSignedInt(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return ABSENT;
  const rounded = Math.round(delta);
  if (rounded === 0) return NO_CHANGE;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

/** Signed transfer size: `+340 KB`, `-12 KB`, `±0`. */
export function formatSignedBytes(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return ABSENT;
  if (delta === 0) return NO_CHANGE;
  return `${delta > 0 ? "+" : "-"}${formatBytes(Math.abs(delta))}`;
}

/** Signed duration: `+1.24 s`, `-340 ms`, `±0`. */
export function formatSignedMs(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return ABSENT;
  if (delta === 0) return NO_CHANGE;
  return `${delta > 0 ? "+" : "-"}${formatDuration(Math.abs(delta))}`;
}

/**
 * An audit's 0–1 score on the 0–100 scale every other surface in this app shows.
 * `null` — unscored, or absent from that side — is silence, not zero.
 */
export function formatAuditScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return ABSENT;
  return String(Math.round(score * 100));
}

/** A `scoreDelta` (0–1 scale) as signed score POINTS, matching the score columns. */
export function formatScorePoints(scoreDelta: number | null): string {
  if (scoreDelta === null || !Number.isFinite(scoreDelta)) return ABSENT;
  return formatSignedInt(scoreDelta * 100);
}

/** One of Lighthouse's raw `numericValue`s, rendered in its own `numericUnit`. */
export function formatNumericValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return ABSENT;
  switch (unit) {
    case "byte":
      return formatBytes(value);
    case "millisecond":
      return formatDuration(value);
    case "second":
      return formatDuration(value * 1000);
    default:
      return String(Number(value.toFixed(2)));
  }
}

/** The change in a `numericValue`, signed and in its own unit. */
export function formatNumericDelta(delta: number | null, unit: string): string {
  if (delta === null || !Number.isFinite(delta)) return ABSENT;
  if (delta === 0) return NO_CHANGE;
  const sign = delta > 0 ? "+" : "-";
  const magnitude = Math.abs(delta);
  switch (unit) {
    case "byte":
      return `${sign}${formatBytes(magnitude)}`;
    case "millisecond":
      return `${sign}${formatDuration(magnitude)}`;
    case "second":
      return `${sign}${formatDuration(magnitude * 1000)}`;
    default: {
      const rounded = Number(magnitude.toFixed(2));
      return rounded === 0 ? NO_CHANGE : `${sign}${rounded}`;
    }
  }
}

/**
 * Readout tone for a raw signed delta whose POSITIVE direction is the bad one —
 * more requests, more bytes, more third parties. Maps onto the existing readout
 * tones (`warn` = the score-average token, `good` = score-good), so nothing new
 * is introduced and the strip stays legible without the colour.
 */
export function growthTone(delta: number): "default" | "good" | "warn" {
  if (!Number.isFinite(delta) || delta === 0) return "default";
  return delta > 0 ? "warn" : "good";
}

/** `40 of 112` when the differ's cap bit, else just the count. */
export function capLabel(shown: number, total: number): string {
  return total > shown ? `${shown} of ${total}` : String(shown);
}

/* -------------------------------------------------------------------------- */
/* Audit rows                                                                  */
/* -------------------------------------------------------------------------- */

/** The three numeric cells one audit row prints, and which signal they came from. */
export interface AuditRowValues {
  baseline: string;
  comparison: string;
  change: string;
  /**
   * `score` when the row is showing 0–100 audit scores, `numeric` when the audit
   * is scoreless and the row is showing Lighthouse's own measurement instead.
   * The card labels the columns off this, so a scoreless diagnostic never
   * pretends its bytes are a score.
   */
  basis: "score" | "numeric";
}

/**
 * What one audit row prints in its Baseline / Comparison / Δ columns.
 *
 * Scores win whenever EITHER side has one, because the score is what actually
 * moved the category number. A scoreless audit — `total-byte-weight` and the
 * rest of Lighthouse's informative diagnostics — falls back to its rendered
 * display value, which is the only readable form of a raw `numericValue`.
 */
export function auditRowValues(delta: AuditDelta): AuditRowValues {
  const scored = delta.baselineScore !== null || delta.comparisonScore !== null;
  if (scored) {
    return {
      baseline: formatAuditScore(delta.baselineScore),
      comparison: formatAuditScore(delta.comparisonScore),
      change: formatScorePoints(delta.scoreDelta),
      basis: "score",
    };
  }
  return {
    baseline: displayOr(delta.baselineDisplayValue, delta.baselineNumericValue, delta.numericUnit),
    comparison: displayOr(
      delta.comparisonDisplayValue,
      delta.comparisonNumericValue,
      delta.numericUnit,
    ),
    change: formatNumericDelta(delta.numericDelta, delta.numericUnit),
    basis: "numeric",
  };
}

/** Lighthouse's own rendered value when it has one, else the raw number formatted. */
function displayOr(display: string, value: number | null, unit: string): string {
  const text = display.trim();
  return text ? clampText(text, MAX_TITLE) : formatNumericValue(value, unit);
}

/**
 * The measurement note beside a SCORED audit's title — "`+340 KB`", "`+1.24 s`".
 *
 * This is the sentence the whole contract exists for: "we dropped 8 points"
 * becomes "`unused-javascript` regressed and 340 KB of new script arrived" only
 * if the bytes appear next to the score. Returns `null` when there is nothing to
 * add — a scoreless row already shows its numbers in the columns, and a numeric
 * value that did not move is not news.
 */
export function auditNumericNote(delta: AuditDelta): string | null {
  if (delta.numericDelta === null || delta.numericDelta === 0) return null;
  const scored = delta.baselineScore !== null || delta.comparisonScore !== null;
  if (!scored) return null;
  const note = formatNumericDelta(delta.numericDelta, delta.numericUnit);
  return note === ABSENT || note === NO_CHANGE ? null : note;
}

/**
 * The note a PRESENCE row prints instead of a story about movement.
 *
 * `basis: "presence"` means the audit was on one side only, and that is a
 * routine run-to-run difference rather than a finding: Lighthouse omits audits
 * such as `bf-cache` and `modern-http-insight` from some runs of the same page
 * on the same version (155 audits in one run, 153 in the next). So the row says
 * WHICH SIDE it was on and stops there — the contract deliberately refuses to
 * sign these, and the UI must not sign them either.
 *
 * Returns `null` for every audit that actually moved, whose numbers speak.
 */
export function auditPresenceNote(delta: Pick<AuditDelta, "basis" | "status">): string | null {
  if (delta.basis !== "presence") return null;
  if (delta.status === "added") return "present only in the comparison run";
  if (delta.status === "removed") return "present only in the baseline run";
  return null;
}

/**
 * True when this audit cannot move any category score — Lighthouse's informative
 * diagnostics, and everything in a category's `hidden` group. Printed as a mark
 * so a user reading a long regression list knows which rows are colour and which
 * are the actual scoring event.
 */
export function isInformationalAudit(delta: Pick<AuditDelta, "weight">): boolean {
  return !(delta.weight > 0);
}

/** Which subset of the (already worst-first) audit list the card is showing. */
export type AuditFilter = "all" | "regressed" | "improved" | "added" | "removed";

/** Filter order, `all` first — the tab strip renders these in this order. */
export const AUDIT_FILTERS: readonly AuditFilter[] = [
  "all",
  "regressed",
  "improved",
  "added",
  "removed",
];

/**
 * Human label for a filter chip.
 *
 * The presence filters are worded as PRESENCE ("Appeared" / "Disappeared")
 * rather than as news ("New" / "Gone"), because that is all they mean: two runs
 * of the same page on the same Lighthouse version genuinely differ in which
 * audits they carry — `bf-cache` and `modern-http-insight` are simply absent
 * from some runs — so an audit changing sides is not by itself evidence that
 * anything changed about the page.
 */
export const AUDIT_FILTER_LABELS: Record<AuditFilter, string> = {
  all: "All",
  regressed: "Regressed",
  improved: "Improved",
  added: "Appeared",
  removed: "Disappeared",
};

/**
 * Narrow the audit list to one status. Non-mutating and order-preserving — the
 * differ already ranked these worst-first and a filter must not reshuffle them.
 */
export function filterAuditDeltas(
  audits: readonly AuditDelta[],
  filter: AuditFilter,
): AuditDelta[] {
  if (filter === "all") return [...audits];
  return audits.filter((audit) => audit.status === filter);
}

/** How many of each status are in a delta list (every status present, zeroed). */
export function countByStatus(
  deltas: readonly { status: DeltaStatus }[],
): Record<DeltaStatus, number> {
  const counts: Record<DeltaStatus, number> = {
    regressed: 0,
    improved: 0,
    unchanged: 0,
    added: 0,
    removed: 0,
  };
  for (const delta of deltas) counts[delta.status] += 1;
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Opportunity rows                                                            */
/* -------------------------------------------------------------------------- */

/** The three cells one opportunity row prints. */
export interface OpportunityRowValues {
  baseline: string;
  comparison: string;
  change: string;
}

/**
 * What one opportunity row prints. Note the sign convention the contract sets:
 * a POSITIVE `savingsDeltaMs` means the comparison run wastes MORE, which is a
 * regression — so the Δ column's tone comes from `status`, never from the sign.
 */
export function opportunityRowValues(delta: OpportunityDelta): OpportunityRowValues {
  return {
    baseline: savingsCell(delta.baselineDisplayValue, delta.baselineSavingsMs),
    comparison: savingsCell(delta.comparisonDisplayValue, delta.comparisonSavingsMs),
    change: formatSignedMs(delta.savingsDeltaMs),
  };
}

function savingsCell(display: string, savingsMs: number | null): string {
  const text = display.trim();
  if (text) return clampText(text, MAX_TITLE);
  return savingsMs === null ? ABSENT : formatDuration(savingsMs);
}

/* -------------------------------------------------------------------------- */
/* Resource rows                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The three request lists flattened into one table: what GREW first, then what
 * arrived, then what went away. Each list keeps the order the differ ranked it
 * in, and every row carries its own status mark, so the concatenation stays
 * readable without sub-headings.
 *
 * `changed` leads deliberately. Rows are keyed by the full URL, query string
 * included, and analytics beacons mint a fresh session id or cache-buster on
 * every run — against two real stored reports of one URL, 19 of 32 keys came
 * out added/removed and nearly all of them were the same beacons re-requested
 * with a new query string. A `changed` row is the one case where the identical
 * URL genuinely moved, so it is the only third of this table immune to that
 * churn, and it goes on top.
 */
export function resourceRows(resources: ResourceDiff): ResourceDelta[] {
  return [...resources.changed, ...resources.added, ...resources.removed];
}

/** The first-party host every resource row is labelled against. */
export function diffFinalHost(diff: Pick<RunDiff, "baseline" | "comparison">): string {
  return hostOf(diff.comparison.finalUrl) || hostOf(diff.baseline.finalUrl);
}

/**
 * The text a resource row shows for its request. Delegates to Phase D's
 * {@link requestLabel} — same rule (bare path at home, host + path when it
 * crossed hosts) and, critically, the same clamp: CSS `truncate` hides an
 * over-long string without shortening it, so a megabyte-scale `data:` URL would
 * otherwise put a megabyte in a text node, once per row.
 */
export function resourceLabel(delta: ResourceDelta, finalHost: string): RequestLabel {
  return requestLabel(delta, finalHost);
}

/**
 * What a request row prints in its Δ column.
 *
 * `transferDelta` is ALWAYS `null` on an `added`/`removed` row — the absent side
 * recorded no bytes, so the differ refuses to subtract — which would leave an
 * em dash on the majority of rows. The one-sided size is used instead, signed:
 * a URL the baseline never requested transferred zero bytes in that run, which
 * is exactly the basis `ResourceDiff.transferSizeDelta` is summed on, so the
 * column stays arithmetically consistent with the totals above it.
 *
 * A side that recorded NO bytes at all is still an em dash. `0` is a real
 * measurement here — a cache hit that cost nothing — and is not the same claim
 * as "we never saw this".
 */
export function resourceChangeValue(delta: ResourceDelta): string {
  if (delta.status === "added") {
    return delta.comparisonTransferSize === null
      ? ABSENT
      : formatSignedBytes(delta.comparisonTransferSize);
  }
  if (delta.status === "removed") {
    return delta.baselineTransferSize === null
      ? ABSENT
      : formatSignedBytes(-delta.baselineTransferSize);
  }
  return formatSignedBytes(delta.transferDelta);
}

/**
 * "1 → 2" when the page fetched this URL a different number of times, else
 * `null`. Worth its own note because it is invisible in the size columns: the
 * differ sums transfer bytes per URL, so "now fetched twice" arrives as a size
 * change unless the count is printed.
 */
export function resourceCountNote(delta: ResourceDelta): string | null {
  if (delta.baselineCount === delta.comparisonCount) return null;
  return `${delta.baselineCount} → ${delta.comparisonCount}`;
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

/** The readout strip above the tables — every figure pre-formatted and capped. */
export interface RunDiffSummary {
  /** `40 of 112` — honest about the differ's cap rather than silently truncating. */
  auditsLabel: string;
  auditsShown: number;
  auditsTotal: number;
  opportunitiesLabel: string;
  opportunitiesShown: number;
  opportunitiesTotal: number;
  /** Audits present on both sides that did not move. */
  unchangedAuditCount: number;
  /**
   * URL ROWS listed vs. the pre-cap total across added + changed + removed.
   *
   * Named for URLs rather than requests on purpose: the three lists — and
   * `ResourceDiff.unchangedCount` — count URL KEYS, while
   * `baselineRequestCount`/`comparisonRequestCount` count REQUESTS. A page that
   * fetches one URL three times contributes one key and three requests, so the
   * two must never be shown as the same denominator.
   */
  urlRowsLabel: string;
  urlRowsShown: number;
  urlRowsTotal: number;
  /** URL keys that did not move, and the whole union (moved + unchanged). */
  unchangedUrlCount: number;
  urlKeysTotal: number;
  /** Raw request counts on each side — REQUESTS, not URL keys. */
  baselineRequestCount: number;
  comparisonRequestCount: number;
  /**
   * Signed request-count and transfer-size movement across the whole page.
   * These are the churn-immune figures: they are summed over the page, so a
   * beacon re-requested with a fresh cache-buster moves neither of them even
   * though it appears in both the added and removed lists.
   */
  requestCountDelta: string;
  transferDelta: string;
  transferBaseline: string;
  transferComparison: string;
  thirdPartyDelta: string;
  /** True when either report carried no usable `network-requests` audit. */
  resourcesUnavailable: boolean;
}

/**
 * Project the header figures out of the payload. Reads the contract's own
 * `totals` rather than re-deriving anything from the capped lists — the whole
 * point of those pre-cap counts is that the UI can say "showing 40 of 112"
 * without disagreeing with the server about what 112 means.
 */
export function summarizeRunDiff(diff: RunDiff): RunDiffSummary {
  const { resources, totals } = diff;
  const urlRowsShown =
    resources.added.length + resources.changed.length + resources.removed.length;
  const urlRowsTotal =
    totals.resourcesAdded + totals.resourcesChanged + totals.resourcesRemoved;

  return {
    auditsLabel: capLabel(diff.audits.length, totals.audits),
    auditsShown: diff.audits.length,
    auditsTotal: totals.audits,
    opportunitiesLabel: capLabel(diff.opportunities.length, totals.opportunities),
    opportunitiesShown: diff.opportunities.length,
    opportunitiesTotal: totals.opportunities,
    unchangedAuditCount: diff.unchangedAuditCount,
    urlRowsLabel: capLabel(urlRowsShown, urlRowsTotal),
    urlRowsShown,
    urlRowsTotal,
    unchangedUrlCount: resources.unchangedCount,
    urlKeysTotal: urlRowsTotal + resources.unchangedCount,
    baselineRequestCount: resources.baselineRequestCount,
    comparisonRequestCount: resources.comparisonRequestCount,
    requestCountDelta: formatSignedInt(resources.requestCountDelta),
    transferDelta: formatSignedBytes(resources.transferSizeDelta),
    transferBaseline: formatBytes(resources.baselineTransferSize),
    transferComparison: formatBytes(resources.comparisonTransferSize),
    thirdPartyDelta: formatSignedInt(
      resources.comparisonThirdPartyCount - resources.baselineThirdPartyCount,
    ),
    resourcesUnavailable: resources.unavailable,
  };
}

/* -------------------------------------------------------------------------- */
/* Empty states                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Why a section has no rows. Four different sentences, because they are four
 * different facts and only one of them is "nothing happened":
 *
 *  - `identical`      — the two runs moved nothing anywhere. The diff worked.
 *  - `none-in-section`— other sections moved; this one did not.
 *  - `filtered`       — this section HAS rows, the active filter hides them all.
 *  - `unavailable`    — a report predates the feature (`ResourceDiff.unavailable`),
 *                       which is not the same as two runs that fetched nothing.
 */
export type EmptyReason = "identical" | "none-in-section" | "filtered" | "unavailable";

/** True when nothing measurable moved between the two runs at all. */
export function isIdenticalDiff(diff: RunDiff): boolean {
  const { resources, totals } = diff;
  return (
    totals.audits === 0 &&
    totals.opportunities === 0 &&
    totals.resourcesAdded === 0 &&
    totals.resourcesChanged === 0 &&
    totals.resourcesRemoved === 0 &&
    !resources.unavailable
  );
}

/**
 * Why the audits table is empty, or `null` when it is not.
 *
 * `visibleCount` is the post-filter row count the card is about to render, so a
 * filter that hides every row reports `filtered` — the one empty state the user
 * can fix from the keyboard — rather than claiming the runs were identical.
 */
export function auditsEmptyReason(
  diff: RunDiff,
  visibleCount: number,
  filter: AuditFilter,
): EmptyReason | null {
  if (visibleCount > 0) return null;
  if (diff.audits.length > 0 && filter !== "all") return "filtered";
  if (isIdenticalDiff(diff)) return "identical";
  return "none-in-section";
}

/** Why the opportunities table is empty, or `null` when it is not. */
export function opportunitiesEmptyReason(diff: RunDiff): EmptyReason | null {
  if (diff.opportunities.length > 0) return null;
  if (isIdenticalDiff(diff)) return "identical";
  return "none-in-section";
}

/**
 * Why the requests table is empty, or `null` when it is not. `unavailable` is
 * checked FIRST: a report stored without a `network-requests` audit has no
 * request data to be identical about, and saying "nothing changed" there would
 * be the exact lie Phase D's empty states were written to avoid.
 */
export function resourcesEmptyReason(diff: RunDiff): EmptyReason | null {
  if (diff.resources.unavailable) return "unavailable";
  if (resourceRows(diff.resources).length > 0) return null;
  if (isIdenticalDiff(diff)) return "identical";
  return "none-in-section";
}

/* -------------------------------------------------------------------------- */
/* The AI hand-off                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The categories worth offering to "explain this regression" — the ones BOTH
 * runs actually scored, in the canonical order. Falls back to `performance`
 * when the two runs share nothing scored, so the affordance always has a target
 * rather than disappearing on a partial run.
 */
export function analysisCategories(
  baseline: CategoryScores,
  comparison: CategoryScores,
): LighthouseCategory[] {
  const shared = LIGHTHOUSE_CATEGORIES.filter(
    (category) =>
      typeof baseline[category] === "number" && typeof comparison[category] === "number",
  );
  return shared.length > 0 ? shared : ["performance"];
}

/**
 * Which category the "explain this regression" affordance should default to:
 * the one that gave up the most points. When nothing regressed it defaults to
 * the first comparable category (`performance` in every ordinary run), because
 * "explain the smallest improvement" is not a question anyone is asking.
 */
export function worstRegressedCategory(
  baseline: CategoryScores,
  comparison: CategoryScores,
): LighthouseCategory {
  const categories = analysisCategories(baseline, comparison);
  let worst = categories[0];
  let worstDrop = 0;
  for (const category of categories) {
    const before = baseline[category];
    const after = comparison[category];
    if (typeof before !== "number" || typeof after !== "number") continue;
    const drop = before - after;
    if (drop > worstDrop) {
      worstDrop = drop;
      worst = category;
    }
  }
  return worst;
}
