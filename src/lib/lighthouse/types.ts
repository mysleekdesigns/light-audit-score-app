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
 * User-facing device selection for a *batch* (PRD §6 Phase 12). `"both"` is not a
 * form factor the engine can run — it's a request-level fan-out instruction:
 * each `"both"` URL becomes two independent jobs, one per {@link FormFactor}.
 * `AuditOptions.formFactor` therefore stays a concrete {@link FormFactor}; the
 * queue resolves a `DeviceSelection` into the form factors to enqueue via
 * `resolveFormFactors` (see `options.ts`).
 */
export type DeviceSelection = FormFactor | "both";

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
  /**
   * Warm-cache mode — the lever that makes our scores match the Chrome DevTools
   * Lighthouse panel (default `true`). Each fresh-profile Lighthouse run is a
   * *cold* first visit: every asset is re-downloaded and re-parsed, which on
   * heavy JS/SPA pages delays paint and (under `simulated`/Lantern throttling)
   * inflates LCP — the standard CLI/PSI result, but far below the warm number a
   * developer sees when running the DevTools panel against a page they already
   * have cached. When `true`, `median.ts` runs one **discarded warm-up
   * navigation** to populate a *reused* Chrome profile, then takes the measured
   * runs against that warm profile with Lighthouse's storage reset disabled
   * (`disableStorageReset`) so the cache survives — i.e. repeat-visit
   * performance, matching the panel. Set `false` for the strict cold first-visit
   * measurement (Lighthouse/PageSpeed-Insights default).
   */
  warmCache: boolean;
  /**
   * Optional override for the emulated page user agent — a parity lever for
   * bot-sensitive sites (e.g. Cloudflare-fronted apps) that serve different
   * content to an automated/headless engine, which shifts environment-sensitive
   * Best Practices audits. When omitted (`undefined`), no flag is passed and
   * Lighthouse uses its config-default device UA. A string is passed straight
   * through to Lighthouse's `emulatedUserAgent` flag so the page sees exactly
   * the UA you'd get from a real Chrome of that form factor.
   */
  emulatedUserAgent?: string;
  /**
   * Locale for the report, e.g. `"en_US"` — a PageSpeed Insights-only lever
   * (PSI's `locale` query param) that localises audit titles/descriptions. The
   * local Chrome engine ignores it (its UI strings come from the bundled
   * Lighthouse). Omitted → PSI's default locale. See `src/lib/pagespeed`.
   */
  locale?: string;
}

/**
 * Which engine produced a result (PSI feature). `"local"` = the forked-Chrome
 * Lighthouse engine; `"psi"` = Google's hosted PageSpeed Insights API. The queue,
 * persistence, and UI all carry this so a result can be attributed and field data
 * (CrUX) surfaced only for PSI. Optional/`"local"`-defaulted everywhere so every
 * pre-existing local path is unchanged.
 */
export type AuditSource = "local" | "psi";

/**
 * A caller-owned Chrome profile reused across the runs of a single audit to
 * enable {@link AuditOptions.warmCache}. Created by `createAuditSession` and
 * handed to {@link RunSingleAudit}; the *creator* owns its lifecycle (disposal),
 * so a run handed a session never deletes the profile dir.
 */
export interface AuditSession {
  /** Persistent `--user-data-dir` shared across this audit's runs (warm cache). */
  userDataDir: string;
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
 * State of a single category audit, derived from its score + `scoreDisplayMode`.
 * `informative`/`manual` audits carry no weight; `notApplicable` audits didn't
 * apply to this page. Only `passed`/`failed` (weighted) move the category score.
 */
export type AuditState = "passed" | "failed" | "notApplicable" | "informative";

/**
 * One audit within a Lighthouse category, joined from the category's `auditRefs`
 * (which carry the scoring `weight`/`group`) and the audit result itself (title,
 * description, score, display mode). Surfaced so a category score — especially
 * the environment-sensitive Best Practices one — can be explained audit-by-audit
 * (which audits passed/failed and how much weight each carries). Pure projection
 * of the LHR; see `parseCategoryAudits` in `runAudit.ts`.
 */
export interface CategoryAuditRef {
  id: string;
  title: string;
  description: string;
  /** Scoring weight from `category.auditRefs[].weight` (0 = informative/N-A). */
  weight: number;
  /** Optional audit group id from `auditRefs[].group`. */
  group?: string;
  /** 0–1 audit score, or null when unscored. */
  score: number | null;
  /** Lighthouse `scoreDisplayMode` ("binary" | "numeric" | "notApplicable" | "informative" | "manual" | "error"). */
  scoreDisplayMode: string;
  /** Human-readable value, e.g. "3 errors". */
  displayValue: string;
  /** Derived pass/fail/N-A/informative state. */
  state: AuditState;
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

// --- Field data (CrUX / PageSpeed Insights) --------------------------------

/**
 * CrUX assessment bucket for a field metric (PSI `category`): real-world 75th
 * percentile in the good / needs-improvement / poor band. Maps to the same
 * green / amber / red score tokens via `src/lib/pagespeed/field-metrics.ts`.
 */
export type FieldCategory = "FAST" | "AVERAGE" | "SLOW";

/** CrUX field metric ids as returned by PSI's `loadingExperience.metrics`. */
export type FieldMetricId =
  | "LARGEST_CONTENTFUL_PAINT_MS"
  | "INTERACTION_TO_NEXT_PAINT"
  | "CUMULATIVE_LAYOUT_SHIFT_SCORE"
  | "FIRST_CONTENTFUL_PAINT_MS"
  | "EXPERIMENTAL_TIME_TO_FIRST_BYTE";

/** One real-world field metric: the p75 value, its band, and the 3-bucket histogram. */
export interface FieldMetric {
  /**
   * 75th-percentile value as PSI reports it: milliseconds for timing metrics;
   * for `CUMULATIVE_LAYOUT_SHIFT_SCORE` PSI returns CLS×100 (e.g. `20` = 0.20),
   * normalised back to the raw CLS by the field-metrics display layer.
   */
  percentile: number;
  /** Assessment band (FAST/AVERAGE/SLOW). */
  category: FieldCategory;
  /** Good / needs-improvement / poor distribution (proportions sum ≈ 1). */
  distributions: { min: number; max: number | null; proportion: number }[];
}

/**
 * A CrUX "loading experience" — either URL-level (`loadingExperience`) or
 * origin-level (`originLoadingExperience`). Metrics are partial: a low-traffic
 * page surfaces only the metrics that met CrUX's data threshold (possibly none).
 */
export interface FieldExperience {
  /** Overall Core Web Vitals assessment for this experience; null if absent. */
  overallCategory: FieldCategory | null;
  /** Available field metrics, keyed by CrUX id (any subset, possibly empty). */
  metrics: Partial<Record<FieldMetricId, FieldMetric>>;
}

/**
 * Real-world CrUX field data attached to a PSI {@link AuditResult}. `url` is the
 * specific page's experience; `origin` is the whole origin's. Either may be
 * absent when CrUX has insufficient data — the UI degrades gracefully.
 */
export interface FieldData {
  url?: FieldExperience;
  origin?: FieldExperience;
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
  /**
   * Best Practices category audits (passed/failed/weight), surfaced so the BP
   * score can be explained audit-by-audit. Empty when best-practices wasn't run.
   */
  bestPractices: CategoryAuditRef[];
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
    /** Best Practices category audits for the median run (see {@link CategoryAuditRef}). */
    bestPractices: CategoryAuditRef[];
    lhr: LighthouseResult;
  };
  /** Per-run category scores (length === runs) for surfacing spread/variance. */
  perRunScores: CategoryScores[];
  /**
   * Per-run host/throttling environment (length === runs), parallel to
   * `perRunScores`. Surfaces the per-run `benchmarkIndex` spread (PRD §6 Phase 10)
   * so CPU-contention / thermal drift during a multi-run audit is visible, the way
   * `perRunScores` surfaces score variance.
   */
  perRunEnvironments: RunEnvironment[];
  /** ISO timestamp of the median run. */
  fetchTime: string;
  lighthouseVersion: string;
  /** Deduped warnings collected across runs. */
  runWarnings: string[];
  /** Host / effective-throttling environment the median run executed under. */
  environment: RunEnvironment;
  /**
   * Engine that produced this result. Omitted/`"local"` for the forked-Chrome
   * engine; `"psi"` for Google PageSpeed Insights. See {@link AuditSource}.
   */
  source?: AuditSource;
  /**
   * Real-world CrUX field data — present only for `source: "psi"` results when
   * CrUX has data for the URL/origin. Never set by the local engine.
   */
  field?: FieldData;
}

/**
 * Signature: run Lighthouse once against a URL with already-validated options.
 * An optional {@link AuditSession} makes the run reuse a caller-owned Chrome
 * profile with storage reset disabled (warm cache); without it the run uses a
 * fresh, self-disposed profile (cold cache). See {@link AuditOptions.warmCache}.
 */
export type RunSingleAudit = (
  url: string,
  options: AuditOptions,
  session?: AuditSession,
) => Promise<SingleRunResult>;

/** Signature: run N times and return the median (options must be pre-validated). */
export type RunAudit = (
  url: string,
  options: AuditOptions,
) => Promise<AuditResult>;
