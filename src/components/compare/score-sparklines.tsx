"use client";

import { Line, LineChart } from "recharts";

import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { TREND_CONFIG } from "@/components/compare/score-trend-chart";
import { LIGHTHOUSE_CATEGORIES, type LighthouseCategory } from "@/lib/lighthouse/types";
import {
  CATEGORY_LABELS,
  CATEGORY_SHORT_LABELS,
  formatScore,
  scoreColorClass,
} from "@/lib/scores";
import { cn } from "@/lib/utils";
import type { ScoreTrendPoint } from "@/lib/compare/diff";

/** Sparklines are drawn with an explicit series colour, so config is minimal. */
const SPARK_CONFIG = {
  value: { label: "Score" },
} satisfies ChartConfig;

interface ScoreSparklinesProps {
  data: ScoreTrendPoint[];
}

/** One compact sparkline + latest-value caption for a single category. */
function Sparkline({
  category,
  data,
}: {
  category: LighthouseCategory;
  data: ScoreTrendPoint[];
}) {
  // Project this category's series; nulls break the line via connectNulls=false.
  const series = data.map((point) => ({
    label: point.label,
    value: point[category],
  }));
  const latest = [...series].reverse().find((p) => p.value !== null)?.value ?? null;
  const seriesColor = TREND_CONFIG[category].color;

  return (
    <div
      // `role="img"` so the label is authoritative: on a bare <div>, aria-label
      // is not reliably announced, and it collapses the recharts SVG's own nodes
      // into one reading rather than leaving them as noise after it.
      role="img"
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/60 bg-card/40 px-3 py-2.5"
      aria-label={`${CATEGORY_LABELS[category]} trend, latest score ${formatScore(latest)}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
          {/* The same swatch the chart legend uses — this tile is a second
              reading of that series, not an unrelated strip. */}
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: seriesColor }}
          />
          <span className="truncate">{CATEGORY_SHORT_LABELS[category]}</span>
        </span>
        <span
          className={cn(
            "font-mono text-sm font-medium tabular-nums",
            scoreColorClass(latest),
          )}
        >
          {formatScore(latest)}
        </span>
      </div>
      <ChartContainer config={SPARK_CONFIG} className="aspect-auto h-10 w-full">
        <LineChart
          data={series}
          margin={{ top: 3, right: 2, left: 2, bottom: 3 }}
        >
          {/* Deliberately auto-scaled, unlike the chart above: that one carries
              the absolute picture against its score bands, so these are free to
              spend their 40px on the shape of the movement. */}
          <Line
            dataKey="value"
            type="monotone"
            stroke={seriesColor}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </LineChart>
      </ChartContainer>
    </div>
  );
}

/**
 * A row of compact per-category sparklines (Perf / A11y / BP / SEO / Agent),
 * each labelled with its chart-series swatch and showing its latest value
 * coloured by score band. Satisfies the PRD's "trend sparklines per URL over
 * time".
 *
 * Two columns while the card is narrow, three from `@lg`, five once it can give
 * each tile a usable trace — sized off the card's container, since this row sits
 * in a half-width column from `lg` up.
 *
 * The odd count is absorbed at the top of that progression rather than the
 * bottom: three tiles across a 310px phone card leaves ~63px of tile content,
 * which truncates the short label to a single letter and makes the swatch the
 * only thing identifying the series. So the narrowest step stays two-up and the
 * fifth tile takes the full row instead of being stranded beside an empty cell —
 * a wider sparkline being a better sparkline, this reads as the intended shape
 * rather than a gap. From `@lg` the grid divides 3-then-2 and the span is
 * released.
 */
export function ScoreSparklines({ data }: ScoreSparklinesProps) {
  return (
    <div className="grid grid-cols-2 gap-2 [&>*:last-child]:col-span-2 @lg:grid-cols-3 @lg:[&>*:last-child]:col-span-1 @2xl:grid-cols-5">
      {LIGHTHOUSE_CATEGORIES.map((category) => (
        <Sparkline key={category} category={category} data={data} />
      ))}
    </div>
  );
}
