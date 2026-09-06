/**
 * Turn a raw Lighthouse Result (LHR) — and, optionally, an audit-level
 * {@link RunDiff} against an earlier run — into a compact, bounded, LLM-friendly
 * summary of *why* one category scored low, and *what moved* to get it there.
 *
 * Pure (no I/O, no SDK): it reuses the project's existing LHR parsers
 * (`parseLhr` / `parseCategoryAudits` in `@/lib/lighthouse/parseLhr`) so it can
 * be unit-tested against a stored `data/reports/*.json` and never drifts from how
 * the rest of the app reads an LHR. The output is deliberately small (caps audits
 * / opportunities, truncates prose, keeps only a few concrete targets per audit)
 * to stay well within a few thousand input tokens.
 *
 * The diff is an ADDITIVE seam: with no `diff` argument every byte of the output
 * — and so every byte of the prompt built from it — is what it was before diffs
 * existed. See {@link projectRunDiff} for how a `RunDiff` is bounded and filtered
 * down to the one category being analysed.
 */

import {
  asString,
  isRecord,
  parseCategoryAudits,
  parseLhr,
} from "@/lib/lighthouse/parseLhr";
import type {
  CategoryAuditRef,
  FieldData,
  FieldMetricId,
  FormFactor,
  LighthouseResult,
} from "@/lib/lighthouse/types";
import type {
  AuditDelta,
  DeltaBasis,
  DeltaStatus,
  OpportunityDelta,
  ResourceDelta,
  RunDiff,
} from "@/lib/reports/diff-types";
import { METRIC_DISPLAY_ORDER, METRIC_META } from "@/lib/scores";
import type { AnalysisCategory } from "@/lib/analysis/types";

/** Max failing/low-score category audits surfaced to the model (every non-performance category). */
const MAX_AUDITS = 15;
/**
 * Lighthouse's own pass threshold (`Util.PASS_THRESHOLD`): its report shows any
 * audit scoring ≥ 0.9 as passing, and counts it as passed in the "N/M" fraction
 * an Agentic Browsing category renders.
 */
const PASS_THRESHOLD = 0.9;
/** Max performance opportunities surfaced (sorted by estimated savings desc). */
const MAX_OPPORTUNITIES = 8;
/** Max concrete targets (selectors/urls) pulled from one audit's details. */
const MAX_EXAMPLES = 5;
/** Truncation ceiling for any single description string. */
const MAX_DESC = 280;

// --- Diff caps --------------------------------------------------------------
//
// A `RunDiff` is bounded for the WIRE (80 audits, 20 opportunities, 40 requests
// in each of three buckets — `MAX_*_DELTAS` in `@/lib/reports/diff-types`), which
// is still an order of magnitude more than belongs in a prompt. These are the
// PROMPT caps, and they are deliberately much tighter: the change section is the
// frame for the analysis, not a second data dump, and it has to fit alongside
// the current-run findings that are still the evidence.
//
// The pre-cap counts survive into `ChangeFinding.totals`, so the prompt says
// "showing 10 of 23" rather than quietly implying it listed everything.

/** Max moved audits (already filtered to this category) surfaced in the prompt. */
const MAX_CHANGE_AUDITS = 10;
/** Max moved opportunities surfaced (performance only). */
const MAX_CHANGE_OPPORTUNITIES = 5;
/** Max requests surfaced in EACH of added / removed / changed (performance only). */
const MAX_CHANGE_RESOURCES = 5;
/** Truncation ceiling for one page-authored request label (`host` + `path`). */
const MAX_RESOURCE_LABEL = 100;
/** How much of a request's query string is kept in that label — see {@link resourceLabel}. */
const MAX_RESOURCE_QUERY = 40;
/**
 * Truncation ceiling for a description in the change section — tighter than
 * {@link MAX_DESC}, because the current-run sections below already carry the
 * full text for any audit that matters, and this one only has to say what moved.
 */
const MAX_CHANGE_DESC = 200;

/** One Core Web Vital / key timing, projected for the prompt. */
export interface MetricFinding {
  abbr: string;
  label: string;
  displayValue: string;
  /** 0–1 metric score, or null when unscored. */
  score: number | null;
}

/** One performance opportunity / diagnostic, projected for the prompt. */
export interface OpportunityFinding {
  id: string;
  title: string;
  description: string;
  savingsMs: number | null;
  displayValue: string;
  score: number | null;
}

/** One failing/low-score category audit (accessibility / best-practices / seo). */
export interface AuditFinding {
  id: string;
  title: string;
  description: string;
  /** Scoring weight from the category's auditRefs (0 = informative). */
  weight: number;
  /** 0–1 audit score, or null. */
  score: number | null;
  displayValue: string;
  /** Whether the audit failed outright vs merely scored below the "good" band. */
  failed: boolean;
  /** Count of affected elements/resources from the audit details, if available. */
  itemCount?: number;
  /** A few concrete targets (CSS selectors / URLs) from the audit details. */
  examples?: string[];
}

/** One CrUX field experience (real-world p75), projected for the prompt. */
export interface FieldFinding {
  scope: "url" | "origin";
  overall: string | null;
  metrics: { id: FieldMetricId; p75: number; category: string }[];
}

/** One audit that MOVED between the baseline and this run, projected for the prompt. */
export interface ChangeAuditFinding {
  id: string;
  /** Lighthouse's own title — not page-authored. */
  title: string;
  /** Lighthouse's own description, truncated — not page-authored. */
  description: string;
  /** Largest scoring weight in any category naming it (0 = informative). */
  weight: number;
  status: DeltaStatus;
  basis: DeltaBasis;
  /** 0–1 scores on each side; `null` when unscored or absent from that run. */
  baselineScore: number | null;
  comparisonScore: number | null;
  /** Lighthouse's rendered values. UNTRUSTED — render inside «…». */
  baselineDisplayValue: string;
  comparisonDisplayValue: string;
}

/** One performance opportunity whose estimated savings moved. */
export interface ChangeOpportunityFinding {
  id: string;
  title: string;
  description: string;
  status: DeltaStatus;
  /** `comparison − baseline` estimated savings, ms. POSITIVE = more waste now. */
  savingsDeltaMs: number | null;
  baselineSavingsMs: number | null;
  comparisonSavingsMs: number | null;
}

/** One request that appeared, disappeared, or changed size between the runs. */
export interface ChangeResourceFinding {
  /**
   * `host` + path, query string collapsed to `?…` (or the raw URL when the host
   * is unknown), sanitized. PAGE-AUTHORED and UNTRUSTED — render inside «…».
   */
  label: string;
  /** Lighthouse's resource kind (`Script`, `Image`, …); `""` when absent. */
  resourceType: string;
  thirdParty: boolean;
  status: DeltaStatus;
  /** `comparison − baseline` transfer bytes; `null` when one side is missing. */
  transferDelta: number | null;
  /** Bytes on whichever side carries this request now (or carried it before). */
  transferSize: number | null;
  /** `comparisonCount − baselineCount`. */
  countDelta: number;
}

/** The request-level half of the change section (performance only). */
export interface ChangeResourceSummary {
  /** True when either report predates the waterfall reader — say so, don't guess. */
  unavailable: boolean;
  baselineRequestCount: number;
  comparisonRequestCount: number;
  requestCountDelta: number;
  baselineTransferSize: number;
  comparisonTransferSize: number;
  transferSizeDelta: number;
  thirdPartyDelta: number;
  added: ChangeResourceFinding[];
  removed: ChangeResourceFinding[];
  changed: ChangeResourceFinding[];
  /** Pre-cap counts from the diff, so the prompt can say "showing 5 of 31". */
  totals: { added: number; removed: number; changed: number };
}

/**
 * What moved between a baseline run and this one, filtered to the category being
 * analysed and capped for the prompt. Built by {@link projectRunDiff}.
 */
export interface ChangeFinding {
  baselineRunId: string;
  comparisonRunId: string;
  /** The baseline run's final URL. PAGE-AUTHORED and UNTRUSTED — guard it. */
  baselineUrl: string;
  /** ISO fetch times, so the model can say how far apart the runs are. */
  baselineFetchTime: string;
  comparisonFetchTime: string;
  /** 0–100 category scores on each side, and `comparison − baseline`. */
  baselineScore: number | null;
  comparisonScore: number | null;
  scoreDelta: number | null;
  /** The two runs finished on different URLs — possibly not the same page. */
  urlMismatch: boolean;
  /** Set only when the two runs used different Lighthouse versions. */
  versionMismatch: { baseline: string; comparison: string } | null;
  /** Moved audits in THIS category, worst-first (the differ's own ranking). */
  audits: ChangeAuditFinding[];
  /** Performance only: opportunities whose savings moved, biggest regression first. */
  opportunities?: ChangeOpportunityFinding[];
  /** Performance only: what the page fetched differently. */
  resources?: ChangeResourceSummary;
  totals: {
    /** Category-matching moved audits before {@link MAX_CHANGE_AUDITS}. */
    audits: number;
    /** Moved opportunities before {@link MAX_CHANGE_OPPORTUNITIES}. */
    opportunities: number;
    /**
     * True when the DIFFER already capped its own audit list upstream, so even
     * the pre-cap count above is a floor. The prompt says so rather than letting
     * the model read a truncated list as exhaustive.
     */
    truncatedUpstream: boolean;
  };
  /**
   * True when nothing this category can attribute a change to moved — no audit,
   * no opportunity, no request. The prompt must then say "nothing changed"
   * instead of manufacturing a regression to explain.
   */
  empty: boolean;
}

/** Compact, bounded summary handed to the prompt builder. */
export interface AnalysisInput {
  url: string;
  formFactor: FormFactor;
  lighthouseVersion: string;
  category: AnalysisCategory;
  /** 0–100 score for the analyzed category (null if unscored). */
  categoryScore: number | null;
  /** Performance only: Core Web Vitals / key timings. */
  metrics?: MetricFinding[];
  /** Performance only: top opportunities by estimated savings. */
  opportunities?: OpportunityFinding[];
  /** Every non-performance category: the failing & low-score audits. */
  audits?: AuditFinding[];
  /** PSI only: real-world CrUX field data, when present. */
  field?: FieldFinding[];
  /**
   * Set only when the caller supplied a baseline to compare against. Its
   * presence flips the whole prompt from "diagnose this page" to "explain this
   * change" — see `buildUserPrompt`.
   */
  change?: ChangeFinding;
}

/** Truncate a string to {@link MAX_DESC} chars on a word-ish boundary. */
function truncate(value: string, max = MAX_DESC): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/**
 * Flatten a string written by the AUDITED PAGE — its final URL, the CSS
 * selectors and resource URLs Lighthouse copied out of the failing elements —
 * into a single harmless line of prompt data.
 *
 * Audit titles and descriptions are Lighthouse's own text; these are not. They
 * are attacker-controlled whenever the audited site is, and they land in a
 * prompt that a tool-using agent reads (`providers/claude.ts`), which makes them
 * an indirect prompt-injection vector (OWASP LLM01). Line structure is what an
 * injection needs to look like an instruction rather than a value, so:
 *
 *  - control characters and line breaks collapse to single spaces, keeping every
 *    value inside the one `- examples: …` bullet it was rendered into;
 *  - the fixes sentinels are defanged, so page content cannot forge (or
 *    prematurely close) the JSON block the response protocol is parsed from.
 *
 * The prompt fences these values as untrusted data too ({@link buildUserPrompt});
 * this is the half that holds regardless of what the model makes of the fence.
 */
export function sanitizeUntrusted(value: string, max = MAX_DESC): string {
  //
  // ORDER IS LOAD-BEARING. Every stage that DELETES characters runs before the
  // `<` defang, and nothing after it deletes — otherwise a deletion pulls two
  // `<` back together and re-forms the sentinel the defang just broke apart.
  // `div ​<​<​<FIXES_JSON>>>` (zero-width spaces between the angle brackets)
  // is the concrete case: the defang sees no adjacent `<` to separate, and the
  // invisible-character strip then yields a verbatim `<<<FIXES_JSON>>>`.
  const flattened = value
    // Control characters, C0 and C1. Substitutes, so it is safe anywhere.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    // DELETES: the prompt's untrusted-data guards, so page text cannot close
    // its own fence.
    .replace(/[«»]/g, "")
    // DELETES: invisible and bidi-control characters. They cannot forge line
    // structure (`\s` below already collapses every Unicode separator), but
    // they can hide an injection from anyone reading the prompt or the
    // rendered example — and, before this ran first, splice a sentinel.
    .replace(/[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/g, "")
    // The LAST character-level stage. One space after every `<` followed by
    // another; the lookahead (not `/<<</g`) is what makes it overlap-safe, so
    // `<<<<FIXES_JSON>>>` cannot come out as `< <<<FIXES_JSON>>>`.
    .replace(/<(?=<)/g, "< ")
    // Substitutes rather than deletes, so it cannot restore adjacency.
    .replace(/\s+/g, " ");
  return truncate(flattened, max);
}

/**
 * Pull up to {@link MAX_EXAMPLES} concrete targets from an audit's `details`
 * (Lighthouse's table/opportunity/list shapes), preferring CSS selectors and
 * URLs — the things a fix would actually act on. Returns `{ count, examples }`.
 */
function summarizeDetails(details: unknown): {
  count?: number;
  examples?: string[];
} {
  if (!isRecord(details) || !Array.isArray(details.items)) return {};
  const items = details.items;
  const examples: string[] = [];

  for (const item of items) {
    if (examples.length >= MAX_EXAMPLES) break;
    if (!isRecord(item)) continue;

    // Element nodes: `{ node: { selector, snippet } }`.
    const node = isRecord(item.node) ? item.node : undefined;
    const selector = node ? asString(node.selector) : undefined;
    // Resource rows: `url` directly, or `{ source: { url } }`.
    const source = isRecord(item.source) ? item.source : undefined;
    const url =
      asString(item.url) ?? (source ? asString(source.url) : undefined);

    // Page-authored text (a selector from the site's own DOM, a resource URL it
    // chose) — flattened before it can reach the prompt. See `sanitizeUntrusted`.
    const target = selector ?? url ?? asString(item.label);
    if (target) examples.push(sanitizeUntrusted(target, 160));
  }

  return {
    count: items.length,
    examples: examples.length > 0 ? examples : undefined,
  };
}

/** Project the failing/low-score audits of a non-performance category. */
function projectAudits(refs: CategoryAuditRef[]): AuditFinding[] {
  // `parseCategoryAudits` already sorts failed-first (by weight desc). Keep the
  // ones that move the score: outright failures, plus weighted audits scoring
  // below the "good" band. Drop passing / not-applicable / informative noise.
  const relevant = refs.filter(
    (a) =>
      a.state === "failed" ||
      (a.weight > 0 &&
        a.score !== null &&
        a.score < PASS_THRESHOLD &&
        a.state !== "notApplicable"),
  );

  // `parseCategoryAudits` drops the raw audit `details`, so `itemCount`/`examples`
  // are filled by the caller (which still has the LHR). Project the rest here.
  return relevant.slice(0, MAX_AUDITS).map((a) => ({
    id: a.id,
    title: a.title,
    description: truncate(a.description),
    weight: a.weight,
    score: a.score,
    displayValue: sanitizeUntrusted(a.displayValue, 160),
    // `parseCategoryAudits` calls anything short of a perfect score "failed",
    // which is right for the binary audits that fill a11y/Best Practices/SEO but
    // wrong for a NUMERIC one — and Agentic Browsing is the first category to
    // route one of those (`cumulative-layout-shift`) through here. Lighthouse
    // shows a 0.95 CLS as passing, so labelling it FAILED to the model would push
    // a near-perfect audit to the top of a ranking it barely moves. Report it at
    // its score instead; the filter above still surfaces it as worth improving.
    failed:
      a.state === "failed" && !(a.score !== null && a.score >= PASS_THRESHOLD),
  }));
}

/** Read CrUX field data (PSI) into compact per-experience findings. */
function projectField(field: FieldData): FieldFinding[] {
  const out: FieldFinding[] = [];
  for (const scope of ["url", "origin"] as const) {
    const experience = field[scope];
    if (!experience) continue;
    const metrics = Object.entries(experience.metrics)
      .filter(([, m]) => m)
      .map(([id, m]) => ({
        id: id as FieldMetricId,
        p75: m!.percentile,
        category: m!.category,
      }));
    out.push({ scope, overall: experience.overallCategory, metrics });
  }
  return out;
}

/**
 * Condense one of Lighthouse's own audit descriptions for the change section.
 *
 * Nearly every Lighthouse description ends in a `[Learn more …](https://…)`
 * markdown link, which on a real report is 100–130 characters of the ~300 — a
 * third of the section's budget spent on doc URLs the change list has no use
 * for. The current-run sections below still carry the full description, links
 * and all, for any audit worth acting on; the researching tier fetches its own
 * sources; and the data-only tier is forbidden from citing anything.
 *
 * Strips the links, THEN truncates, so a cut never lands inside a URL.
 */
function condenseDescription(value: string): string {
  return truncate(
    value.replace(/\s*\[[^\]]*\]\(\s*https?:\/\/[^)]*\)\s*\.?/g, ""),
    MAX_CHANGE_DESC,
  );
}

/**
 * Compose the page-authored label for a request: `host` + path, keeping only the
 * head of a long query string.
 *
 * A real regression is full of analytics beacons whose query strings run to 300
 * characters of opaque ids, and fifteen of those would crowd out every request
 * worth naming. Dropping the query outright is too blunt in the other direction:
 * two `gtag/js?id=…` requests differ ONLY in their query, and collapsing them to
 * one label would tell the model the page fetched the same thing twice. So the
 * first {@link MAX_RESOURCE_QUERY} characters stay — enough to tell two requests
 * apart — and the ellipsis says the rest was dropped.
 */
function resourceLabel(delta: ResourceDelta): string {
  if (!delta.host) return delta.url;
  const mark = delta.path.indexOf("?");
  if (mark === -1) return `${delta.host}${delta.path}`;
  const query = delta.path.slice(mark + 1);
  if (query.length <= MAX_RESOURCE_QUERY) return `${delta.host}${delta.path}`;
  return `${delta.host}${delta.path.slice(0, mark + 1)}${query.slice(
    0,
    MAX_RESOURCE_QUERY,
  )}…`;
}

/** Project one moved audit, keeping only what the prompt actually renders. */
function projectAuditDelta(delta: AuditDelta): ChangeAuditFinding {
  return {
    id: delta.id,
    // Lighthouse's own strings, like every other audit title/description here.
    title: delta.title,
    description: condenseDescription(delta.description),
    weight: delta.weight,
    status: delta.status,
    basis: delta.basis,
    baselineScore: delta.baselineScore,
    comparisonScore: delta.comparisonScore,
    // Rendered values can carry page text (a URL, an element count copied out of
    // the page's own markup), so they get the same treatment as `AuditFinding`.
    baselineDisplayValue: sanitizeUntrusted(delta.baselineDisplayValue, 160),
    comparisonDisplayValue: sanitizeUntrusted(delta.comparisonDisplayValue, 160),
  };
}

/** Project one moved opportunity. Savings, not score, is what it is about. */
function projectOpportunityDelta(delta: OpportunityDelta): ChangeOpportunityFinding {
  return {
    id: delta.id,
    title: delta.title,
    description: condenseDescription(delta.description),
    status: delta.status,
    savingsDeltaMs: delta.savingsDeltaMs,
    baselineSavingsMs: delta.baselineSavingsMs,
    comparisonSavingsMs: delta.comparisonSavingsMs,
  };
}

/**
 * Project one request delta.
 *
 * `url`, `path` and `host` are all chosen by the audited page — the most
 * attacker-controlled fields in a `RunDiff` — so the label {@link resourceLabel}
 * composes is flattened by {@link sanitizeUntrusted} before it can reach the
 * prompt, exactly like an audit `example`.
 */
function projectResourceDelta(delta: ResourceDelta): ChangeResourceFinding {
  return {
    label: sanitizeUntrusted(resourceLabel(delta), MAX_RESOURCE_LABEL),
    resourceType: sanitizeUntrusted(delta.resourceType, 40),
    thirdParty: delta.thirdParty,
    status: delta.status,
    transferDelta: delta.transferDelta,
    transferSize: delta.comparisonTransferSize ?? delta.baselineTransferSize,
    countDelta: delta.comparisonCount - delta.baselineCount,
  };
}

/** True when any request-level movement at all was recorded. */
function resourcesMoved(resources: ChangeResourceSummary): boolean {
  return (
    resources.totals.added > 0 ||
    resources.totals.removed > 0 ||
    resources.totals.changed > 0 ||
    resources.requestCountDelta !== 0 ||
    resources.transferSizeDelta !== 0
  );
}

/**
 * Project a {@link RunDiff} down to what one category's prompt can use.
 *
 * Two jobs, both non-negotiable:
 *
 *  1. **Filter to the category.** A `RunDiff` classifies every audit in the
 *     report, so an SEO analysis handed the raw list would be reading the
 *     performance regression instead of its own. `AuditDelta.categories` names
 *     the categories whose `auditRefs` include the audit, on either side, so
 *     that is the filter. Opportunities and requests are performance concepts —
 *     Lighthouse only scores opportunities in that category, and a request-level
 *     waterfall says nothing about a missing meta description — so they are
 *     carried for performance only.
 *  2. **Cap hard.** The wire caps are three to eight times these, and the change
 *     section shares a prompt with the current-run findings. Pre-cap counts go
 *     into `totals` so the prompt stays honest about what it left out.
 *
 * Ordering is the differ's: `audits` arrive worst-first, `opportunities` by
 * savings change, and each request bucket largest-first — filtering preserves it,
 * so the cap keeps the worst offenders rather than an arbitrary slice.
 */
export function projectRunDiff(
  diff: RunDiff,
  category: AnalysisCategory,
): ChangeFinding {
  // `RunDiff.audits` is documented as "audits that MOVED", but an `unchanged`
  // entry costs nothing to drop and would otherwise burn one of ten slots.
  const matching = diff.audits.filter(
    (a) => a.status !== "unchanged" && a.categories.includes(category),
  );

  const isPerformance = category === "performance";
  const movedOpportunities = isPerformance
    ? diff.opportunities.filter((o) => o.status !== "unchanged")
    : [];

  const baselineScore = diff.baseline.scores[category] ?? null;
  const comparisonScore = diff.comparison.scores[category] ?? null;

  const change: ChangeFinding = {
    baselineRunId: diff.baseline.runId,
    comparisonRunId: diff.comparison.runId,
    baselineUrl: sanitizeUntrusted(diff.baseline.finalUrl, 500),
    baselineFetchTime: diff.baseline.fetchTime,
    comparisonFetchTime: diff.comparison.fetchTime,
    baselineScore,
    comparisonScore,
    scoreDelta:
      baselineScore === null || comparisonScore === null
        ? null
        : comparisonScore - baselineScore,
    urlMismatch: diff.urlMismatch,
    versionMismatch:
      diff.baseline.lighthouseVersion !== diff.comparison.lighthouseVersion
        ? {
            baseline: diff.baseline.lighthouseVersion,
            comparison: diff.comparison.lighthouseVersion,
          }
        : null,
    audits: matching.slice(0, MAX_CHANGE_AUDITS).map(projectAuditDelta),
    totals: {
      audits: matching.length,
      opportunities: movedOpportunities.length,
      // The differ hit its own 80-audit ceiling, so `totals.audits` above is a
      // floor even before this projection capped it again.
      truncatedUpstream: diff.totals.audits > diff.audits.length,
    },
    empty: false,
  };

  if (isPerformance) {
    change.opportunities = movedOpportunities
      .slice(0, MAX_CHANGE_OPPORTUNITIES)
      .map(projectOpportunityDelta);
    change.resources = {
      unavailable: diff.resources.unavailable,
      baselineRequestCount: diff.resources.baselineRequestCount,
      comparisonRequestCount: diff.resources.comparisonRequestCount,
      requestCountDelta: diff.resources.requestCountDelta,
      baselineTransferSize: diff.resources.baselineTransferSize,
      comparisonTransferSize: diff.resources.comparisonTransferSize,
      transferSizeDelta: diff.resources.transferSizeDelta,
      thirdPartyDelta:
        diff.resources.comparisonThirdPartyCount -
        diff.resources.baselineThirdPartyCount,
      added: diff.resources.added
        .slice(0, MAX_CHANGE_RESOURCES)
        .map(projectResourceDelta),
      removed: diff.resources.removed
        .slice(0, MAX_CHANGE_RESOURCES)
        .map(projectResourceDelta),
      changed: diff.resources.changed
        .slice(0, MAX_CHANGE_RESOURCES)
        .map(projectResourceDelta),
      totals: {
        added: diff.totals.resourcesAdded,
        removed: diff.totals.resourcesRemoved,
        changed: diff.totals.resourcesChanged,
      },
    };
  }

  change.empty =
    change.audits.length === 0 &&
    (change.opportunities?.length ?? 0) === 0 &&
    !(change.resources && !change.resources.unavailable && resourcesMoved(change.resources));

  return change;
}

/**
 * Build the bounded {@link AnalysisInput} for one category of one run.
 *
 * Performance is summarized via metrics + top opportunities (with CrUX field
 * data when present); the other categories via their failing/low-score audits,
 * each enriched with a few concrete targets pulled from the raw audit details.
 *
 * Pass `diff` to compare this run against an earlier one: the extra
 * {@link ChangeFinding} turns the prompt from a diagnosis of the page into an
 * explanation of what moved. Omit it and the output is unchanged in every byte.
 */
export function buildAnalysisInput(args: {
  lhr: LighthouseResult;
  category: AnalysisCategory;
  formFactor: FormFactor;
  field?: FieldData | null;
  /** Audit-level diff against a baseline run, when the caller has one. */
  diff?: RunDiff | null;
}): AnalysisInput {
  const { lhr, category, formFactor, field, diff } = args;
  const parsed = parseLhr(lhr, formFactor);
  const categoryScore = parsed.scores[category] ?? null;

  const base: AnalysisInput = {
    // Also page-derived: the final URL is whatever the site redirected us to.
    url: sanitizeUntrusted(parsed.finalUrl || parsed.requestedUrl, 500),
    formFactor,
    lighthouseVersion: parsed.lighthouseVersion,
    category,
    categoryScore,
  };

  // Before the per-category branches below, both of which return.
  if (diff) base.change = projectRunDiff(diff, category);

  if (category === "performance") {
    base.metrics = METRIC_DISPLAY_ORDER.map((id) => {
      const m = parsed.metrics[id];
      return {
        abbr: METRIC_META[id].abbr,
        label: METRIC_META[id].label,
        displayValue: sanitizeUntrusted(m?.displayValue ?? "—", 160),
        score: m?.score ?? null,
      };
    });
    base.opportunities = parsed.opportunities
      .slice(0, MAX_OPPORTUNITIES)
      .map((o) => ({
        id: o.id,
        title: o.title,
        description: truncate(o.description),
        savingsMs: o.savingsMs,
        displayValue: sanitizeUntrusted(o.displayValue, 160),
        score: o.score,
      }));
    if (field) base.field = projectField(field);
    return base;
  }

  // Every other category (Accessibility / Best Practices / SEO / Agentic
  // Browsing): enrich the failing audits with a few concrete targets read from
  // the raw audit details (which the parsed ref drops).
  const refs = parseCategoryAudits(lhr, category);
  const rawAudits = isRecord(lhr.audits) ? lhr.audits : {};
  base.audits = projectAudits(refs).map((finding) => {
    const raw = rawAudits[finding.id];
    const details = isRecord(raw) ? raw.details : undefined;
    const { count, examples } = summarizeDetails(details);
    return { ...finding, itemCount: count, examples };
  });
  return base;
}

// Re-exported so the prompt builder can read the same numeric guardrails.
export {
  MAX_AUDITS,
  MAX_CHANGE_AUDITS,
  MAX_CHANGE_OPPORTUNITIES,
  MAX_CHANGE_RESOURCES,
  MAX_OPPORTUNITIES,
};
