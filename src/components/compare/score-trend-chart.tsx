"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";
import { CATEGORY_LABELS } from "@/lib/scores";
import type { ScoreTrendPoint } from "@/lib/compare/diff";

/**
 * Map each category to a chart line colour from the theme's `--chart-*` tokens
 * (read from globals.css; never raw hex). Labels reuse the shared category map.
 */
const TREND_CONFIG = {
  performance: { label: CATEGORY_LABELS.performance, color: "var(--chart-1)" },
  accessibility: { label: CATEGORY_LABELS.accessibility, color: "var(--chart-2)" },
  "best-practices": { label: CATEGORY_LABELS["best-practices"], color: "var(--chart-3)" },
  seo: { label: CATEGORY_LABELS.seo, color: "var(--chart-4)" },
} satisfies ChartConfig;

interface ScoreTrendChartProps {
  data: ScoreTrendPoint[];
}

/**
 * X tick that pulls its text back inside the plot at the two edges.
 *
 * Recharts centres every tick label on its point, and the first/last points sit
 * on the plot's edges — so half of each spilled outside the SVG and was clipped
 * ("Jun 15, 01:25 PM" lost its "M"). Anchoring the ends `start`/`end` keeps the
 * full timestamp legible without reserving dead margin on both sides.
 */
function EdgeTick({
  x = 0,
  y = 0,
  index = 0,
  lastIndex = 0,
  payload,
}: {
  x?: number;
  y?: number;
  index?: number;
  /** Index of the final rendered tick — injected where the tick is declared. */
  lastIndex?: number;
  payload?: { value?: string | number };
}) {
  const anchor =
    index === 0 ? "start" : index >= lastIndex ? "end" : "middle";
  return (
    <text
      x={x}
      y={y}
      dy={10}
      textAnchor={anchor}
      className="fill-muted-foreground text-[0.625rem]"
    >
      {payload?.value}
    </text>
  );
}

/**
 * Multi-series time-series of the four category scores (0–100) across a URL's
 * runs, oldest → newest. Renders inside the shadcn `ChartContainer`; recharts is
 * client-only so this file is a client component.
 */
export function ScoreTrendChart({ data }: ScoreTrendChartProps) {
  return (
    <ChartContainer
      config={TREND_CONFIG}
      className="aspect-auto h-56 w-full font-mono"
    >
      {/* `left: 0`, not a negative inset: -8 pulled the Y axis under the SVG's
          own left edge, so every label was clipped to its last character and
          0 / 50 / 90 / 100 all read as "0". */}
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          // Timestamps are ~115px wide, so leave room for a whole one between
          // ticks rather than rendering labels that collide.
          minTickGap={32}
          tick={<EdgeTick lastIndex={data.length - 1} />}
          className="text-[0.625rem]"
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 50, 90, 100]}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          // Wide enough for "100" plus its tick margin at 0.625rem.
          width={34}
          className="text-[0.625rem]"
        />
        <ChartTooltip
          content={<ChartTooltipContent className="font-mono" labelKey="label" />}
        />
        {/* Four category names are wider than a phone — wrap instead of
            overflowing the card and clipping the outer two entries. */}
        <ChartLegend
          content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />}
        />
        {LIGHTHOUSE_CATEGORIES.map((category) => (
          <Line
            key={category}
            dataKey={category}
            type="monotone"
            stroke={`var(--color-${category})`}
            strokeWidth={2}
            dot={{ r: 2.5, strokeWidth: 0, fill: `var(--color-${category})` }}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
