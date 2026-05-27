/**
 * Score-band legend (PRD §6 Phase 11 — Full-bleed density & wide-screen reclaim).
 *
 * A compact, instrument-key style legend for the three Lighthouse score bands —
 * good / average / poor — mirroring the footer legend pattern. Pure and
 * server-safe (no `"use client"`, no hooks): just maps the shared band tokens to
 * a swatch + a mono numeric-range label. Colour is never the only signal — the
 * range text carries the meaning for non-colour and assistive contexts.
 */

import { scoreBandSolidClass, type ScoreBand } from "@/lib/scores";
import { cn } from "@/lib/utils";

/** The three meaningful bands with their inclusive 0–100 ranges, in score order. */
const BANDS: ReadonlyArray<{ band: ScoreBand; range: string }> = [
  { band: "good", range: "90–100" },
  { band: "average", range: "50–89" },
  { band: "poor", range: "0–49" },
];

interface ScoreBandLegendProps {
  className?: string;
}

/**
 * Horizontal key of the three score bands: a solid token-coloured swatch plus a
 * mono uppercase range label. Shares the `scoreBandSolidClass` source of truth
 * with the rings/pills so the legend can never drift from the actual bands.
 */
export function ScoreBandLegend({ className }: ScoreBandLegendProps) {
  return (
    <ul
      aria-label="Score band legend"
      className={cn(
        "flex list-none items-center gap-3 p-0 font-mono text-[0.65rem] uppercase tracking-[0.16em] text-muted-foreground",
        className,
      )}
    >
      {BANDS.map(({ band, range }) => (
        <li key={band} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn("size-2 rounded-[3px]", scoreBandSolidClass(band))}
          />
          <span className="tabular-nums">
            {band} {range}
          </span>
        </li>
      ))}
    </ul>
  );
}
