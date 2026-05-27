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
 * Multi-series time-series of the four category scores (0–100) across a URL's
 * runs, oldest → newest. Renders inside the shadcn `ChartContainer`; recharts is
 * client-only so this file is a client component.
 */
export function ScoreTrendChart({ data }: ScoreTrendChartProps) {
  return (
    <ChartContainer
      config={TREND_CONFIG}
      className="aspect-auto h-64 w-full font-mono"
    >
      <LineChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          className="text-[0.625rem]"
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 50, 90, 100]}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          width={28}
          className="text-[0.625rem]"
        />
        <ChartTooltip
          content={<ChartTooltipContent className="font-mono" labelKey="label" />}
        />
        <ChartLegend content={<ChartLegendContent />} />
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
