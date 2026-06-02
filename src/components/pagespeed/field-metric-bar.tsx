/**
 * Field-data primitives for the PageSpeed Insights panel.
 *
 *  - {@link FieldAssessmentChip} — a FAST/AVERAGE/SLOW assessment pill, reused on
 *    result cards and as the field-section header.
 *  - {@link FieldMetricBar} — one CrUX metric: its p75 value plus the
 *    good / needs-improvement / poor distribution as a 3-segment bar.
 *
 * Colours come straight from the shared score bands (`scores.ts`) via
 * `field-metrics.ts`, so real-world field data reads in the same green/amber/red
 * language as the lab score rings — no new tokens.
 */

import type {
  FieldCategory,
  FieldMetric,
  FieldMetricId,
} from "@/lib/lighthouse/types";
import {
  FIELD_CATEGORY_BAND,
  FIELD_CATEGORY_LABEL,
  FIELD_METRIC_META,
} from "@/lib/pagespeed/field-metrics";
import {
  scoreBandChipClass,
  scoreBandSolidClass,
  scoreTextClass,
  type ScoreBand,
} from "@/lib/scores";
import { cn } from "@/lib/utils";

/** PSI returns the histogram buckets in good → needs-improvement → poor order. */
const SEGMENT_BANDS: readonly ScoreBand[] = ["good", "average", "poor"];

/** A FAST/AVERAGE/SLOW assessment pill (a dot + band-coloured label). */
export function FieldAssessmentChip({
  category,
  className,
}: {
  category: FieldCategory | null;
  className?: string;
}) {
  if (!category) return null;
  const band = FIELD_CATEGORY_BAND[category];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5",
        "font-mono text-[0.6rem] uppercase tracking-[0.14em]",
        scoreBandChipClass(band),
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", scoreBandSolidClass(band))} />
      {FIELD_CATEGORY_LABEL[category]}
    </span>
  );
}

/** One CrUX metric: abbreviation + label, the p75 value, and a distribution bar. */
export function FieldMetricBar({
  id,
  metric,
}: {
  id: FieldMetricId;
  metric: FieldMetric;
}) {
  const meta = FIELD_METRIC_META[id];
  const band = FIELD_CATEGORY_BAND[metric.category];
  const value = meta.format(metric.percentile);

  const pct = (proportion: number): number => Math.round(proportion * 100);
  const distLabel = metric.distributions
    .map((d, i) => `${["good", "needs improvement", "poor"][i] ?? "?"} ${pct(d.proportion)}%`)
    .join(", ");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-[0.6rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {meta.abbr}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {meta.label}
          </span>
        </div>
        <span
          className={cn(
            "shrink-0 font-mono text-sm font-medium tabular-nums",
            scoreTextClass(band),
          )}
          title="75th percentile of real users (CrUX, trailing 28 days)"
        >
          {value}
        </span>
      </div>
      <div
        className="flex h-1.5 overflow-hidden rounded-full bg-muted/40"
        role="img"
        aria-label={`${meta.label} p75 ${value} — ${distLabel}`}
      >
        {metric.distributions.map((d, i) => (
          <span
            key={i}
            className={cn("h-full", scoreBandSolidClass(SEGMENT_BANDS[i] ?? "none"))}
            style={{ width: `${pct(d.proportion)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
