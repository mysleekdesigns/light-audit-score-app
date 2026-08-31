"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";
import { CATEGORY_LABELS, GOOD_THRESHOLD } from "@/lib/scores";
import type { ScoreTrendPoint } from "@/lib/compare/diff";

/**
 * Map each category to a chart line colour from the theme's `--chart-*` tokens
 * (read from globals.css; never raw hex). Labels reuse the shared category map.
 * Exported so the sparklines below the chart can draw each category in its own
 * series colour and act as a second reading of the same key.
 */
export const TREND_CONFIG = {
  performance: { label: CATEGORY_LABELS.performance, color: "var(--chart-1)" },
  accessibility: { label: CATEGORY_LABELS.accessibility, color: "var(--chart-2)" },
  "best-practices": { label: CATEGORY_LABELS["best-practices"], color: "var(--chart-3)" },
  seo: { label: CATEGORY_LABELS.seo, color: "var(--chart-4)" },
} satisfies ChartConfig;

interface ScoreTrendChartProps {
  data: ScoreTrendPoint[];
}

/**
 * X tick that pulls its text back inside the plot at the two edges, and drops to
 * the date alone while the card is narrow.
 *
 * Recharts centres every tick label on its point, and the first/last points sit
 * on the plot's edges — so half of each spilled outside the SVG and was clipped
 * ("Jun 15, 01:25 PM" lost its "M"). Anchoring the ends `start`/`end` keeps the
 * full timestamp legible without reserving dead margin on both sides. A 115px
 * timestamp still cannot survive a 240px plot, so below `@sm` only the day is
 * drawn — the exact time is a tap away in the tooltip.
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
  const full = String(payload?.value ?? "");
  // "Jun 15, 01:25 PM" → "Jun 15". Labels always carry the day first.
  const short = full.split(",")[0];
  const shared = { x, y, dy: 10, textAnchor: anchor } as const;
  return (
    <>
      <text {...shared} className="fill-muted-foreground text-[0.625rem] @sm:hidden">
        {short}
      </text>
      <text
        {...shared}
        className="hidden fill-muted-foreground text-[0.625rem] @sm:block"
      >
        {full}
      </text>
    </>
  );
}

/**
 * Multi-series time-series of the four category scores (0–100) across a URL's
 * runs, oldest → newest. Renders inside the shadcn `ChartContainer`; recharts is
 * client-only so this file is a client component.
 *
 * The Y domain stays a full 0–100 — a trend that silently rescales to its own
 * range would make a 96→97 wobble look like a cliff — and the space that honesty
 * costs is paid back by marking the 90 threshold: the passing band is tinted
 * behind the lines, so "we are in the green" is readable before any individual
 * number is.
 */
export function ScoreTrendChart({ data }: ScoreTrendChartProps) {
  return (
    <ChartContainer
      config={TREND_CONFIG}
      // `flex-1` over a floor, not a fixed height: in the stacked layout the
      // card has no spare height, so the plot settles on its minimum, and in
      // the two-column layout it takes whatever the column has left over. The
      // alternative — padding the card — puts the growth where nothing can use
      // it, and the one thing on this card worth more pixels is the plot.
      className="aspect-auto min-h-52 w-full flex-1 font-mono @lg:min-h-64"
    >
      {/* `left: 0`, not a negative inset: -8 pulled the Y axis under the SVG's
          own left edge, so every label was clipped to its last character and
          0 / 50 / 90 / 100 all read as "0". */}
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {/* Only the passing band is tinted, painted before the grid and lines so
            they sit on top. Banding all three read badly on this dark card: a 6%
            red wash over the empty bottom half of a 0–100 axis is a large, loud
            block drawing the eye to exactly where there is no data. One green
            band plus the 90 threshold says the same thing quietly, and the
            footer's score legend still carries the full scale. */}
        <ReferenceArea
          y1={GOOD_THRESHOLD}
          y2={100}
          fill="var(--score-good)"
          fillOpacity={0.09}
          ifOverflow="extendDomain"
        />
        <ReferenceLine
          y={GOOD_THRESHOLD}
          stroke="var(--score-good)"
          strokeOpacity={0.4}
          strokeDasharray="2 4"
        />
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
        {/* Four category names are wider than a phone. A 2×2 grid fills the card
            evenly instead of leaving a ragged third row of one orphaned entry. */}
        <ChartLegend
          content={
            <ChartLegendContent className="grid grid-cols-2 justify-items-start gap-x-4 gap-y-1 @sm:flex @sm:flex-wrap" />
          }
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
