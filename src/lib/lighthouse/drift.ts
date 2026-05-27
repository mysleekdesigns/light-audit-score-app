/**
 * Environment drift detection (PRD §6 Phase 10 — "Drift warning").
 *
 * A Lighthouse score is only comparable when the *host* matched what the
 * throttling targeted. Three things make a local score drift from the DevTools
 * panel / a true mid-tier phone, and this pure module detects all three from the
 * environment data the engine already captures (`benchmarkIndex` per run + the
 * effective CPU multiplier + the concurrency the batch ran at):
 *
 *  1. **Host-power drift** — the default 4× CPU throttle only re-targets mid-tier
 *     mobile *from a high-end desktop*. On a faster host (e.g. Apple-Silicon,
 *     benchmarkIndex ~4000) 4× under-throttles, so Performance reads optimistically;
 *     on a slow/over-multiplied host it reads pessimistically. We compare the
 *     *applied* multiplier to {@link recommendCpuMultiplier} and flag a wide gap.
 *  2. **CPU contention (spread)** — a wide `benchmarkIndex` spread across a batch's
 *     runs means the host was loaded or thermally throttled during some of them, so
 *     those runs' Performance is unstable / depressed.
 *  3. **Concurrency contention** — running >1 audit in parallel (our throughput
 *     default 3) contends for CPU during the unthrottled trace simulated throttling
 *     derives from, deflating Performance vs a solo run.
 *
 * Drift only matters for the Performance category, so callers pass whether it was
 * in scope. No I/O, no React — unit-testable, safe on client or server.
 */

import {
  calibrationFor,
  type Calibration,
} from "@/lib/lighthouse/calibrate";
import { LIGHTHOUSE_DEFAULT_MULTIPLIER } from "@/lib/lighthouse/environment-format";

/**
 * Absolute gap (in ×) between the applied and recommended CPU multiplier that
 * counts as host-power drift. A high-end desktop (recommended 4×) at the default
 * 4× has gap 0; an Apple-Silicon Mac (recommended ~9×) at 4× has gap ~5 → flagged.
 */
export const MULTIPLIER_DRIFT_THRESHOLD = 2;

/**
 * Relative `benchmarkIndex` range ((max − min) / mean) above which a batch's runs
 * are treated as CPU-contended / thermally drifting. 0.15 = a 15% swing.
 */
export const SPREAD_WARN_RELATIVE = 0.15;

/** Spread of `benchmarkIndex` across a set of runs. */
export interface BenchmarkSpread {
  /** Number of valid (finite, > 0) benchmarkIndex values the spread is over. */
  count: number;
  min: number;
  max: number;
  mean: number;
  /** `max − min`. */
  range: number;
  /** `range / mean` — 0 when only one value. */
  relativeSpread: number;
}

/**
 * Compute the `benchmarkIndex` spread over a set of runs, ignoring null/invalid
 * values. Returns `null` when there are no valid values (nothing to report).
 */
export function benchmarkIndexSpread(
  values: ReadonlyArray<number | null | undefined>,
): BenchmarkSpread | null {
  const valid = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  if (valid.length === 0) return null;

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const mean = valid.reduce((sum, v) => sum + v, 0) / valid.length;
  const range = max - min;
  return {
    count: valid.length,
    min,
    max,
    mean,
    range,
    relativeSpread: mean > 0 ? range / mean : 0,
  };
}

/** Severity of a drift assessment, ordered none < info < warn. */
export type DriftSeverity = "none" | "info" | "warn";

export interface AssessDriftInput {
  /**
   * `benchmarkIndex` values across the runs being assessed — the per-run indices
   * of a single audit, or one-per-URL across a batch. Nulls are ignored.
   */
  benchmarkIndices: ReadonlyArray<number | null | undefined>;
  /** Effective CPU multiplier applied; null/undefined = Lighthouse's 4× default. */
  cpuSlowdownMultiplier?: number | null;
  /** Effective concurrency the batch ran at (>1 = parallel Chromes). */
  concurrency?: number;
  /** Whether the Performance category was in scope (drift only matters for it). */
  performanceInScope?: boolean;
}

export interface DriftAssessment {
  severity: DriftSeverity;
  /** Plain-English reasons, ordered most→least important. Empty when `severity` is "none". */
  reasons: string[];
  /** Calibration for the representative (mean) benchmarkIndex, or null when unknown. */
  calibration: Calibration | null;
  /** The benchmarkIndex spread, when ≥1 valid value. */
  spread: BenchmarkSpread | null;
  /** True when concurrency > 1 with Performance in scope likely deflated scores. */
  concurrencyContended: boolean;
  /** True when the applied multiplier is far from the host's recommended one. */
  powerDrift: boolean;
  /** True when the benchmarkIndex spread across runs is wide. */
  wideSpread: boolean;
}

/** The neutral, "no drift to report" assessment. */
function noDrift(
  calibration: Calibration | null,
  spread: BenchmarkSpread | null,
): DriftAssessment {
  return {
    severity: "none",
    reasons: [],
    calibration,
    spread,
    concurrencyContended: false,
    powerDrift: false,
    wideSpread: false,
  };
}

/**
 * Assess whether a run / batch's scores are likely distorted by the host
 * environment. Returns a structured assessment a UI can render as a badge accent
 * + warning copy. When `performanceInScope` is false, always returns "none"
 * (Accessibility/SEO/Best-Practices don't depend on CPU throttling).
 */
export function assessDrift(input: AssessDriftInput): DriftAssessment {
  const {
    benchmarkIndices,
    cpuSlowdownMultiplier,
    concurrency = 1,
    performanceInScope = true,
  } = input;

  const spread = benchmarkIndexSpread(benchmarkIndices);
  const calibration = calibrationFor(spread ? spread.mean : null);

  if (!performanceInScope) return noDrift(calibration, spread);

  const reasons: string[] = [];

  // 1. Host-power drift: applied multiplier far from what this host needs.
  const appliedMultiplier =
    typeof cpuSlowdownMultiplier === "number" &&
    Number.isFinite(cpuSlowdownMultiplier)
      ? cpuSlowdownMultiplier
      : LIGHTHOUSE_DEFAULT_MULTIPLIER;
  let powerDrift = false;
  if (calibration) {
    const gap = calibration.recommendedMultiplier - appliedMultiplier;
    if (Math.abs(gap) >= MULTIPLIER_DRIFT_THRESHOLD) {
      powerDrift = true;
      const power = Math.round(calibration.benchmarkIndex);
      if (gap > 0) {
        // Recommended > applied → host is more powerful than the throttle targets.
        reasons.push(
          `This host (benchmark ${power}, ${calibration.deviceClassLabel.toLowerCase()}) is more powerful than the ${appliedMultiplier}× CPU throttle targets, so Performance reads optimistically. Calibrate to ~${calibration.recommendedMultiplier}× to match mid-tier mobile.`,
        );
      } else {
        // Recommended < applied → host is throttled harder than it needs.
        reasons.push(
          `The ${appliedMultiplier}× CPU throttle is heavier than this host (benchmark ${power}, ${calibration.deviceClassLabel.toLowerCase()}) needs, so Performance reads pessimistically. Calibrate to ~${calibration.recommendedMultiplier}×.`,
        );
      }
    }
  }

  // 2. CPU contention via a wide benchmarkIndex spread across runs.
  let wideSpread = false;
  if (spread && spread.count > 1 && spread.relativeSpread >= SPREAD_WARN_RELATIVE) {
    wideSpread = true;
    reasons.push(
      `Host CPU power varied ${Math.round(spread.min)}–${Math.round(spread.max)} across ${spread.count} runs — the machine was likely busy or thermally throttled, so these scores are unstable.`,
    );
  }

  // 3. Concurrency contention — parallel Chromes deflate Performance.
  const concurrencyContended = concurrency > 1;
  if (concurrencyContended) {
    reasons.push(
      `Ran at concurrency ${concurrency} — parallel Chrome instances contend for CPU during the trace simulated throttling derives from, deflating Performance. Re-run with accuracy mode (concurrency 1) for a trustworthy Performance score.`,
    );
  }

  const severity: DriftSeverity = reasons.length > 0 ? "warn" : "none";
  return {
    severity,
    reasons,
    calibration,
    spread,
    concurrencyContended,
    powerDrift,
    wideSpread,
  };
}
