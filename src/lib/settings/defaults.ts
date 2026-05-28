/**
 * Persisted audit defaults — the shared contract for Phase 7 settings persistence.
 *
 * A single, validated bag of the settings worth remembering between visits:
 * default device / runs / concurrency / categories (the New Audit form) and the
 * per-category pass thresholds (the Batch Summary view). The *store* is the
 * browser hook {@link file://../../hooks/useAuditDefaults.ts}; this module owns
 * the pure, runtime-free shape, its defaults, and the normaliser that turns an
 * untrusted `localStorage` blob back into a valid {@link AuditDefaults} (every
 * field clamped/whitelisted, never throwing). Kept free of React / DOM imports
 * so it is trivially unit-testable and safe to import from server code.
 */

import {
  type DeviceSelection,
  type LighthouseCategory,
  type Throttling,
  LIGHTHOUSE_CATEGORIES,
  MAX_CPU_MULTIPLIER,
  MAX_RUNS,
  MIN_CPU_MULTIPLIER,
  MIN_RUNS,
} from "@/lib/lighthouse/types";
import {
  clampConcurrency,
  DEFAULT_CONCURRENCY,
} from "@/lib/queue/types";
import { GOOD_THRESHOLD } from "@/lib/scores";

/** Per-category pass threshold (0–100). A score ≥ threshold passes. */
export type CategoryThresholds = Record<LighthouseCategory, number>;

/** Preferred results layout: a dense table (default) or the ring-card grid. */
export type ResultsView = "table" | "cards";

/** The full set of remembered audit defaults. */
export interface AuditDefaults {
  /**
   * Default device selection for a new audit (PRD §6 Phase 12). Widened from a
   * single {@link FormFactor} to a {@link DeviceSelection} so `"both"` (audit each
   * URL on mobile AND desktop) can be remembered like any other device choice.
   */
  formFactor: DeviceSelection;
  /** Default throttling method (simulated = Lantern, applied = DevTools). */
  throttling: Throttling;
  /** Default median-of-N runs (MIN_RUNS..MAX_RUNS). */
  runs: number;
  /** Default queue concurrency (clamped to the allowed band). */
  concurrency: number;
  /**
   * When true, force effective concurrency to 1 if Performance is in scope, for
   * DevTools-panel parity (PRD §6 Phase 9). Does not change `concurrency` itself.
   */
  accuracyMode: boolean;
  /** Default selected categories (non-empty; canonical order). */
  categories: LighthouseCategory[];
  /**
   * Default CPU slowdown multiplier (MIN_CPU_MULTIPLIER..MAX_CPU_MULTIPLIER).
   * Omitted = Lighthouse's own 4× — exactly what the DevTools panel uses.
   */
  cpuSlowdownMultiplier?: number;
  /**
   * Preferred layout for live results + History: the dense `table` (default) or
   * the ring-`card` grid (PRD §6 Phase 11). Remembered across visits.
   */
  resultsView: ResultsView;
  /** Per-category pass thresholds for the Batch Summary view. */
  thresholds: CategoryThresholds;
}

/** Every category defaults to the "good" bar (90). */
export const DEFAULT_THRESHOLDS: CategoryThresholds = {
  performance: GOOD_THRESHOLD,
  accessibility: GOOD_THRESHOLD,
  "best-practices": GOOD_THRESHOLD,
  seo: GOOD_THRESHOLD,
};

/** Factory defaults: mobile / simulated / 3 runs / default concurrency / all categories / 90s. */
export const DEFAULT_AUDIT_DEFAULTS: AuditDefaults = {
  formFactor: "mobile",
  throttling: "simulated",
  runs: 3,
  concurrency: DEFAULT_CONCURRENCY,
  accuracyMode: false,
  categories: [...LIGHTHOUSE_CATEGORIES],
  // cpuSlowdownMultiplier intentionally omitted → Lighthouse's 4× default.
  resultsView: "table",
  thresholds: { ...DEFAULT_THRESHOLDS },
};

/**
 * The Chrome DevTools Lighthouse panel's defaults, as a patch over
 * {@link AuditDefaults} (PRD §6 Phase 9). A run created from these — mobile ·
 * simulated · 1 run · concurrency 1 · accuracy mode — is directly comparable to a
 * panel run on the same machine. `cpuSlowdownMultiplier` is reset to `undefined`
 * so Lighthouse's own 4× applies (exactly what the panel uses), clearing any
 * previously-calibrated multiplier when the preset is applied.
 */
export const MATCH_DEVTOOLS_PRESET: Partial<AuditDefaults> = {
  formFactor: "mobile",
  throttling: "simulated",
  runs: 1,
  concurrency: 1,
  accuracyMode: true,
  cpuSlowdownMultiplier: undefined,
};

/**
 * `localStorage` key. Versioned so a future shape change can't crash on a stale
 * blob — bump the suffix and old data is simply ignored (normaliser falls back).
 * v2 added throttling / accuracyMode / cpuSlowdownMultiplier (Phase 9).
 * v3 added resultsView (Phase 11).
 * v4 widened formFactor to DeviceSelection — it can now hold "both" (Phase 12).
 */
export const SETTINGS_STORAGE_KEY = "lighthouse:audit-defaults:v4";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Clamp a score-like value to an integer in 0–100; non-numbers → fallback. */
export function clampScore(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Clamp a runs value to an integer in MIN_RUNS..MAX_RUNS; otherwise fallback. */
export function clampRuns(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_RUNS, Math.max(MIN_RUNS, Math.round(value)));
}

/**
 * Clamp a CPU-multiplier value to an integer in MIN..MAX_CPU_MULTIPLIER, or
 * `undefined` for any non-number — so an absent/garbage value degrades to "use
 * Lighthouse's 4× default" rather than a forced multiplier.
 */
export function clampCpuMultiplier(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_CPU_MULTIPLIER, Math.max(MIN_CPU_MULTIPLIER, Math.round(value)));
}

/** Keep only valid categories, in canonical order, never empty (→ all). */
export function sanitizeCategories(value: unknown): LighthouseCategory[] {
  if (!Array.isArray(value)) return [...LIGHTHOUSE_CATEGORIES];
  const set = new Set(value);
  const kept = LIGHTHOUSE_CATEGORIES.filter((c) => set.has(c));
  return kept.length > 0 ? kept : [...LIGHTHOUSE_CATEGORIES];
}

/** Build a full thresholds record, clamping each category and filling gaps with 90. */
export function sanitizeThresholds(value: unknown): CategoryThresholds {
  const source = isRecord(value) ? value : {};
  return LIGHTHOUSE_CATEGORIES.reduce((acc, category) => {
    acc[category] = clampScore(source[category], DEFAULT_THRESHOLDS[category]);
    return acc;
  }, {} as CategoryThresholds);
}

/**
 * Turn an untrusted value (e.g. a parsed `localStorage` blob, or a partial patch
 * merged over the current defaults) into a fully-valid {@link AuditDefaults}.
 * Every field is clamped/whitelisted against the engine's own bounds; unknown or
 * malformed input degrades to the factory default for that field. Never throws.
 */
export function normalizeDefaults(raw: unknown): AuditDefaults {
  const source = isRecord(raw) ? raw : {};
  // Widened to DeviceSelection (Phase 12): "desktop" / "both" pass through,
  // anything else (including legacy/garbage) coerces to "mobile".
  const formFactor: DeviceSelection =
    source.formFactor === "desktop"
      ? "desktop"
      : source.formFactor === "both"
        ? "both"
        : "mobile";
  const throttling: Throttling =
    source.throttling === "applied" ? "applied" : "simulated";
  return {
    formFactor,
    throttling,
    runs: clampRuns(source.runs, DEFAULT_AUDIT_DEFAULTS.runs),
    concurrency:
      typeof source.concurrency === "number" &&
      Number.isFinite(source.concurrency)
        ? clampConcurrency(source.concurrency)
        : DEFAULT_AUDIT_DEFAULTS.concurrency,
    accuracyMode: source.accuracyMode === true,
    categories: sanitizeCategories(source.categories),
    cpuSlowdownMultiplier: clampCpuMultiplier(source.cpuSlowdownMultiplier),
    resultsView: source.resultsView === "cards" ? "cards" : "table",
    thresholds: sanitizeThresholds(source.thresholds),
  };
}

/** Serialize defaults for storage (stable JSON). */
export function serializeDefaults(defaults: AuditDefaults): string {
  return JSON.stringify(defaults);
}
