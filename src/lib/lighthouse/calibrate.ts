/**
 * CPU-throttling calibration (PRD §6 Phase 9 — Calibration & "Match DevTools").
 *
 * Lighthouse expresses CPU throttling *relative to the host*: the default 4×
 * multiplier is tuned so a **high-end desktop** lands on the **mid-tier mobile**
 * target. On a faster or slower machine 4× drifts off that target, so a run on
 * an Apple-Silicon Mac (benchmarkIndex ~4000) is effectively under-throttled and
 * reports a higher Performance score than a true mid-tier phone would.
 *
 * This pure module maps a run's `benchmarkIndex` (Lighthouse's "CPU/Memory Power")
 * to (a) a device-class bracket and (b) a recommended `cpuSlowdownMultiplier` that
 * re-targets mid-tier mobile, using the official bracket table from Lighthouse
 * `docs/throttling.md`. No I/O, no Chrome — trivially unit-testable and safe to
 * import from client or server code.
 */

import {
  MAX_CPU_MULTIPLIER,
  MIN_CPU_MULTIPLIER,
} from "@/lib/lighthouse/types";

/** Device-power class, ordered fastest → slowest (Lighthouse `docs/throttling.md`). */
export type DeviceClass =
  | "high-end-desktop"
  | "low-end-desktop"
  | "high-end-mobile"
  | "mid-tier-mobile"
  | "low-end-mobile";

/** Human label for each device class (for UI surfaces). */
export const DEVICE_CLASS_LABELS: Record<DeviceClass, string> = {
  "high-end-desktop": "High-end desktop",
  "low-end-desktop": "Low-end desktop",
  "high-end-mobile": "High-end mobile",
  "mid-tier-mobile": "Mid-tier mobile",
  "low-end-mobile": "Low-end mobile",
};

/**
 * Lower `benchmarkIndex` cutoff (inclusive) for each class, as of Chrome m86
 * (`docs/throttling.md`). The doc's published ranges overlap; we collapse them to
 * monotonic cutoffs so every index maps to exactly one class.
 */
const DEVICE_CLASS_CUTOFFS: ReadonlyArray<[DeviceClass, number]> = [
  ["high-end-desktop", 1500],
  ["low-end-desktop", 1000],
  ["high-end-mobile", 800],
  ["mid-tier-mobile", 125],
  ["low-end-mobile", 0],
];

/**
 * The host `benchmarkIndex` that, throttled at the recommended multiplier, should
 * emulate **mid-tier mobile** (Lighthouse's mobile target). Anchored to the doc's
 * statement that the default **4×** moves a high-end desktop (bracket midpoint
 * ≈1750) into the mid-tier-mobile bracket: 1750 / 4 = 437.5. Recommending
 * `round(benchmarkIndex / 437.5)` reproduces the doc's suggested multipliers
 * (high-end desktop→4×, high-end mobile→2×, mid-tier mobile→1×).
 */
export const MID_TIER_MOBILE_BENCHMARK_INDEX = 437.5;

/** Map a `benchmarkIndex` to its device-power class. */
export function classifyBenchmarkIndex(benchmarkIndex: number): DeviceClass {
  for (const [deviceClass, cutoff] of DEVICE_CLASS_CUTOFFS) {
    if (benchmarkIndex >= cutoff) return deviceClass;
  }
  return "low-end-mobile";
}

/**
 * Recommended `cpuSlowdownMultiplier` to re-target **mid-tier mobile** from a host
 * of the given `benchmarkIndex`. Rounded to an integer and clamped into the
 * engine's [MIN..MAX]_CPU_MULTIPLIER band (so a very slow host never recommends
 * < 1×, a very fast one never exceeds the cap).
 */
export function recommendCpuMultiplier(benchmarkIndex: number): number {
  const raw = Math.round(benchmarkIndex / MID_TIER_MOBILE_BENCHMARK_INDEX);
  return Math.min(MAX_CPU_MULTIPLIER, Math.max(MIN_CPU_MULTIPLIER, raw));
}

/** Result of {@link calibrationFor}: everything a UI needs to explain a recommendation. */
export interface Calibration {
  benchmarkIndex: number;
  deviceClass: DeviceClass;
  deviceClassLabel: string;
  recommendedMultiplier: number;
}

/**
 * Full calibration for a `benchmarkIndex`, or `null` when it's missing/invalid
 * (e.g. a run that hasn't reported one yet) so callers can render a "run an audit
 * first" affordance instead of a bogus recommendation.
 */
export function calibrationFor(
  benchmarkIndex: number | null | undefined,
): Calibration | null {
  if (
    typeof benchmarkIndex !== "number" ||
    !Number.isFinite(benchmarkIndex) ||
    benchmarkIndex <= 0
  ) {
    return null;
  }
  const deviceClass = classifyBenchmarkIndex(benchmarkIndex);
  return {
    benchmarkIndex,
    deviceClass,
    deviceClassLabel: DEVICE_CLASS_LABELS[deviceClass],
    recommendedMultiplier: recommendCpuMultiplier(benchmarkIndex),
  };
}
