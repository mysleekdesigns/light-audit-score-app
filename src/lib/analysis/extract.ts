/**
 * Turn a raw Lighthouse Result (LHR) into a compact, bounded, LLM-friendly
 * summary of *why* one category scored low — the input to the analysis prompt.
 *
 * Pure (no I/O, no SDK): it reuses the project's existing LHR parsers
 * (`parseLhr` / `parseCategoryAudits` in `@/lib/lighthouse/parseLhr`) so it can
 * be unit-tested against a stored `data/reports/*.json` and never drifts from how
 * the rest of the app reads an LHR. The output is deliberately small (caps audits
 * / opportunities, truncates prose, keeps only a few concrete targets per audit)
 * to stay well within a few thousand input tokens.
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
 * Build the bounded {@link AnalysisInput} for one category of one run.
 *
 * Performance is summarized via metrics + top opportunities (with CrUX field
 * data when present); the other categories via their failing/low-score audits,
 * each enriched with a few concrete targets pulled from the raw audit details.
 */
export function buildAnalysisInput(args: {
  lhr: LighthouseResult;
  category: AnalysisCategory;
  formFactor: FormFactor;
  field?: FieldData | null;
}): AnalysisInput {
  const { lhr, category, formFactor, field } = args;
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
export { MAX_AUDITS, MAX_OPPORTUNITIES };
