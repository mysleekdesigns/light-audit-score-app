/**
 * Lineage → Compare resolution (ROADMAP Phase E).
 *
 * Two pure hops, both of which used to be tempting to inline into a component
 * and both of which are the part that can actually be wrong:
 *
 *  1. **A re-run batch → one comparable pair of RUNS.** The lineage chip on a
 *     batch card knows only `priorBatchId`. Turning that into "diff *this* run
 *     against *that* run" means matching each page across the two batches on
 *     `(url, formFactor)` — a `"both"` batch audits every URL twice, and diffing
 *     a mobile run against a desktop one would report the emulation as a page
 *     change. See {@link resolveRerunComparisons}.
 *  2. **A `/compare` deep link → a selection.** The link the chip produces
 *     carries run ids that may no longer exist (the archive can be cleared, a
 *     run deleted), so resolving it has to degrade to the page's own defaults
 *     rather than leave a picker pointing at nothing. See
 *     {@link resolveCompareSelection}.
 *
 * Both are total: every input, including empty batches, failed runs and stale
 * ids, produces something renderable. Neither throws and neither reads the DB.
 *
 * SECURITY: `HistoryRow.url` is the URL the *user* asked to audit, not one the
 * audited page chose, so it is not attacker-controlled the way a subresource
 * URL is. It is still only ever rendered as text and encoded into a query
 * string here — never built into markup.
 */

import type { UrlGroup } from "@/lib/compare/diff";
import type { HistoryRow } from "@/lib/db/persistence";
import { LIGHTHOUSE_CATEGORIES, type FormFactor } from "@/lib/lighthouse/types";
import { pairByDevice } from "@/lib/pairing/devicePairs";

/* -------------------------------------------------------------------------- */
/* Re-run lineage → a comparable pair                                          */
/* -------------------------------------------------------------------------- */

/** One page of a re-run that can be diffed against its counterpart in the prior batch. */
export interface RerunComparison {
  /** The requested URL both runs share. */
  url: string;
  /** The device both runs share — never crossed (see the module note). */
  formFactor: FormFactor;
  /** The prior batch's run: the diff's baseline. */
  baselineRunId: string;
  /** This batch's run: the diff's comparison. */
  comparisonRunId: string;
  /**
   * Category-score points lost between the two runs (baseline − comparison,
   * summed over the categories BOTH runs scored). Positive means the re-run
   * came out worse. `null` when the two runs share no scored category, which
   * makes the pair unrankable rather than unremarkable.
   */
  pointsLost: number | null;
}

/**
 * Whether a row can be one side of an audit-level diff.
 *
 * `status === "done"` is the usual comparability rule (a failed run carries no
 * scores). `hasJsonReport` is the stricter one this feature adds: the differ
 * reads two stored LHRs, so a run whose JSON report was never written — an
 * export-disabled run, or one whose file has since been removed — cannot be
 * diffed at all. Filtering here is what lets the chip's link be absent rather
 * than land on a diff that will only fail once the user opens it.
 */
export function isDiffable(row: HistoryRow): boolean {
  return row.status === "done" && row.hasJsonReport;
}

/** Mobile before desktop, so a `"both"` batch's default landing is deterministic. */
const DEVICE_ORDER: readonly FormFactor[] = ["mobile", "desktop"];

/**
 * Every page of `currentRows` that has a diffable counterpart in `priorRows`,
 * ranked by {@link RerunComparison.pointsLost} descending — the page that gave
 * up the most score first, which is the one a user clicking "what changed" is
 * asking about.
 *
 * Pairing goes through {@link pairByDevice} rather than a hand-rolled key so the
 * mobile/desktop split follows the same first-wins, insertion-ordered rule every
 * other paired surface uses. Unrankable pairs (no category scored on both sides)
 * sort last: they are still offerable, they just carry no evidence of a
 * regression to rank on.
 *
 * Returns `[]` when nothing matches — no diffable run in one batch, no shared
 * URL, or a re-run that changed device — which is the signal the caller renders
 * as "no link", never as a broken one.
 */
export function resolveRerunComparisons(
  currentRows: readonly HistoryRow[],
  priorRows: readonly HistoryRow[],
): RerunComparison[] {
  const current = currentRows.filter(isDiffable);
  const prior = priorRows.filter(isDiffable);
  if (current.length === 0 || prior.length === 0) return [];

  const url = (row: HistoryRow) => row.url;
  const device = (row: HistoryRow) => row.formFactor;

  const priorByUrl = new Map(
    pairByDevice(prior, url, device).map((pair) => [pair.url, pair]),
  );

  const matches: RerunComparison[] = [];
  for (const pair of pairByDevice(current, url, device)) {
    const priorPair = priorByUrl.get(pair.url);
    if (!priorPair) continue;
    for (const formFactor of DEVICE_ORDER) {
      const comparison = pair[formFactor];
      const baseline = priorPair[formFactor];
      if (!comparison || !baseline) continue;
      matches.push({
        url: pair.url,
        formFactor,
        baselineRunId: baseline.id,
        comparisonRunId: comparison.id,
        pointsLost: scorePointsLost(baseline, comparison),
      });
    }
  }

  return matches.toSorted(byPointsLostDesc);
}

/**
 * The single pair a "what changed" affordance should link to, or `null` when the
 * re-run has none. Just the head of {@link resolveRerunComparisons} — named so
 * callers read as the question they are asking.
 */
export function pickRerunComparison(
  currentRows: readonly HistoryRow[],
  priorRows: readonly HistoryRow[],
): RerunComparison | null {
  return resolveRerunComparisons(currentRows, priorRows)[0] ?? null;
}

/** Sum of `baseline − comparison` over categories both runs scored; `null` when none. */
function scorePointsLost(baseline: HistoryRow, comparison: HistoryRow): number | null {
  let total = 0;
  let scored = 0;
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const before = baseline.scores[category];
    const after = comparison.scores[category];
    if (typeof before !== "number" || typeof after !== "number") continue;
    total += before - after;
    scored += 1;
  }
  return scored === 0 ? null : total;
}

/** Biggest regression first; unrankable pairs last; then url, then device. */
function byPointsLostDesc(a: RerunComparison, b: RerunComparison): number {
  if (a.pointsLost !== b.pointsLost) {
    if (a.pointsLost === null) return 1;
    if (b.pointsLost === null) return -1;
    return b.pointsLost - a.pointsLost;
  }
  return (
    a.url.localeCompare(b.url) ||
    DEVICE_ORDER.indexOf(a.formFactor) - DEVICE_ORDER.indexOf(b.formFactor)
  );
}

/* -------------------------------------------------------------------------- */
/* The /compare deep link                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The `/compare` URL that lands on one pair with the What Changed card already
 * open.
 *
 * `changed=1` is deliberately part of the LINK and not the page's default: the
 * card reads two stored reports (~1.4 MB server-side) and must stay closed —
 * and silent — on a plain `/compare` visit. Arriving through an affordance
 * labelled "what changed" *is* the user asking, so that one route opens it.
 */
export function compareHref(
  target: Pick<RerunComparison, "url" | "baselineRunId" | "comparisonRunId">,
): string {
  const params = new URLSearchParams({
    url: target.url,
    baseline: target.baselineRunId,
    comparison: target.comparisonRunId,
    changed: "1",
  });
  return `/compare?${params.toString()}`;
}

/** The `/compare` query, as Next hands it over (a repeated key arrives as an array). */
export interface CompareSelectionParams {
  url?: string | string[];
  baseline?: string | string[];
  comparison?: string | string[];
  changed?: string | string[];
}

/** Which URL group and pair of runs `/compare` should open on. */
export interface CompareSelection {
  url: string;
  baselineRunId: string;
  comparisonRunId: string;
  /**
   * Whether the What Changed card starts open. True only for a link that
   * asked for it AND resolved to two real, different runs — a stale link falls
   * back to the page's defaults with the card shut, rather than opening it on a
   * pair the user never chose.
   */
  showChanged: boolean;
}

/** First value of a possibly-repeated query parameter, trimmed; `""` when absent. */
function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return (value ?? "").trim();
}

/** The affirmative spellings `changed` accepts. Anything else leaves the card shut. */
const AFFIRMATIVE = new Set(["1", "true", "yes"]);

/**
 * Resolve a `/compare` query against the groups the page actually has.
 *
 * Every part degrades independently, and to the same defaults the console picks
 * unaided: an unknown URL falls back to the most-audited group, an unknown run
 * id to that group's oldest (baseline) or newest (comparison) run. Returns
 * `null` only when there is nothing to select at all.
 */
export function resolveCompareSelection(
  groups: readonly UrlGroup[],
  params: CompareSelectionParams = {},
): CompareSelection | null {
  if (groups.length === 0) return null;

  const wantedUrl = firstParam(params.url);
  const group = groups.find((g) => g.url === wantedUrl) ?? groups[0];
  const runs = group.runs; // ascending by time

  const wantedBaseline = firstParam(params.baseline);
  const wantedComparison = firstParam(params.comparison);
  const baseline = runs.find((run) => run.id === wantedBaseline);
  const comparison = runs.find((run) => run.id === wantedComparison);

  const baselineRunId = baseline?.id ?? runs[0].id;
  const comparisonRunId = comparison?.id ?? runs[runs.length - 1].id;

  const showChanged =
    AFFIRMATIVE.has(firstParam(params.changed).toLowerCase()) &&
    baseline !== undefined &&
    comparison !== undefined &&
    baseline.id !== comparison.id;

  return { url: group.url, baselineRunId, comparisonRunId, showChanged };
}
