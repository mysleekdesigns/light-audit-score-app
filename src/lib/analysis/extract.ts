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

/** Max failing/low-score category audits surfaced to the model (a11y/bp/seo). */
const MAX_AUDITS = 15;
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
  /** A11y / Best Practices / SEO: the failing & low-score audits. */
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

    const target = selector ?? url ?? asString(item.label);
    if (target) examples.push(truncate(target, 160));
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
        a.score < 0.9 &&
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
    displayValue: a.displayValue,
    failed: a.state === "failed",
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
    url: parsed.finalUrl || parsed.requestedUrl,
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
        displayValue: m?.displayValue ?? "—",
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
        displayValue: o.displayValue,
        score: o.score,
      }));
    if (field) base.field = projectField(field);
    return base;
  }

  // Accessibility / Best Practices / SEO: enrich the failing audits with a few
  // concrete targets read from the raw audit details (which the parsed ref drops).
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
