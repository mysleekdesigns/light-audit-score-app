/**
 * The audit- and opportunity-level differs (ROADMAP Phase E).
 *
 * Two stored LHRs in, {@link AuditDelta}/{@link OpportunityDelta} lists out.
 * PURE, like the Phase D extractors beside them and `parseLhr` whose narrowing
 * helpers they reuse: no `node:fs`, no DB, no `lighthouse` import, no React. The
 * route reads both report files; this only reshapes them.
 *
 * ## Total, not filtered
 *
 * `diffAudits` classifies EVERY audit id present in either report — including
 * the ~170 per run that did nothing. That is deliberate and is the reason the
 * composer (`report-diff.ts`) owns the filtering and the caps: a differ that
 * pre-filtered could not be unit-tested for "correctly reports unchanged", which
 * is exactly the property that makes the rest trustworthy.
 *
 * ## Three rules inherited from earlier phases
 *
 *  1. **A missing value is silence, not zero** (Phase C's alert core,
 *     `src/lib/alerts/compare.ts`). An audit on one side only is `added` /
 *     `removed`, never diffed against an implied 0; a scored-vs-unscored pair is
 *     `unchanged` with `basis: "none"` rather than an invented direction.
 *  2. **Tolerance is shape-driven, not label-driven** (Phase D). Anything
 *     readable is read; nothing keys on a `details.type` label Lighthouse could
 *     rename under us. Every entry point returns `[]` rather than throwing on a
 *     malformed, empty or absent report.
 *  3. **Bounded output.** Descriptions are unbounded in principle and this
 *     payload crosses a wire, so every one is truncated through
 *     {@link MAX_DIFF_DESCRIPTION}. (Titles and descriptions are Lighthouse's
 *     OWN text — not page-authored — so they need no injection sanitising; the
 *     untrusted strings in this contract are the request URLs, which live in
 *     `diff-requests.ts`.)
 */

import { asNumber, asString, isRecord } from "@/lib/lighthouse/parseLhr";
import {
  LIGHTHOUSE_CATEGORIES,
  type LighthouseCategory,
  type LighthouseResult,
} from "@/lib/lighthouse/types";
import {
  MAX_DIFF_DESCRIPTION,
  type AuditDelta,
  type DeltaBasis,
  type DeltaStatus,
  type OpportunityDelta,
} from "@/lib/reports/diff-types";

// --- LHR access helpers (pure, tolerant) ------------------------------------

/** The `audits` map, or an empty one when absent / not a map. */
function auditMap(lhr: LighthouseResult): Record<string, unknown> {
  return isRecord(lhr.audits) ? lhr.audits : {};
}

/** One audit result, or undefined when the map lacks a readable record for it. */
function readAudit(
  audits: Record<string, unknown>,
  id: string,
): Record<string, unknown> | undefined {
  const audit = audits[id];
  return isRecord(audit) ? audit : undefined;
}

/** A numeric field of an audit that may be absent entirely. */
function numberField(
  audit: Record<string, unknown> | undefined,
  key: string,
): number | null {
  return audit === undefined ? null : asNumber(audit[key]);
}

/** A string field of an audit that may be absent entirely; `""` when unreadable. */
function stringField(
  audit: Record<string, unknown> | undefined,
  key: string,
): string {
  return audit === undefined ? "" : (asString(audit[key]) ?? "");
}

/**
 * The comparison run's value for a shared label, falling back to the baseline's.
 *
 * Labels (title, description, unit, `scoreDisplayMode`) are one value shared by
 * both sides, and the LATER run wins: it was produced by the newer Lighthouse,
 * so its wording is the one the rest of the app is showing. The baseline is the
 * fallback that keeps a `removed` audit from losing its name.
 */
function preferredString(
  comparison: Record<string, unknown> | undefined,
  baseline: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = stringField(comparison, key);
  return value !== "" ? value : stringField(baseline, key);
}

/**
 * `comparison − baseline`, or `null` when either side has no number.
 *
 * The one arithmetic rule in the module, written once so it cannot drift: a
 * delta needs a measurement on BOTH sides. See rule 1 in the module note.
 */
function subtract(baseline: number | null, comparison: number | null): number | null {
  return baseline === null || comparison === null ? null : comparison - baseline;
}

/**
 * Cap a description at {@link MAX_DIFF_DESCRIPTION}, ellipsis included, so the
 * result is never longer than the constant says. 22 of the 155 audits in this
 * repo's stored reports carry a description over the cap, so this is a live path
 * rather than a defensive one.
 *
 * The surrogate check keeps a truncation from splitting an astral character into
 * a lone surrogate, which JSON-encodes to an escape that renders as U+FFFD.
 */
function truncate(value: string): string {
  if (value.length <= MAX_DIFF_DESCRIPTION) return value;
  let end = MAX_DIFF_DESCRIPTION - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

/**
 * Byte-stable id ordering. Deliberately not `localeCompare`: the output of these
 * differs is compared in tests and rendered into a table that must not reshuffle
 * between reads, and locale collation is neither of those things (the same
 * concern as the documented total order in `src/lib/alerts/compare.ts`).
 */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// --- Category join ----------------------------------------------------------

/** What the two reports' categories say about one audit, unioned. */
interface CategoryJoin {
  /** Categories naming this audit, in {@link LIGHTHOUSE_CATEGORIES} order. */
  categories: LighthouseCategory[];
  /** The largest weight any of them gives it. */
  weight: number;
}

/** One category's `auditRefs` array, or `[]` when the report has none readable. */
function categoryRefs(lhr: LighthouseResult, category: LighthouseCategory): unknown[] {
  const categories = isRecord(lhr.categories) ? lhr.categories : {};
  const entry = categories[category];
  if (!isRecord(entry) || !Array.isArray(entry.auditRefs)) return [];
  return entry.auditRefs;
}

/**
 * `audit id → categories + max weight`, joined from BOTH reports' `auditRefs`.
 *
 * Both sides are unioned because a category can add or drop an audit between
 * Lighthouse versions, and a `removed` audit would otherwise arrive with no
 * category at all. Weight is the MAX across every category naming it: an audit
 * scored by two categories has two weights (`document-title` and `image-alt` are
 * both in accessibility AND seo in this repo's reports), and the one that
 * matters for ranking is the largest score it can move.
 *
 * The category loop is OUTERMOST so each `categories` array comes out in
 * {@link LIGHTHOUSE_CATEGORIES} order with no second sort — the same trick
 * `watchedCategories` uses in `src/lib/alerts/compare.ts`, and the reason the
 * canonical list is imported rather than written out here (hard-coding the five
 * is what drifted when Lighthouse 13.3 added `agentic-browsing`).
 */
function joinCategories(
  baseline: LighthouseResult,
  comparison: LighthouseResult,
): Map<string, CategoryJoin> {
  const index = new Map<string, CategoryJoin>();

  for (const category of LIGHTHOUSE_CATEGORIES) {
    for (const lhr of [baseline, comparison]) {
      for (const rawRef of categoryRefs(lhr, category)) {
        if (!isRecord(rawRef)) continue;
        const id = asString(rawRef.id);
        if (id === undefined || id === "") continue;
        // Clamped at 0: `weight` is a ranking multiplier below, and a negative
        // one (which Lighthouse never emits) would invert the order.
        const weight = Math.max(asNumber(rawRef.weight) ?? 0, 0);

        const entry = index.get(id);
        if (entry === undefined) {
          index.set(id, { categories: [category], weight });
          continue;
        }
        if (!entry.categories.includes(category)) entry.categories.push(category);
        entry.weight = Math.max(entry.weight, weight);
      }
    }
  }

  return index;
}

// --- Classification ---------------------------------------------------------

/**
 * Decide how one audit moved, and which signal decided it.
 *
 * The order of the branches is the contract:
 *
 *  1. **Presence.** On one side only → `added`/`removed`. Nothing else is
 *     inspected: a newly-present audit has nothing to be compared against.
 *  2. **Score.** If EITHER side is scored, the score owns the classification —
 *     it is what actually moved the category number. When only one side is
 *     scored the delta is `null` and the answer is `unchanged` / `basis: "none"`,
 *     NOT a direction: an audit that went from unscored to 0.5 has not improved
 *     by 0.5, and treating the missing side as a zero is the mistake Phase C's
 *     alert core was built to avoid.
 *  3. **Numeric**, only when NEITHER side is scored. Scoreless-but-measured
 *     audits (informative diagnostics like `bootup-time` when a config leaves it
 *     unweighted) still carry a number worth diffing.
 *  4. Otherwise `unchanged` / `none`.
 *
 * LOWER IS BETTER in branch 3, verified rather than assumed: Lighthouse 13.4.1's
 * `numericUnit` union is exactly `'byte' | 'millisecond' | 'element' |
 * 'unitless'` (`types/audit.d.ts`), and every audit emitting one is a cost —
 * timings, transferred bytes, `dom-size-insight`'s element count, and CLS. There
 * is no higher-is-better numeric audit to handle; all four units in this repo's
 * stored reports are those.
 */
function classifyAudit(
  hasBaseline: boolean,
  hasComparison: boolean,
  baselineScore: number | null,
  comparisonScore: number | null,
  scoreDelta: number | null,
  numericDelta: number | null,
): { status: DeltaStatus; basis: DeltaBasis } {
  if (!hasBaseline) return { status: "added", basis: "presence" };
  if (!hasComparison) return { status: "removed", basis: "presence" };

  if (baselineScore !== null || comparisonScore !== null) {
    if (scoreDelta === null) return { status: "unchanged", basis: "none" };
    if (scoreDelta > 0) return { status: "improved", basis: "score" };
    if (scoreDelta < 0) return { status: "regressed", basis: "score" };
    return { status: "unchanged", basis: "score" };
  }

  if (numericDelta !== null) {
    if (numericDelta < 0) return { status: "improved", basis: "numeric" };
    if (numericDelta > 0) return { status: "regressed", basis: "numeric" };
    return { status: "unchanged", basis: "numeric" };
  }

  return { status: "unchanged", basis: "none" };
}

// --- Audits -----------------------------------------------------------------

/**
 * Classify every audit in either report, ordered by audit id.
 *
 * TOTAL over the union of ids: unchanged audits are included, because "reports
 * unchanged correctly" is the property that makes the moved ones believable (see
 * the module note). An id whose value is unreadable on BOTH sides is dropped —
 * there is nothing to classify — while an id readable on one side is `added` or
 * `removed`, which is the honest answer for an audit that errored into a string
 * in one run.
 *
 * Ordering here is by id rather than by impact: this is the raw, complete
 * projection, and it must be byte-stable regardless of the key order the two
 * JSON files happened to be written in. {@link rankAuditDeltas} is what turns it
 * into a worst-first list for the UI.
 */
export function diffAudits(
  baseline: LighthouseResult,
  comparison: LighthouseResult,
): AuditDelta[] {
  const baselineAudits = auditMap(baseline);
  const comparisonAudits = auditMap(comparison);
  const join = joinCategories(baseline, comparison);

  const ids = new Set<string>([
    ...Object.keys(baselineAudits),
    ...Object.keys(comparisonAudits),
  ]);

  const deltas: AuditDelta[] = [];

  for (const id of [...ids].sort(compareIds)) {
    const before = readAudit(baselineAudits, id);
    const after = readAudit(comparisonAudits, id);
    if (before === undefined && after === undefined) continue;

    const baselineScore = numberField(before, "score");
    const comparisonScore = numberField(after, "score");
    const scoreDelta = subtract(baselineScore, comparisonScore);

    const baselineNumericValue = numberField(before, "numericValue");
    const comparisonNumericValue = numberField(after, "numericValue");
    const numericDelta = subtract(baselineNumericValue, comparisonNumericValue);

    const { status, basis } = classifyAudit(
      before !== undefined,
      after !== undefined,
      baselineScore,
      comparisonScore,
      scoreDelta,
      numericDelta,
    );

    const { categories, weight } = join.get(id) ?? { categories: [], weight: 0 };

    deltas.push({
      id,
      // Falls back to the id, as `parseCategoryAudits` does: a row with no label
      // is worse than a row labelled with the audit's own name.
      title: preferredString(after, before, "title") || id,
      description: truncate(preferredString(after, before, "description")),
      categories,
      weight,
      baselineScore,
      comparisonScore,
      scoreDelta,
      baselineNumericValue,
      comparisonNumericValue,
      numericDelta,
      numericUnit: preferredString(after, before, "numericUnit"),
      baselineDisplayValue: stringField(before, "displayValue"),
      comparisonDisplayValue: stringField(after, "displayValue"),
      scoreDisplayMode: preferredString(after, before, "scoreDisplayMode"),
      status,
      basis,
    });
  }

  return deltas;
}

// --- Ranking ----------------------------------------------------------------

/**
 * Ranking tier — the coarse "what should a human read first" bucket.
 *
 * This card answers *"why did we drop 8 points"*, so what actually cost score
 * comes first and improvements come last:
 *
 *  0. score regressions — the only thing that can literally have moved a number;
 *  1. newly-present FAILING audits — the other way a category loses points, and
 *     invisible to a score delta because there is no baseline to subtract;
 *  2. numeric regressions — a scoreless measurement got worse (diagnostic);
 *  3. removed audits, then 4. newly-present passing/unscored ones — presence
 *     changes that are usually a Lighthouse version or applicability change
 *     rather than a page change;
 *  5. improvements; 6. unchanged (which the composer has already filtered, but
 *     this function is total over whatever it is handed).
 */
function auditTier(delta: AuditDelta): number {
  if (delta.status === "regressed" && delta.basis === "score") return 0;
  if (
    delta.status === "added" &&
    delta.comparisonScore !== null &&
    delta.comparisonScore < 1
  ) {
    return 1;
  }
  if (delta.status === "regressed") return 2;
  if (delta.status === "removed") return 3;
  if (delta.status === "added") return 4;
  if (delta.status === "improved") return 5;
  return 6;
}

/**
 * Within-tier magnitude: how much score this audit moved, or could move.
 *
 * Weighted, so a weight-10 audit losing its full point outranks a weight-1 audit
 * losing the same point — the weighting is the whole difference between "this is
 * why you dropped 8" and "this is a rounding error". An audit with no score
 * delta (a presence change) falls back to its weight, which is the most that can
 * be said about it.
 *
 * Deliberately NOT extended to `numericDelta`: numeric units are not comparable
 * across audits (a 200 ms regression and a 200-byte one are not the same size),
 * so tier 2 orders by weight and then by id rather than by a number that would
 * only look meaningful.
 */
function auditImpact(delta: AuditDelta): number {
  return delta.scoreDelta === null
    ? delta.weight
    : Math.abs(delta.scoreDelta) * delta.weight;
}

/**
 * Order audit deltas worst-first for display. Pure; returns a new array and
 * never mutates its input.
 *
 * The total order — fully specified because this list is rendered into a table
 * and fed to the AI prompt, and must not reshuffle between two reads of the same
 * pair of reports: tier (see {@link auditTier}), then weighted impact desc, then
 * raw score movement desc (which separates the weight-0 audits that all share an
 * impact of 0), then audit id ascending as the deterministic tie-break.
 */
export function rankAuditDeltas(deltas: AuditDelta[]): AuditDelta[] {
  return [...deltas].sort((a, b) => {
    const byTier = auditTier(a) - auditTier(b);
    if (byTier !== 0) return byTier;

    const byImpact = auditImpact(b) - auditImpact(a);
    if (byImpact !== 0) return byImpact;

    const byScore = Math.abs(b.scoreDelta ?? 0) - Math.abs(a.scoreDelta ?? 0);
    if (byScore !== 0) return byScore;

    return compareIds(a.id, b.id);
  });
}

// --- Opportunities ----------------------------------------------------------

/** One side's reading of an opportunity audit; mirrors `Opportunity`'s fields. */
interface OpportunitySide {
  title: string;
  description: string;
  savingsMs: number | null;
  displayValue: string;
  score: number | null;
}

/**
 * Every opportunity in one report, UNCAPPED and keyed by audit id.
 *
 * Same predicate as `parseOpportunities` (`details.type === "opportunity"` OR a
 * numeric `details.overallSavingsMs`) but deliberately without its
 * `MAX_OPPORTUNITIES` cap and without its sort. A cap applied before the join
 * would silently drop an opportunity that exists on ONE side only — which is
 * precisely the thing a diff exists to surface — and the cap that does apply to
 * the wire belongs to the composer, after ranking.
 */
function readOpportunities(lhr: LighthouseResult): Map<string, OpportunitySide> {
  const audits = auditMap(lhr);
  const found = new Map<string, OpportunitySide>();

  for (const [id, rawAudit] of Object.entries(audits)) {
    if (!isRecord(rawAudit)) continue;
    const details = isRecord(rawAudit.details) ? rawAudit.details : undefined;
    if (details === undefined) continue;

    const savingsMs = asNumber(details.overallSavingsMs);
    if (asString(details.type) !== "opportunity" && savingsMs === null) continue;

    found.set(id, {
      title: asString(rawAudit.title) ?? id,
      description: asString(rawAudit.description) ?? "",
      savingsMs,
      displayValue: asString(rawAudit.displayValue) ?? "",
      score: asNumber(rawAudit.score),
    });
  }

  return found;
}

/**
 * The savings change this entry represents, in milliseconds — the sort key.
 *
 * A one-sided opportunity has a `null` `savingsDeltaMs` by contract (a delta
 * needs both sides), but it is not orderless: an opportunity that only the
 * comparison run reports is entirely new waste, and one only the baseline
 * reported is waste that went away. Ranking on that keeps a brand-new 900 ms
 * opportunity at the top where it belongs instead of sorting it as a zero.
 */
function savingsRank(delta: OpportunityDelta): number {
  if (delta.savingsDeltaMs !== null) return delta.savingsDeltaMs;
  if (delta.status === "added") return delta.comparisonSavingsMs ?? 0;
  if (delta.status === "removed") return -(delta.baselineSavingsMs ?? 0);
  return 0;
}

/**
 * Diff the two reports' performance opportunities, biggest regression first.
 *
 * Classified on SAVINGS, not score: an opportunity's point is the milliseconds
 * it is costing, and many are scored `null` in a run that otherwise passes. A
 * POSITIVE `savingsDeltaMs` means the comparison run wastes more — a regression.
 *
 * Total, like {@link diffAudits}: unchanged opportunities are returned and the
 * composer filters them.
 */
export function diffOpportunities(
  baseline: LighthouseResult,
  comparison: LighthouseResult,
): OpportunityDelta[] {
  const before = readOpportunities(baseline);
  const after = readOpportunities(comparison);

  const ids = new Set<string>([...before.keys(), ...after.keys()]);
  const deltas: OpportunityDelta[] = [];

  for (const id of ids) {
    const baselineSide = before.get(id);
    const comparisonSide = after.get(id);

    const baselineSavingsMs = baselineSide?.savingsMs ?? null;
    const comparisonSavingsMs = comparisonSide?.savingsMs ?? null;
    const savingsDeltaMs = subtract(baselineSavingsMs, comparisonSavingsMs);

    let status: DeltaStatus;
    if (baselineSide === undefined) status = "added";
    else if (comparisonSide === undefined) status = "removed";
    else if (savingsDeltaMs === null) status = "unchanged";
    else if (savingsDeltaMs > 0) status = "regressed";
    else if (savingsDeltaMs < 0) status = "improved";
    else status = "unchanged";

    const labelled = comparisonSide ?? baselineSide;

    deltas.push({
      id,
      title: labelled?.title || id,
      description: truncate(labelled?.description ?? ""),
      baselineSavingsMs,
      comparisonSavingsMs,
      savingsDeltaMs,
      baselineDisplayValue: baselineSide?.displayValue ?? "",
      comparisonDisplayValue: comparisonSide?.displayValue ?? "",
      baselineScore: baselineSide?.score ?? null,
      comparisonScore: comparisonSide?.score ?? null,
      status,
    });
  }

  return deltas.sort((a, b) => {
    const bySavings = savingsRank(b) - savingsRank(a);
    return bySavings !== 0 ? bySavings : compareIds(a.id, b.id);
  });
}
