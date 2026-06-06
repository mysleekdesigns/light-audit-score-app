"use client";

import { Line, LineChart } from "recharts";

import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { LIGHTHOUSE_CATEGORIES, type LighthouseCategory } from "@/lib/lighthouse/types";
import {
  CATEGORY_LABELS,
  CATEGORY_SHORT_LABELS,
  formatScore,
  scoreColorClass,
} from "@/lib/scores";
import { cn } from "@/lib/utils";
import type { ScoreTrendPoint } from "@/lib/compare/diff";

/** Sparklines inherit the score colour via `currentColor`, so config is minimal. */
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
  const colorClass = scoreColorClass(latest);

  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border/60 bg-card/40 px-3 py-2.5"
      aria-label={`${CATEGORY_LABELS[category]} trend, latest score ${formatScore(latest)}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
          {CATEGORY_SHORT_LABELS[category]}
        </span>
        <span
          className={cn("font-mono text-sm font-medium tabular-nums", colorClass)}
        >
          {formatScore(latest)}
        </span>
      </div>
      <ChartContainer
        config={SPARK_CONFIG}
        className={cn("aspect-auto h-8 w-full", colorClass)}
      >
        <LineChart
          data={series}
          margin={{ top: 2, right: 2, left: 2, bottom: 2 }}
        >
          <Line
            dataKey="value"
            type="monotone"
            stroke="currentColor"
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
 * A row of four compact per-category sparklines (Perf / A11y / BP / SEO),
 * each labelled and showing its latest value coloured by score band. Satisfies
 * the PRD's "trend sparklines per URL over time".
 */
export function ScoreSparklines({ data }: ScoreSparklinesProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {LIGHTHOUSE_CATEGORIES.map((category) => (
        <Sparkline key={category} category={category} data={data} />
      ))}
    </div>
  );
}
