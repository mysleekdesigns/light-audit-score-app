/**
 * Audit-level run-diff contract (ROADMAP Phase E).
 *
 * Compare already diffs category scores and Core Web Vitals. This is the layer
 * underneath: *which individual audits, opportunities and requests* moved
 * between two stored reports — the data that turns "we dropped 8 points" into
 * "`unused-javascript` regressed and 340 KB of new script arrived".
 *
 * Like Phase D's {@link RunTrace}, this is a COMPACT PROJECTION that crosses the
 * wire, not the reports themselves. A diff reads TWO stored LHRs (~690 KB each
 * here, up to 1.5 MB), so the browser must never see either: the differs run
 * server-side behind `GET /api/reports/:runId/diff?baseline=<id>` and only the
 * shapes below are serialized.
 *
 * Three rules the whole contract is built on, each learned the expensive way in
 * an earlier phase:
 *
 *  1. **Honest degradation** (Phase D). A report that predates an audit yields
 *     an empty/`unavailable` result, never a throw and never an invented zero.
 *  2. **A missing value is silence, not zero** (Phase C's alert core). An audit
 *     absent from one side is `added`/`removed` — it is never diffed against an
 *     implied 0, because a failed or partial run would otherwise "regress"
 *     every audit it did not carry.
 *  3. **Bounded output.** Every list here is capped (see the `MAX_*` constants)
 *     and the pre-cap totals are reported alongside, so the UI can say "showing
 *     40 of 112" rather than silently truncating.
 *
 * SECURITY NOTE for consumers: `finalUrl` and every `ResourceDelta.url`/`path`/
 * `host` are attacker-controlled — they come from the page under audit, which
 * chose its own subresource URLs. Render them as text, never as markup, and
 * route any href through `safeHttpHref` (`@/lib/redactUrl`). Audit `title`/
 * `description` are Lighthouse's own text and are not page-authored.
 */

import type { CategoryScores, LighthouseCategory } from "@/lib/lighthouse/types";

/**
 * How one thing moved between the two runs.
 *
 *  - `regressed` / `improved` — present on both sides, and it got worse/better.
 *  - `unchanged`  — present on both sides, and nothing we can measure moved.
 *  - `added`      — present only in the COMPARISON run (the plan's
 *    "newly-present"): a new audit, opportunity or request.
 *  - `removed`    — present only in the BASELINE run (the plan's "disappeared").
 *
 * `added`/`removed` are deliberately NOT signed as good or bad. A newly-present
 * failing audit is a regression while a newly-present passing one is not, and a
 * disappeared audit usually means Lighthouse marked it not-applicable rather
 * than that the page improved. The score fields carry enough for a caller to
 * decide; the status only says which side it was on.
 */
export type DeltaStatus =
  | "regressed"
  | "improved"
  | "unchanged"
  | "added"
  | "removed";

/**
 * Which signal decided an {@link AuditDelta}'s status.
 *
 * Recorded rather than inferred because the two signals are not equally strong:
 * a `score` classification is what actually moved the category number, while a
 * `numeric` one is a scoreless audit whose measurement moved (informative
 * diagnostics like `total-byte-weight`), which is diagnostic colour, not a
 * scoring event. A UI that ranks by impact must be able to tell them apart, and
 * so must the AI prompt.
 */
export type DeltaBasis = "score" | "numeric" | "presence" | "none";

/** One audit's baseline → comparison delta. */
export interface AuditDelta {
  /** Lighthouse audit id (`unused-javascript`). */
  id: string;
  /** Lighthouse's own title. Not page-authored. */
  title: string;
  /** Lighthouse's own description, truncated by the differ. Not page-authored. */
  description: string;
  /**
   * Categories whose `auditRefs` name this audit, on EITHER side, in
   * {@link LIGHTHOUSE_CATEGORIES} order. Empty for an audit no category scores
   * (Lighthouse runs a number of those, and they still carry useful numbers).
   */
  categories: LighthouseCategory[];
  /**
   * The largest scoring weight this audit carries in any category naming it,
   * on either side. `0` means it cannot move a score — informative audits, and
   * every audit in a category's `hidden` group.
   */
  weight: number;
  /** 0–1 audit score in the baseline run; `null` when unscored or absent. */
  baselineScore: number | null;
  /** 0–1 audit score in the comparison run; `null` when unscored or absent. */
  comparisonScore: number | null;
  /** `comparisonScore − baselineScore` on the 0–1 scale; `null` when either is missing. */
  scoreDelta: number | null;
  /** Lighthouse's `numericValue` in the baseline run; `null` when absent. */
  baselineNumericValue: number | null;
  /** Lighthouse's `numericValue` in the comparison run; `null` when absent. */
  comparisonNumericValue: number | null;
  /** `comparison − baseline` numeric value; `null` when either is missing. */
  numericDelta: number | null;
  /** Lighthouse's `numericUnit` (`millisecond`, `byte`, `element`, …); `""` when absent. */
  numericUnit: string;
  /** Lighthouse's rendered value in the baseline run (`"1.2 s"`); `""` when absent. */
  baselineDisplayValue: string;
  /** Lighthouse's rendered value in the comparison run; `""` when absent. */
  comparisonDisplayValue: string;
  /** `scoreDisplayMode` in the comparison run, else the baseline's; `""` when absent. */
  scoreDisplayMode: string;
  /** How this audit moved. */
  status: DeltaStatus;
  /** Which signal decided {@link status} — see {@link DeltaBasis}. */
  basis: DeltaBasis;
}

/**
 * One performance opportunity's delta, ranked by the CHANGE in its estimated
 * savings. Mirrors the field names of `Opportunity`
 * (`@/lib/lighthouse/types`) side-for-side so the existing opportunity UI and
 * the analysis prompt read the same vocabulary.
 */
export interface OpportunityDelta {
  /** Audit id (`render-blocking-resources`). */
  id: string;
  /** Lighthouse's own title. */
  title: string;
  /** Lighthouse's own description, truncated by the differ. */
  description: string;
  /** Estimated savings in the baseline run, ms; `null` when absent/unquantified. */
  baselineSavingsMs: number | null;
  /** Estimated savings in the comparison run, ms; `null` when absent/unquantified. */
  comparisonSavingsMs: number | null;
  /**
   * `comparison − baseline` estimated savings, ms. POSITIVE means the
   * comparison run wastes MORE — i.e. a regression — which is the ranking key
   * the plan asks for ("rank by estimated savings change so the biggest
   * regressions surface first"). `null` when either side is missing.
   */
  savingsDeltaMs: number | null;
  /** Lighthouse's rendered savings in the baseline run; `""` when absent. */
  baselineDisplayValue: string;
  /** Lighthouse's rendered savings in the comparison run; `""` when absent. */
  comparisonDisplayValue: string;
  /** 0–1 audit score in the baseline run; `null` when unscored/absent. */
  baselineScore: number | null;
  /** 0–1 audit score in the comparison run; `null` when unscored/absent. */
  comparisonScore: number | null;
  /**
   * How this opportunity moved. Classified on SAVINGS (more waste = worse), not
   * on score: an opportunity's whole point is the number of milliseconds it is
   * costing, and many of them are scored `null` in a passing run.
   */
  status: DeltaStatus;
}

/**
 * One request URL's delta between the two runs, keyed by the full URL.
 *
 * Counted rather than matched one-to-one: a page can request the same URL more
 * than once, so each side contributes an occurrence count and a summed transfer
 * size. That makes "the page now fetches this twice" visible instead of
 * collapsing into a size change.
 */
export interface ResourceDelta {
  /** Full request URL as Lighthouse recorded it. UNTRUSTED (see module note). */
  url: string;
  /** Path + query for display; the raw URL when unparseable. UNTRUSTED. */
  path: string;
  /** Hostname; `""` when the URL has none. UNTRUSTED. */
  host: string;
  /** Lighthouse's resource kind (`Script`, `Image`, …); `""` when absent. */
  resourceType: string;
  /** True when either side marked this request third-party. */
  thirdParty: boolean;
  /** How many times the baseline run requested this URL. */
  baselineCount: number;
  /** How many times the comparison run requested this URL. */
  comparisonCount: number;
  /** Summed transfer bytes in the baseline run; `null` when none were recorded. */
  baselineTransferSize: number | null;
  /** Summed transfer bytes in the comparison run; `null` when none were recorded. */
  comparisonTransferSize: number | null;
  /** `comparison − baseline` transfer bytes; `null` when either side is missing. */
  transferDelta: number | null;
  /**
   * `added` / `removed` when the URL is on one side only; otherwise `regressed`
   * (it grew), `improved` (it shrank), or `unchanged`. A request whose BYTES are
   * identical but whose occurrence COUNT moved is classified on the count.
   */
  status: DeltaStatus;
}

/** The request-level half of a run diff, built on Phase D's waterfall reader. */
export interface ResourceDiff {
  /** Requests only the comparison run made. Largest transfer first. */
  added: ResourceDelta[];
  /** Requests only the baseline run made. Largest transfer first. */
  removed: ResourceDelta[];
  /** Requests both runs made whose size or count moved. Largest GROWTH first. */
  changed: ResourceDelta[];
  /** Requests both runs made that did not move at all (a count, not a list). */
  unchangedCount: number;
  /** Total requests in each run, and the delta. */
  baselineRequestCount: number;
  comparisonRequestCount: number;
  requestCountDelta: number;
  /** Total transfer bytes in each run, and the delta. */
  baselineTransferSize: number;
  comparisonTransferSize: number;
  transferSizeDelta: number;
  /** Third-party request counts in each run. */
  baselineThirdPartyCount: number;
  comparisonThirdPartyCount: number;
  /**
   * True when EITHER report carried no usable `network-requests` audit — the
   * signal for "one of these runs predates the feature", which is not the same
   * as two runs that genuinely made no requests.
   */
  unavailable: boolean;
}

/** Identity and headline numbers of one side of a diff. */
export interface RunDiffSide {
  /** The run id, echoed from the DB row (never the caller's string). */
  runId: string;
  /** `finalDisplayedUrl`/`finalUrl` from the LHR; `""` when absent. UNTRUSTED. */
  finalUrl: string;
  /** ISO `fetchTime` from the LHR; `""` when absent. */
  fetchTime: string;
  /** The Lighthouse version that produced the report; `""` when absent. */
  lighthouseVersion: string;
  /** Category scores (0–100), so the payload is self-contained for the AI feed. */
  scores: CategoryScores;
}

/**
 * The whole payload of `GET /api/reports/:runId/diff?baseline=<id>` — one
 * audit-level comparison of two stored reports.
 */
export interface RunDiff {
  /** The earlier / reference run. */
  baseline: RunDiffSide;
  /** The later / subject run — the `:runId` in the route. */
  comparison: RunDiffSide;
  /**
   * Audits that MOVED, worst-first (see `rankAuditDeltas`). Unchanged audits are
   * counted in {@link unchangedAuditCount} rather than listed: a full run
   * carries ~180 audits and shipping the ~170 that did nothing would dwarf the
   * signal. The pure differ still classifies every audit — the composer filters.
   */
  audits: AuditDelta[];
  /** Opportunities whose estimated savings moved, biggest regression first. */
  opportunities: OpportunityDelta[];
  /** Added / removed / grown requests. */
  resources: ResourceDiff;
  /** Audits present on both sides that did not move. */
  unchangedAuditCount: number;
  /** Pre-cap totals, so the UI can say "showing 40 of 112" honestly. */
  totals: {
    /** Audits that moved, before {@link MAX_AUDIT_DELTAS}. */
    audits: number;
    /** Opportunities that moved, before {@link MAX_OPPORTUNITY_DELTAS}. */
    opportunities: number;
    /** Added requests, before {@link MAX_RESOURCE_DELTAS}. */
    resourcesAdded: number;
    /** Removed requests, before {@link MAX_RESOURCE_DELTAS}. */
    resourcesRemoved: number;
    /** Changed requests, before {@link MAX_RESOURCE_DELTAS}. */
    resourcesChanged: number;
  };
  /**
   * True when the two runs finished on different URLs. Not an error — a
   * redirect target can legitimately change — but it means the diff may be
   * comparing two different pages, which the UI must say out loud rather than
   * present as a regression.
   */
  urlMismatch: boolean;
}

// --- Caps -------------------------------------------------------------------
//
// The route is reachable blind from another loopback port (ROADMAP Phase D's L1
// finding: cookies ignore ports and `SameSite=Strict` is scoped to the site, not
// the port), and every list below is built from data the audited page chose. So
// the payload is bounded by construction rather than by trusting the input.

/** Max audits listed in a {@link RunDiff}; the rest are counted in `totals`. */
export const MAX_AUDIT_DELTAS = 80;
/** Max opportunities listed in a {@link RunDiff}. */
export const MAX_OPPORTUNITY_DELTAS = 20;
/** Max requests listed in EACH of `added` / `removed` / `changed`. */
export const MAX_RESOURCE_DELTAS = 40;
/** Truncation ceiling for any audit/opportunity description carried on the wire. */
export const MAX_DIFF_DESCRIPTION = 280;
/**
 * Truncation ceiling for a page-authored URL string on the wire
 * (`ResourceDelta.url`/`path`/`host`).
 *
 * Row COUNT was bounded from the start; the strings inside a row were not, which
 * Phase E's security review caught (L4). An audited page chooses its own
 * subresource URLs, so it can issue forty requests to a 400 KB URL — those land
 * in `network-requests`, survive the route's per-report ceiling, and would make
 * one response bounded only by the reports themselves, with the route's 16-entry
 * memo retaining several of them. 2048 is the practical ceiling browsers and
 * servers already impose on a URL, so a real address is never touched.
 *
 * The consumers clamp for DISPLAY too (240 in the waterfall view, 100 in the
 * prompt), and that is not redundant: those bound what a person or a model
 * reads, this bounds what the server holds and sends.
 */
export const MAX_DIFF_URL = 2048;
