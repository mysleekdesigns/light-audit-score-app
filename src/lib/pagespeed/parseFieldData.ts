/**
 * Map PSI's CrUX field-data objects (`loadingExperience` /
 * `originLoadingExperience`) into the project's {@link FieldData} contract.
 *
 * Pure & tolerant: low-traffic URLs/origins return only the metrics that met
 * CrUX's data threshold (possibly none), in which case the experience — or the
 * whole {@link FieldData} — is `undefined` so the UI can show an empty state.
 * Reuses the shared LHR narrowing helpers (no Chrome imports).
 */

import { asNumber, isRecord } from "@/lib/lighthouse/parseLhr";
import type {
  FieldCategory,
  FieldData,
  FieldExperience,
  FieldMetric,
  FieldMetricId,
} from "@/lib/lighthouse/types";

/** CrUX metric ids we surface (deprecated FIRST_INPUT_DELAY_MS intentionally omitted). */
const FIELD_METRIC_IDS: readonly FieldMetricId[] = [
  "LARGEST_CONTENTFUL_PAINT_MS",
  "INTERACTION_TO_NEXT_PAINT",
  "CUMULATIVE_LAYOUT_SHIFT_SCORE",
  "FIRST_CONTENTFUL_PAINT_MS",
  "EXPERIMENTAL_TIME_TO_FIRST_BYTE",
] as const;

function toFieldCategory(value: unknown): FieldCategory | null {
  return value === "FAST" || value === "AVERAGE" || value === "SLOW"
    ? value
    : null;
}

function parseMetric(raw: unknown): FieldMetric | undefined {
  if (!isRecord(raw)) return undefined;
  const percentile = asNumber(raw.percentile);
  const category = toFieldCategory(raw.category);
  if (percentile === null || category === null) return undefined;

  const distributions = Array.isArray(raw.distributions)
    ? raw.distributions.flatMap((d) => {
        if (!isRecord(d)) return [];
        return [
          {
            min: asNumber(d.min) ?? 0,
            max: asNumber(d.max),
            proportion: asNumber(d.proportion) ?? 0,
          },
        ];
      })
    : [];

  return { percentile, category, distributions };
}

/**
 * Parse one CrUX loading-experience object. Returns `undefined` when it carries
 * neither an overall assessment nor any usable metric (insufficient field data).
 */
export function parseFieldExperience(raw: unknown): FieldExperience | undefined {
  if (!isRecord(raw)) return undefined;
  const metricsRaw = isRecord(raw.metrics) ? raw.metrics : {};

  const metrics: Partial<Record<FieldMetricId, FieldMetric>> = {};
  for (const id of FIELD_METRIC_IDS) {
    const metric = parseMetric(metricsRaw[id]);
    if (metric) metrics[id] = metric;
  }

  const overallCategory = toFieldCategory(raw.overall_category);
  if (overallCategory === null && Object.keys(metrics).length === 0) {
    return undefined;
  }
  return { overallCategory, metrics };
}

/**
 * Build {@link FieldData} from PSI's URL-level and origin-level experiences.
 * Returns `undefined` when neither has data.
 */
export function parseFieldData(
  loadingExperience: unknown,
  originLoadingExperience: unknown,
): FieldData | undefined {
  const url = parseFieldExperience(loadingExperience);
  const origin = parseFieldExperience(originLoadingExperience);
  if (!url && !origin) return undefined;
  return { url, origin };
}
