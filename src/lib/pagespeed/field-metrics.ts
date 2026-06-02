/**
 * Presentation metadata for CrUX field metrics — the field-data counterpart to
 * `src/lib/scores.ts`'s `METRIC_META`. Pure (no React) so it's shared by the
 * field-data components and unit-testable.
 *
 * `FieldCategory` (FAST/AVERAGE/SLOW) maps onto the same good/average/poor score
 * bands the rest of the console uses, so field colours can never drift from the
 * lab score rings/pills.
 */

import type { FieldCategory, FieldMetricId } from "@/lib/lighthouse/types";
import type { ScoreBand } from "@/lib/scores";

/** CrUX assessment band → shared score band (drives `scoreTextClass` etc.). */
export const FIELD_CATEGORY_BAND: Record<FieldCategory, ScoreBand> = {
  FAST: "good",
  AVERAGE: "average",
  SLOW: "poor",
};

/** Human label for an assessment band. */
export const FIELD_CATEGORY_LABEL: Record<FieldCategory, string> = {
  FAST: "Good",
  AVERAGE: "Needs improvement",
  SLOW: "Poor",
};

/** Format a millisecond value as "x ms" / "x.y s". */
function formatMs(value: number): string {
  if (value >= 1000) {
    const seconds = value / 1000;
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  }
  return `${Math.round(value)} ms`;
}

export interface FieldMetricMeta {
  label: string;
  abbr: string;
  /** True for the three headline Core Web Vitals (LCP, INP, CLS). */
  coreWebVital: boolean;
  /**
   * Format the RAW PSI percentile for display. PSI reports CLS ×100 (e.g. `20`),
   * so the CLS formatter divides by 100; timing metrics are milliseconds.
   */
  format: (percentile: number) => string;
}

export const FIELD_METRIC_META: Record<FieldMetricId, FieldMetricMeta> = {
  LARGEST_CONTENTFUL_PAINT_MS: {
    label: "Largest Contentful Paint",
    abbr: "LCP",
    coreWebVital: true,
    format: formatMs,
  },
  INTERACTION_TO_NEXT_PAINT: {
    label: "Interaction to Next Paint",
    abbr: "INP",
    coreWebVital: true,
    format: (v) => `${Math.round(v)} ms`,
  },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: {
    label: "Cumulative Layout Shift",
    abbr: "CLS",
    coreWebVital: true,
    format: (v) => (v / 100).toFixed(2),
  },
  FIRST_CONTENTFUL_PAINT_MS: {
    label: "First Contentful Paint",
    abbr: "FCP",
    coreWebVital: false,
    format: formatMs,
  },
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: {
    label: "Time to First Byte",
    abbr: "TTFB",
    coreWebVital: false,
    format: formatMs,
  },
};

/** Display order: the three Core Web Vitals first, then the supporting metrics. */
export const FIELD_METRIC_DISPLAY_ORDER: readonly FieldMetricId[] = [
  "LARGEST_CONTENTFUL_PAINT_MS",
  "INTERACTION_TO_NEXT_PAINT",
  "CUMULATIVE_LAYOUT_SHIFT_SCORE",
  "FIRST_CONTENTFUL_PAINT_MS",
  "EXPERIMENTAL_TIME_TO_FIRST_BYTE",
] as const;
