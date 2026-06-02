/**
 * Pure Lighthouse-Result (LHR) parsing (PRD §6 Phase 1 — extracted).
 *
 * These helpers narrow a loosely-typed LHR (`Record<string, unknown>`) into the
 * project's stable contract (scores, metrics, opportunities, per-audit category
 * breakdown, host environment). They are PURE — no Chrome, no `lighthouse` /
 * `chrome-launcher` imports, no I/O — so they can be:
 *  - unit-tested in isolation, and
 *  - shared by BOTH engines: the local forked-Chrome engine (`runAudit.ts`, which
 *    re-exports these) AND the in-process PageSpeed Insights engine
 *    (`src/lib/pagespeed/runPsiAudit.ts`), which parses PSI's `lighthouseResult`.
 *
 * Keeping them here (free of the heavy engine imports) is what lets `runPsiAudit`
 * reuse the one parser without dragging `lighthouse`/`chrome-launcher` into the
 * Next server bundle. `runAudit.ts` re-exports `parseLhr`, `parseCategoryAudits`,
 * and `parseEnvironment` so existing import paths and tests are unchanged.
 */

import {
  type AuditState,
  type CategoryAuditRef,
  type CategoryScores,
  type CoreWebVitals,
  type FormFactor,
  type LighthouseCategory,
  type LighthouseResult,
  LIGHTHOUSE_CATEGORIES,
  type MetricId,
  METRIC_IDS,
  type MetricValue,
  type Opportunity,
  type RunEnvironment,
  type SingleRunResult,
} from "@/lib/lighthouse/types";

/** Max opportunities surfaced per run (sorted by estimated savings desc). */
export const MAX_OPPORTUNITIES = 15;

// --- LHR narrowing helpers (pure) ------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** First defined string among the given keys on a record. */
export function pickString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function getCategories(lhr: LighthouseResult): Record<string, unknown> {
  const categories = lhr.categories;
  return isRecord(categories) ? categories : {};
}

function getAudits(lhr: LighthouseResult): Record<string, unknown> {
  const audits = lhr.audits;
  return isRecord(audits) ? audits : {};
}

/** Normalise Lighthouse category scores (0–1) to 0–100, keyed by category id. */
function parseScores(lhr: LighthouseResult): CategoryScores {
  const categories = getCategories(lhr);
  const scores: CategoryScores = {};
  for (const id of LIGHTHOUSE_CATEGORIES) {
    const category = categories[id];
    if (!isRecord(category)) continue;
    const raw = asNumber(category.score);
    scores[id as LighthouseCategory] = raw === null ? null : Math.round(raw * 100);
  }
  return scores;
}

/** Read each Core Web Vital / key timing audit; null when the audit is absent. */
function parseMetrics(lhr: LighthouseResult): CoreWebVitals {
  const audits = getAudits(lhr);
  const metrics = {} as CoreWebVitals;
  for (const id of METRIC_IDS) {
    const audit = audits[id];
    if (!isRecord(audit)) {
      metrics[id as MetricId] = null;
      continue;
    }
    const value: MetricValue = {
      numericValue: asNumber(audit.numericValue),
      displayValue: asString(audit.displayValue) ?? "",
      score: asNumber(audit.score),
    };
    metrics[id as MetricId] = value;
  }
  return metrics;
}

/**
 * Extract performance opportunities/diagnostics: audits whose `details.type` is
 * `"opportunity"` or that expose `overallSavingsMs`. Sorted by savings desc and
 * capped to {@link MAX_OPPORTUNITIES}.
 */
function parseOpportunities(lhr: LighthouseResult): Opportunity[] {
  const audits = getAudits(lhr);
  const opportunities: Opportunity[] = [];

  for (const [id, rawAudit] of Object.entries(audits)) {
    if (!isRecord(rawAudit)) continue;
    const details = isRecord(rawAudit.details) ? rawAudit.details : undefined;
    const detailsType = details ? asString(details.type) : undefined;
    const overallSavingsMs = details
      ? asNumber(details.overallSavingsMs)
      : null;

    const isOpportunity =
      detailsType === "opportunity" || overallSavingsMs !== null;
    if (!isOpportunity) continue;

    opportunities.push({
      id,
      title: asString(rawAudit.title) ?? id,
      description: asString(rawAudit.description) ?? "",
      savingsMs: overallSavingsMs,
      displayValue: asString(rawAudit.displayValue) ?? "",
      score: asNumber(rawAudit.score),
    });
  }

  opportunities.sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0));
  return opportunities.slice(0, MAX_OPPORTUNITIES);
}

/**
 * Classify a category audit by its score + `scoreDisplayMode`, mirroring how the
 * Lighthouse report buckets audits. `informative`/`manual` audits carry no weight
 * and aren't pass/fail; `notApplicable` didn't apply to this page; an errored or
 * unscored weighted audit is treated as failed; otherwise a perfect score (binary
 * audits are 0/1) passes and anything less fails.
 */
function auditState(score: number | null, scoreDisplayMode: string): AuditState {
  if (scoreDisplayMode === "notApplicable") return "notApplicable";
  if (scoreDisplayMode === "informative" || scoreDisplayMode === "manual") {
    return "informative";
  }
  if (scoreDisplayMode === "error" || score === null) return "failed";
  return score >= 1 ? "passed" : "failed";
}

/** Audit-state sort rank: failed first (what's dragging the score), N-A last. */
const AUDIT_STATE_RANK: Record<AuditState, number> = {
  failed: 0,
  passed: 1,
  informative: 2,
  notApplicable: 3,
};

/**
 * Project a Lighthouse category into its per-audit breakdown: join the category's
 * `auditRefs` (which carry the scoring `weight`/`group`) with each audit result
 * (title/description/score/scoreDisplayMode/displayValue). Surfaced so a category
 * score — especially the environment-sensitive Best Practices one — can be
 * explained audit-by-audit. Sorted failed-first (by weight desc), then passed,
 * then weightless informative/N-A audits. Tolerant of absent fields (returns []
 * when the category or its `auditRefs` are missing). Pure, like `parseOpportunities`.
 */
export function parseCategoryAudits(
  lhr: LighthouseResult,
  categoryId: string,
): CategoryAuditRef[] {
  const category = getCategories(lhr)[categoryId];
  if (!isRecord(category) || !Array.isArray(category.auditRefs)) return [];
  const audits = getAudits(lhr);

  const refs: CategoryAuditRef[] = [];
  for (const rawRef of category.auditRefs) {
    if (!isRecord(rawRef)) continue;
    const id = asString(rawRef.id);
    if (id === undefined) continue;

    const auditRecord = isRecord(audits[id]) ? (audits[id] as Record<string, unknown>) : {};
    const score = asNumber(auditRecord.score);
    const scoreDisplayMode = asString(auditRecord.scoreDisplayMode) ?? "";

    refs.push({
      id,
      title: asString(auditRecord.title) ?? id,
      description: asString(auditRecord.description) ?? "",
      weight: asNumber(rawRef.weight) ?? 0,
      group: asString(rawRef.group),
      score,
      scoreDisplayMode,
      displayValue: asString(auditRecord.displayValue) ?? "",
      state: auditState(score, scoreDisplayMode),
    });
  }

  refs.sort((a, b) => {
    const byState = AUDIT_STATE_RANK[a.state] - AUDIT_STATE_RANK[b.state];
    return byState !== 0 ? byState : b.weight - a.weight;
  });
  return refs;
}

/**
 * Read the run's host / effective-throttling environment from the LHR (PRD §6
 * Phase 8). `benchmarkIndex` + `hostUserAgent` come from `lhr.environment`; the
 * *effective* throttling method + CPU multiplier Lighthouse actually applied come
 * from `lhr.configSettings` (the resolved config, not just the flags we passed).
 * Pure and tolerant of absent fields.
 */
export function parseEnvironment(lhr: LighthouseResult): RunEnvironment {
  const environment = isRecord(lhr.environment) ? lhr.environment : {};
  const configSettings = isRecord(lhr.configSettings) ? lhr.configSettings : {};
  const throttling = isRecord(configSettings.throttling)
    ? configSettings.throttling
    : {};

  return {
    benchmarkIndex: asNumber(environment.benchmarkIndex),
    hostUserAgent: asString(environment.hostUserAgent) ?? "",
    throttlingMethod: asString(configSettings.throttlingMethod) ?? "",
    cpuSlowdownMultiplier: asNumber(throttling.cpuSlowdownMultiplier),
  };
}

/**
 * Pure transform from a raw LHR into our contract (minus the raw `lhr`).
 * No Chrome, no I/O — unit-testable in isolation. Tolerates field-name variance
 * across Lighthouse versions.
 */
export function parseLhr(
  lhr: LighthouseResult,
  formFactor: FormFactor,
): Omit<SingleRunResult, "lhr"> {
  const requestedUrl =
    pickString(lhr, "requestedUrl", "mainDocumentUrl") ?? "";
  const finalUrl = pickString(lhr, "finalDisplayedUrl", "finalUrl") ?? "";
  const fetchTime = pickString(lhr, "fetchTime") ?? "";
  const lighthouseVersion = pickString(lhr, "lighthouseVersion") ?? "";

  const runWarnings = Array.isArray(lhr.runWarnings)
    ? lhr.runWarnings.filter((w): w is string => typeof w === "string")
    : [];

  return {
    requestedUrl,
    finalUrl,
    fetchTime,
    lighthouseVersion,
    formFactor,
    scores: parseScores(lhr),
    metrics: parseMetrics(lhr),
    opportunities: parseOpportunities(lhr),
    bestPractices: parseCategoryAudits(lhr, "best-practices"),
    runWarnings,
    environment: parseEnvironment(lhr),
  };
}
