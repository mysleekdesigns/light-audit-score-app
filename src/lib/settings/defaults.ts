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
  type FormFactor,
  type LighthouseCategory,
  LIGHTHOUSE_CATEGORIES,
  MAX_RUNS,
  MIN_RUNS,
} from "@/lib/lighthouse/types";
import {
  clampConcurrency,
  DEFAULT_CONCURRENCY,
} from "@/lib/queue/types";
import { GOOD_THRESHOLD } from "@/lib/scores";

/** Per-category pass threshold (0–100). A score ≥ threshold passes. */
export type CategoryThresholds = Record<LighthouseCategory, number>;

/** The full set of remembered audit defaults. */
export interface AuditDefaults {
  /** Default emulated device for a new audit. */
  formFactor: FormFactor;
  /** Default median-of-N runs (MIN_RUNS..MAX_RUNS). */
  runs: number;
  /** Default queue concurrency (clamped to the allowed band). */
  concurrency: number;
  /** Default selected categories (non-empty; canonical order). */
  categories: LighthouseCategory[];
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

/** Factory defaults: mobile / 3 runs / default concurrency / all categories / 90s. */
export const DEFAULT_AUDIT_DEFAULTS: AuditDefaults = {
  formFactor: "mobile",
  runs: 3,
  concurrency: DEFAULT_CONCURRENCY,
  categories: [...LIGHTHOUSE_CATEGORIES],
  thresholds: { ...DEFAULT_THRESHOLDS },
};

/**
 * `localStorage` key. Versioned so a future shape change can't crash on a stale
 * blob — bump the suffix and old data is simply ignored (normaliser falls back).
 */
export const SETTINGS_STORAGE_KEY = "lighthouse:audit-defaults:v1";

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
  const formFactor: FormFactor =
    source.formFactor === "desktop" ? "desktop" : "mobile";
  return {
    formFactor,
    runs: clampRuns(source.runs, DEFAULT_AUDIT_DEFAULTS.runs),
    concurrency:
      typeof source.concurrency === "number" &&
      Number.isFinite(source.concurrency)
        ? clampConcurrency(source.concurrency)
        : DEFAULT_AUDIT_DEFAULTS.concurrency,
    categories: sanitizeCategories(source.categories),
    thresholds: sanitizeThresholds(source.thresholds),
  };
}

/** Serialize defaults for storage (stable JSON). */
export function serializeDefaults(defaults: AuditDefaults): string {
  return JSON.stringify(defaults);
}
