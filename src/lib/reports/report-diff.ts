/**
 * The run-diff composer (ROADMAP Phase E).
 *
 * Joins the three pure differs — audits, opportunities and requests — into the
 * single {@link RunDiff} that `GET /api/reports/:runId/diff` serves, and owns
 * the two jobs none of them should: FILTERING to what actually moved, and
 * CAPPING the result.
 *
 * Splitting it this way is deliberate. Each differ is total and complete over
 * its own domain — `diffAudits` classifies every audit in either report,
 * including the ~170 per run that did nothing — because a differ that
 * pre-filtered could not be unit-tested for "correctly reports unchanged". The
 * wire payload wants the opposite: only the movement, bounded. So the
 * completeness lives in the differs and the editorial decisions live here, in
 * one place, where they can be read against the caps in `diff-types.ts`.
 *
 * PURE, like the Phase D extractors it sits beside: no `node:fs`, no DB, no
 * `lighthouse` import. The route reads both report files; this only reshapes
 * them.
 */

import { diffAudits, diffOpportunities, rankAuditDeltas } from "@/lib/reports/diff-audits";
import { diffRequests } from "@/lib/reports/diff-requests";
import {
  MAX_AUDIT_DELTAS,
  MAX_OPPORTUNITY_DELTAS,
  MAX_RESOURCE_DELTAS,
  type RunDiff,
  type RunDiffSide,
} from "@/lib/reports/diff-types";
import { asString, isRecord, pickString } from "@/lib/lighthouse/parseLhr";
import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
  type LighthouseCategory,
  type LighthouseResult,
} from "@/lib/lighthouse/types";

/**
 * Category scores as 0–100 integers, keyed by category id.
 *
 * A local reader rather than `parseLhr(...)`.scores: `parseLhr` also walks every
 * audit to build opportunities and the Best-Practices breakdown, which is real
 * work on a ~690 KB report and all of it discarded here — and this route already
 * parses two reports per request.
 */
function readScores(lhr: LighthouseResult): CategoryScores {
  const categories = isRecord(lhr.categories) ? lhr.categories : {};
  const scores: CategoryScores = {};
  for (const id of LIGHTHOUSE_CATEGORIES) {
    const category = categories[id];
    if (!isRecord(category)) continue;
    const raw = category.score;
    scores[id as LighthouseCategory] =
      typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw * 100) : null;
  }
  return scores;
}

/** Identity + headline numbers for one side of the diff. */
function describeSide(lhr: LighthouseResult, runId: string): RunDiffSide {
  return {
    runId,
    finalUrl: pickString(lhr, "finalDisplayedUrl", "finalUrl") ?? "",
    fetchTime: asString(lhr.fetchTime) ?? "",
    lighthouseVersion: asString(lhr.lighthouseVersion) ?? "",
    scores: readScores(lhr),
  };
}

/**
 * Diff two stored reports into the wire contract.
 *
 * @param args.baseline   The earlier / reference run and its id.
 * @param args.comparison The later / subject run and its id.
 */
export function extractRunDiff(args: {
  baseline: { lhr: LighthouseResult; runId: string };
  comparison: { lhr: LighthouseResult; runId: string };
}): RunDiff {
  const { baseline, comparison } = args;

  const allAudits = diffAudits(baseline.lhr, comparison.lhr);
  // `unchanged` is the whole point of the split described above: the differ
  // reports it, the wire does not carry it.
  const movedAudits = allAudits.filter((audit) => audit.status !== "unchanged");
  const rankedAudits = rankAuditDeltas(movedAudits);

  const allOpportunities = diffOpportunities(baseline.lhr, comparison.lhr);
  const movedOpportunities = allOpportunities.filter(
    (opportunity) => opportunity.status !== "unchanged",
  );

  const resources = diffRequests(baseline.lhr, comparison.lhr);

  const baselineSide = describeSide(baseline.lhr, baseline.runId);
  const comparisonSide = describeSide(comparison.lhr, comparison.runId);

  return {
    baseline: baselineSide,
    comparison: comparisonSide,
    audits: rankedAudits.slice(0, MAX_AUDIT_DELTAS),
    opportunities: movedOpportunities.slice(0, MAX_OPPORTUNITY_DELTAS),
    resources: {
      ...resources,
      added: resources.added.slice(0, MAX_RESOURCE_DELTAS),
      removed: resources.removed.slice(0, MAX_RESOURCE_DELTAS),
      changed: resources.changed.slice(0, MAX_RESOURCE_DELTAS),
    },
    unchangedAuditCount: allAudits.length - movedAudits.length,
    totals: {
      audits: movedAudits.length,
      opportunities: movedOpportunities.length,
      resourcesAdded: resources.added.length,
      resourcesRemoved: resources.removed.length,
      resourcesChanged: resources.changed.length,
    },
    // Compared only when BOTH sides recorded one: an absent final URL is a
    // report we could not read, not evidence that the page moved.
    urlMismatch:
      baselineSide.finalUrl !== "" &&
      comparisonSide.finalUrl !== "" &&
      baselineSide.finalUrl !== comparisonSide.finalUrl,
  };
}
