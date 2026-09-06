/**
 * Request-level run diff (ROADMAP Phase E).
 *
 * The third of the three pure differs the composer (`@/lib/reports/report-diff`)
 * joins: which individual REQUESTS a page gained, lost or grew between two
 * stored reports — the layer that turns "we dropped 8 points" into "340 KB of
 * new script arrived from a host that was not here yesterday".
 *
 * Built ON Phase D's reader rather than beside it. `extractWaterfall` already
 * knows the three things this diff would otherwise have to relearn, each of them
 * discovered the expensive way: that `-1` is Chrome's "unknown" sentinel and not
 * a byte count (summing it lands one byte below Lighthouse's own total — a wrong
 * number that looks plausible), that third-party marking joins `lhr.entities` on
 * the RAW entity name, and that Lighthouse 13 renamed the render-blocking audit.
 * Re-deriving any of that here would be a regression the moment the two copies
 * drifted, so this module only reshapes what that reader returns.
 *
 * PURE, like every other module in this directory except `loadReport.ts`: no
 * `node:fs`, no DB, no `lighthouse` import, no React. The route reads both
 * report files; this only compares them.
 *
 * Three properties are worth stating up front, because each is a decision rather
 * than a detail:
 *
 *  1. **Keyed by full URL, and COUNTED.** A page can request the same URL more
 *     than once — 20 of this repo's 224 stored reports do, one of them fetching
 *     the same font three times. Each side therefore contributes an occurrence
 *     count and a SUMMED transfer size, so "the page now fetches this twice"
 *     stays visible instead of collapsing into a size change.
 *  2. **`unavailable` propagates.** A diff where one side predates the
 *     `network-requests` audit is not a diff in which every request vanished.
 *     Either side unavailable yields empty lists and zeroed totals — never a
 *     fabricated wholesale add or remove.
 *  3. **A missing byte count is silence, not zero** (ROADMAP Phase C's standing
 *     rule). `transferDelta` is `null` whenever either side recorded no size;
 *     such a request is classified on its occurrence count instead, and never
 *     against an implied 0.
 *
 * SECURITY NOTE, inherited unchanged from Phase D: every `url`/`path`/`host` and
 * every `resourceType` here is page-authored, and all of them are copied verbatim
 * from the reader's rows.
 *
 * Be precise about what that means, because the obvious reading is wrong and a
 * later author will act on it. `path`, `host`, `resourceType` and `mimeType` have
 * been through the reader's `displaySafe` (control and bidi strip) — see
 * `extract.ts` — but **`url` has NOT**: `extractWaterfall` stores it raw on
 * purpose, because it is the join key for the render-blocking match and the
 * entity table, and normalising one side of a join and not the other silently
 * unmatches entries. It is the aggregation key here for the same reason. So
 * `ResourceDelta.url` is the rawest string in this contract, and a consumer that
 * DISPLAYS it owes it the same treatment the reader gives the display fields —
 * do not assume it arrives clean. Every consumer must render these as text, never
 * as markup, clamp the length, and route any href through `safeHttpHref`; the AI
 * prompt path flattens `url` through `sanitizeUntrusted` for exactly this reason.
 */

import type { LighthouseResult } from "@/lib/lighthouse/types";
import {
  MAX_DIFF_URL,
  type DeltaStatus,
  type ResourceDelta,
  type ResourceDiff,
} from "@/lib/reports/diff-types";
import { extractWaterfall } from "@/lib/reports/extract";
import type { WaterfallData } from "@/lib/reports/types";

/** One URL's rows collapsed into the per-side half of a {@link ResourceDelta}. */
interface UrlAggregate {
  url: string;
  path: string;
  host: string;
  resourceType: string;
  /** True when ANY occurrence on this side was marked third-party. */
  thirdParty: boolean;
  /** How many times this side requested the URL. Always ≥ 1. */
  count: number;
  /**
   * Bytes summed across the occurrences that recorded one, or `null` when NONE
   * of them did. Mixing the two would be the sentinel trap again at a different
   * altitude: a URL fetched twice, once measured and once not, honestly weighs
   * "at least the measured half", which is what summing the known rows says.
   */
  transferSize: number | null;
}

/**
 * Collapse one side's waterfall rows into one aggregate per URL, in the LHR's
 * own first-seen order (the sorts below impose the real ordering; this only has
 * to be stable).
 */
function aggregateByUrl(data: WaterfallData): Map<string, UrlAggregate> {
  const byUrl = new Map<string, UrlAggregate>();

  for (const request of data.requests) {
    const existing = byUrl.get(request.url);
    if (existing === undefined) {
      byUrl.set(request.url, {
        url: request.url,
        path: request.path,
        host: request.host,
        resourceType: request.resourceType,
        thirdParty: request.thirdParty,
        count: 1,
        transferSize: request.transferSize,
      });
      continue;
    }

    existing.count += 1;
    if (request.transferSize !== null) {
      existing.transferSize = (existing.transferSize ?? 0) + request.transferSize;
    }
    // The first occurrence that carries a type names the resource; Lighthouse
    // omits it on some rows (redirects, unfinished requests) and an empty label
    // must not win over a real one just for arriving first.
    if (existing.resourceType === "") existing.resourceType = request.resourceType;
    if (request.thirdParty) existing.thirdParty = true;
  }

  return byUrl;
}

/**
 * How a URL present on BOTH sides moved.
 *
 * Bytes decide when we have both counts and they differ; otherwise the
 * occurrence count decides, which covers the two cases the contract calls out —
 * identical bytes with a moved count, and an unmeasurable side. When neither
 * signal moved the answer is `unchanged` in the precise sense
 * {@link DeltaStatus} gives it: nothing WE CAN MEASURE moved.
 */
function classifyChange(
  baselineCount: number,
  comparisonCount: number,
  transferDelta: number | null,
): DeltaStatus {
  if (transferDelta !== null && transferDelta !== 0) {
    return transferDelta > 0 ? "regressed" : "improved";
  }
  if (comparisonCount !== baselineCount) {
    return comparisonCount > baselineCount ? "regressed" : "improved";
  }
  return "unchanged";
}

/** A delta for a URL only one side requested. */
/**
 * Cap a page-authored URL string at {@link MAX_DIFF_URL}.
 *
 * Applied to `url`, `path` and `host` as they cross into the wire contract —
 * the one place all three are written — so no consumer has to remember. Ellipsis
 * included in the budget, so the result is never longer than the constant says.
 *
 * Note this deliberately clamps `url` too, even though `url` is the aggregation
 * KEY: the key is used before this point (the maps are built from the reader's
 * raw rows), so truncating here cannot unmatch anything. Two distinct URLs that
 * agree for their first 2048 characters would collapse only in what is
 * DISPLAYED, never in what was counted.
 */
function clampUrl(value: string): string {
  if (value.length <= MAX_DIFF_URL) return value;
  let end = MAX_DIFF_URL - 1;
  // Never split an astral character into a lone surrogate — it JSON-encodes to
  // an escape that renders as U+FFFD.
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function presenceDelta(
  side: UrlAggregate,
  status: "added" | "removed",
): ResourceDelta {
  const present = status === "added";
  return {
    url: clampUrl(side.url),
    path: clampUrl(side.path),
    host: clampUrl(side.host),
    resourceType: side.resourceType,
    thirdParty: side.thirdParty,
    baselineCount: present ? 0 : side.count,
    comparisonCount: present ? side.count : 0,
    baselineTransferSize: present ? null : side.transferSize,
    comparisonTransferSize: present ? side.transferSize : null,
    // Always null, and deliberately: the absent side recorded no bytes, and
    // "this request weighs 340 KB more than the zero bytes it did not weigh" is
    // the fabricated number rule 3 exists to prevent. The added/removed sorts
    // rank on the side that HAS a size instead.
    transferDelta: null,
    status,
  };
}

/** A delta for a URL both sides requested. */
function bothSidesDelta(
  baseline: UrlAggregate,
  comparison: UrlAggregate,
): ResourceDelta {
  const transferDelta =
    baseline.transferSize === null || comparison.transferSize === null
      ? null
      : comparison.transferSize - baseline.transferSize;

  return {
    url: clampUrl(comparison.url),
    // The comparison side is preferred for every display field: a diff is read
    // as "what the page looks like NOW, and how it got here". `path`/`host` are
    // pure functions of the shared URL and so identical either way; only
    // `resourceType` can genuinely differ, and then the newer label is right.
    path: clampUrl(comparison.path),
    host: clampUrl(comparison.host),
    resourceType:
      comparison.resourceType === "" ? baseline.resourceType : comparison.resourceType,
    thirdParty: baseline.thirdParty || comparison.thirdParty,
    baselineCount: baseline.count,
    comparisonCount: comparison.count,
    baselineTransferSize: baseline.transferSize,
    comparisonTransferSize: comparison.transferSize,
    transferDelta,
    status: classifyChange(baseline.count, comparison.count, transferDelta),
  };
}

/**
 * Codepoint order, deliberately not `localeCompare`: every sort below needs a
 * tie-break that cannot shift with the host's ICU data, because these lists are
 * rendered into a diff view that must not reshuffle between two reads of the
 * same pair of runs (the ordering discipline `@/lib/alerts/compare` states for
 * alert lines).
 */
function byUrlAsc(a: ResourceDelta, b: ResourceDelta): number {
  if (a.url === b.url) return 0;
  return a.url < b.url ? -1 : 1;
}

/** Sort rank for a possibly-unrecorded size. Sizes are ≥ 0, so `null` sorts last. */
function sizeRank(size: number | null): number {
  return size ?? -1;
}

/** Largest transfer first, on whichever side actually has one. */
function bySizeDesc(
  pick: (delta: ResourceDelta) => number | null,
): (a: ResourceDelta, b: ResourceDelta) => number {
  return (a, b) => {
    const difference = sizeRank(pick(b)) - sizeRank(pick(a));
    return difference !== 0 ? difference : byUrlAsc(a, b);
  };
}

/**
 * Largest GROWTH first — this list answers "why did we get slower", so the
 * biggest regression has to be the first row, and the cap in `diff-types.ts`
 * slices from this end.
 *
 * A measured delta always outranks an unmeasured one. A row whose bytes are
 * unknown moved on its occurrence count alone; letting it displace a measured
 * 340 KB regression under the cap would hide the quantified finding behind an
 * unquantifiable one.
 */
function byGrowthDesc(a: ResourceDelta, b: ResourceDelta): number {
  if (a.transferDelta !== null && b.transferDelta !== null) {
    if (a.transferDelta !== b.transferDelta) return b.transferDelta - a.transferDelta;
  } else if (a.transferDelta !== null) {
    return -1;
  } else if (b.transferDelta !== null) {
    return 1;
  }
  const aCount = a.comparisonCount - a.baselineCount;
  const bCount = b.comparisonCount - b.baselineCount;
  return aCount !== bCount ? bCount - aCount : byUrlAsc(a, b);
}

/**
 * The honest empty result: one side carried no usable `network-requests` audit,
 * so there is no comparison to report. Zeroed rather than half-populated — a
 * total taken from the one readable side would be read as "the other run made
 * no requests", which is the exact claim `unavailable` exists to refuse.
 */
function unavailableDiff(): ResourceDiff {
  return {
    added: [],
    removed: [],
    changed: [],
    unchangedCount: 0,
    baselineRequestCount: 0,
    comparisonRequestCount: 0,
    requestCountDelta: 0,
    baselineTransferSize: 0,
    comparisonTransferSize: 0,
    transferSizeDelta: 0,
    baselineThirdPartyCount: 0,
    comparisonThirdPartyCount: 0,
    unavailable: true,
  };
}

/**
 * Diff the two runs' request waterfalls.
 *
 * Totals are taken straight from {@link WaterfallData} rather than re-summed
 * from the aggregates, so they reconcile exactly with what the Trace tab shows
 * for each run on its own — the same numbers, read once.
 *
 * Note that `unchangedCount` counts URL KEYS, like the three lists it sits
 * beside: `added + removed + changed + unchangedCount` is the size of the URL
 * union across both runs, while `baselineRequestCount`/`comparisonRequestCount`
 * count REQUESTS. The two differ exactly where a page fetched one URL twice.
 */
export function diffRequests(
  baseline: LighthouseResult,
  comparison: LighthouseResult,
): ResourceDiff {
  const baselineWaterfall = extractWaterfall(baseline);
  const comparisonWaterfall = extractWaterfall(comparison);

  if (baselineWaterfall.unavailable || comparisonWaterfall.unavailable) {
    return unavailableDiff();
  }

  const baselineByUrl = aggregateByUrl(baselineWaterfall);
  const comparisonByUrl = aggregateByUrl(comparisonWaterfall);

  const added: ResourceDelta[] = [];
  const removed: ResourceDelta[] = [];
  const changed: ResourceDelta[] = [];
  let unchangedCount = 0;

  for (const [url, comparisonSide] of comparisonByUrl) {
    const baselineSide = baselineByUrl.get(url);
    if (baselineSide === undefined) {
      added.push(presenceDelta(comparisonSide, "added"));
      continue;
    }
    const delta = bothSidesDelta(baselineSide, comparisonSide);
    if (delta.status === "unchanged") unchangedCount += 1;
    else changed.push(delta);
  }

  for (const [url, baselineSide] of baselineByUrl) {
    if (!comparisonByUrl.has(url)) removed.push(presenceDelta(baselineSide, "removed"));
  }

  added.sort(bySizeDesc((delta) => delta.comparisonTransferSize));
  removed.sort(bySizeDesc((delta) => delta.baselineTransferSize));
  changed.sort(byGrowthDesc);

  return {
    added,
    removed,
    changed,
    unchangedCount,
    baselineRequestCount: baselineWaterfall.requests.length,
    comparisonRequestCount: comparisonWaterfall.requests.length,
    requestCountDelta:
      comparisonWaterfall.requests.length - baselineWaterfall.requests.length,
    baselineTransferSize: baselineWaterfall.totalTransferSize,
    comparisonTransferSize: comparisonWaterfall.totalTransferSize,
    transferSizeDelta:
      comparisonWaterfall.totalTransferSize - baselineWaterfall.totalTransferSize,
    baselineThirdPartyCount: baselineWaterfall.thirdPartyCount,
    comparisonThirdPartyCount: comparisonWaterfall.thirdPartyCount,
    unavailable: false,
  };
}
