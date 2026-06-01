/**
 * Display formatters for a run's host / throttling environment (PRD §6 Phase 10).
 *
 * The environment badge and drift warning surface the same three facts — the
 * host's `benchmarkIndex` ("CPU/Memory Power"), the *effective* throttling method
 * Lighthouse ran with, and the CPU multiplier it applied. These pure helpers
 * normalise those into human strings so every surface formats them identically
 * (matching the run-config card's "Simulated" / "4×" / "Auto 4×" conventions). No
 * I/O, no React — trivially unit-testable and safe on client or server.
 */

import {
  classifyBenchmarkIndex,
  DEVICE_CLASS_LABELS,
  type DeviceClass,
} from "@/lib/lighthouse/calibrate";

/** Lighthouse's built-in CPU slowdown when no multiplier is pinned. */
export const LIGHTHOUSE_DEFAULT_MULTIPLIER = 4;

/** Em-dash placeholder for a missing/unknown value. */
const EM_DASH = "—";

/**
 * Human label for an *effective* Lighthouse throttling method string (read back
 * from `lhr.configSettings.throttlingMethod`). Lighthouse uses `"simulate"` /
 * `"devtools"` / `"provided"`; we map the first two to the same user-facing words
 * the form uses ("Simulated" / "Applied"). Unknown/empty → em-dash.
 */
export function throttlingMethodLabel(method: string | null | undefined): string {
  switch (method) {
    case "simulate":
      return "Simulated";
    case "devtools":
      return "Applied";
    case "provided":
      return "Provided";
    default:
      return method ? method : EM_DASH;
  }
}

/**
 * Human label for an applied CPU slowdown multiplier. A pinned value renders as
 * e.g. `"4×"`; a null/absent value renders as `"Auto 4×"` — exactly what the
 * DevTools panel (and Lighthouse's default) does.
 */
export function cpuMultiplierLabel(
  multiplier: number | null | undefined,
): string {
  if (typeof multiplier === "number" && Number.isFinite(multiplier)) {
    // `String(4.0) === "4"`, `String(8.5) === "8.5"` — no trailing `.0`.
    return `${String(multiplier)}×`;
  }
  return `Auto ${LIGHTHOUSE_DEFAULT_MULTIPLIER}×`;
}

/** Round a `benchmarkIndex` for display, or em-dash when missing/invalid. */
export function formatBenchmarkIndex(
  benchmarkIndex: number | null | undefined,
): string {
  if (
    typeof benchmarkIndex !== "number" ||
    !Number.isFinite(benchmarkIndex) ||
    benchmarkIndex <= 0
  ) {
    return EM_DASH;
  }
  return String(Math.round(benchmarkIndex));
}

/**
 * Device-power class label for a `benchmarkIndex` (e.g. "High-end desktop"), or
 * `null` when it's missing/invalid so callers can omit the qualifier.
 */
export function benchmarkDeviceLabel(
  benchmarkIndex: number | null | undefined,
): string | null {
  if (
    typeof benchmarkIndex !== "number" ||
    !Number.isFinite(benchmarkIndex) ||
    benchmarkIndex <= 0
  ) {
    return null;
  }
  const deviceClass: DeviceClass = classifyBenchmarkIndex(benchmarkIndex);
  return DEVICE_CLASS_LABELS[deviceClass];
}

/**
 * Extract the Chrome/Chromium version from a host user-agent string — e.g.
 * `"…Chrome/126.0.6478.127 Safari/537.36"` → `"126.0.6478.127"` — or `null` when
 * absent/unparseable. Surfaced per run because the DevTools panel bundles its own
 * Lighthouse tied to the *installed* Chrome, so a version skew between this tool's
 * Chrome and yours is a common source of category-score differences. Matches
 * `HeadlessChrome/…` too (the build chrome-launcher drives here).
 */
export function chromeVersionFromUserAgent(
  userAgent: string | null | undefined,
): string | null {
  if (typeof userAgent !== "string") return null;
  const match = /(?:HeadlessChrome|Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/.exec(
    userAgent,
  );
  return match ? match[1] : null;
}
