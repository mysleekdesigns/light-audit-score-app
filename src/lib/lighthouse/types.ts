/**
 * Shared contract for the Lighthouse engine (PRD §6 Phase 1).
 *
 * This is the stable seam every engine module codes against:
 *  - `options.ts`  → validates & defaults `AuditOptions`
 *  - `runAudit.ts` → produces `SingleRunResult`
 *  - `median.ts`   → produces `AuditResult` (median of N runs)
 *
 * Keep this file free of runtime/Chrome imports so it can be shared everywhere.
 */

/** Lighthouse v13 scoring categories (PWA was removed in v13). */
export type LighthouseCategory =
  | "performance"
  | "accessibility"
  | "best-practices"
  | "seo";

export const LIGHTHOUSE_CATEGORIES: readonly LighthouseCategory[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
] as const;

/** Emulated device the audit runs against. */
export type FormFactor = "mobile" | "desktop";

/**
 * User-facing throttling choice. The engine maps these to Lighthouse's
 * `throttlingMethod`: `simulated` → `"simulate"`, `applied` → `"devtools"`.
 */
export type Throttling = "simulated" | "applied";

/** Bounds for the median-of-N runs setting (PRD: default 3, range 1–5). */
export const MIN_RUNS = 1;
export const MAX_RUNS = 5;

/** Bounds for the CPU slowdown multiplier (PRD §6 Phase 8; Lighthouse default 4×). */
export const MIN_CPU_MULTIPLIER = 1;
export const MAX_CPU_MULTIPLIER = 20;

/** Validated audit configuration consumed by the engine. */
export interface AuditOptions {
  formFactor: FormFactor;
  throttling: Throttling;
  /** Categories to run; at least one. Order is not significant. */
  categories: LighthouseCategory[];
  /** Number of runs to take the median of (MIN_RUNS..MAX_RUNS). */
  runs: number;
  /**
   * CPU slowdown multiplier (MIN_CPU_MULTIPLIER..MAX_CPU_MULTIPLIER). Omitted =
   * Lighthouse's default 4×. Under `simulated` throttling it scales the
   * simulation; under `applied` it sets the real CPU interrupt rate. The biggest
   * lever on score parity with the DevTools panel relative to host power
   * (`benchmarkIndex`) — see PRD §3 host-parity finding.
   */
  cpuSlowdownMultiplier?: number;
}

/** Category id → 0–100 score (Lighthouse reports 0–1; we normalise to 0–100), or null if unscored. */
export type CategoryScores = Partial<Record<LighthouseCategory, number | null>>;

/** Metric audit ids surfaced as Core Web Vitals / key timings (PRD: LCP, CLS, TBT, FCP, SI, TTI). */
export type MetricId =
  | "largest-contentful-paint"
  | "cumulative-layout-shift"
  | "total-blocking-time"
  | "first-contentful-paint"
  | "speed-index"
  | "interactive";

export const METRIC_IDS: readonly MetricId[] = [
  "largest-contentful-paint",
  "cumulative-layout-shift",
  "total-blocking-time",
  "first-contentful-paint",
  "speed-index",
  "interactive",
] as const;

/** A single metric's value as parsed from the LHR. */
export interface MetricValue {
  /** Raw numeric value (ms for timings, unitless for CLS); null if missing. */
  numericValue: number | null;
  /** Human-readable value, e.g. "2.3 s" / "0.01". */
  displayValue: string;
  /** 0–1 metric score, or null if the metric is not scored in this run. */
  score: number | null;
}

/**
 * Core Web Vitals / key timings keyed by audit id. A value may be null when the
 * audit is absent in this Lighthouse version (e.g. `interactive`/TTI in v13).
 */
export type CoreWebVitals = Record<MetricId, MetricValue | null>;

/** A performance opportunity / diagnostic extracted from the LHR. */
export interface Opportunity {
  id: string;
  title: string;
  description: string;
  /** Estimated wall-clock savings in milliseconds, when Lighthouse provides it. */
  savingsMs: number | null;
  /** Human-readable summary, e.g. "Est savings of 0.45 s". */
  displayValue: string;
  /** 0–1 audit score, or null. */
  score: number | null;
}

/**
 * Raw Lighthouse Result object. Lighthouse ships no resolvable types, so we keep
 * this loose; the ambient module declaration in `src/types/lighthouse.d.ts`
 * mirrors the same shape. `computeMedianRun` consumes arrays of these.
 */
export type LighthouseResult = Record<string, unknown>;

/**
 * Host / effective-throttling environment a run executed under (PRD §6 Phase 8 —
 * the inputs to score parity with the DevTools panel). `benchmarkIndex` and
 * `hostUserAgent` are read from `lhr.environment`; the *effective* throttling
 * method + CPU multiplier Lighthouse actually applied are read from
 * `lhr.configSettings` (which reflects the resolved config, not just our flags).
 */
export interface RunEnvironment {
  /** Lighthouse host CPU/memory benchmark (`lhr.environment.benchmarkIndex`); null if absent. */
  benchmarkIndex: number | null;
  /** Host browser user agent (`lhr.environment.hostUserAgent`); "" if absent. */
  hostUserAgent: string;
  /** Effective throttling method Lighthouse ran with ("simulate" | "devtools" | "provided" | …); "" if absent. */
  throttlingMethod: string;
  /** Effective CPU slowdown multiplier applied (`lhr.configSettings.throttling.cpuSlowdownMultiplier`); null if absent. */
  cpuSlowdownMultiplier: number | null;
}

/** Result of one Lighthouse run against one URL. */
export interface SingleRunResult {
  requestedUrl: string;
  finalUrl: string;
  /** ISO timestamp from the LHR. */
  fetchTime: string;
  lighthouseVersion: string;
  formFactor: FormFactor;
  scores: CategoryScores;
  metrics: CoreWebVitals;
  opportunities: Opportunity[];
  runWarnings: string[];
  /** Host / effective-throttling environment this run executed under. */
  environment: RunEnvironment;
  /** Raw LHR for persistence and median computation. */
  lhr: LighthouseResult;
}

/** Aggregate result of N runs with the median selected (PRD: median-of-N). */
export interface AuditResult {
  requestedUrl: string;
  finalUrl: string;
  options: AuditOptions;
  /** Number of runs actually completed. */
  runs: number;
  /** The median run selected by `computeMedianRun`. */
  median: {
    scores: CategoryScores;
    metrics: CoreWebVitals;
    opportunities: Opportunity[];
    lhr: LighthouseResult;
  };
  /** Per-run category scores (length === runs) for surfacing spread/variance. */
  perRunScores: CategoryScores[];
  /** ISO timestamp of the median run. */
  fetchTime: string;
  lighthouseVersion: string;
  /** Deduped warnings collected across runs. */
  runWarnings: string[];
  /** Host / effective-throttling environment the median run executed under. */
  environment: RunEnvironment;
}

/** Signature: run Lighthouse once against a URL with already-validated options. */
export type RunSingleAudit = (
  url: string,
  options: AuditOptions,
) => Promise<SingleRunResult>;

/** Signature: run N times and return the median (options must be pre-validated). */
export type RunAudit = (
  url: string,
  options: AuditOptions,
) => Promise<AuditResult>;
