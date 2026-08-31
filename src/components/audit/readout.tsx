"use client";

/**
 * Shared "instrument readout" primitives for the audit input card.
 *
 * Both halves of the card end in one of these bezels — Run config's calibration
 * strip and the crawl tab's discovery summary — so they are defined once here
 * rather than twice with drifting padding and type scales. Purely presentational:
 * a bezel, a row of labelled metric cells, and a monospace footnote.
 *
 * Consumers own their *outer* arrangement (Run config trails its actions to the
 * right at wide widths; the crawl summary stacks), so {@link Readout} takes a
 * className and only fixes the surface itself.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Value emphasis. `good` reads as satisfied/nominal, `warn` as worth a look. */
export type ReadoutTone = "default" | "good" | "warn";

const TONE_CLASS: Record<ReadoutTone, string> = {
  default: "text-foreground",
  good: "text-score-good",
  warn: "text-score-average",
};

/** The bezel: a hairline surface that reads as an instrument face. */
export function Readout({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Row of metric cells. Wraps rather than shrinking any cell below its value. */
export function ReadoutCells({
  className,
  children,
}: {
  /**
   * Optional layout override. Wrapping packs cells at their natural width, which
   * leaves a ragged gap on a narrow strip — a caller with enough cells to fill a
   * phone can swap in a grid here for the widths where that reads better.
   */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-6 gap-y-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One labelled metric: monospace micro-cap over a tabular value. */
export function ReadoutCell({
  icon,
  label,
  value,
  tone = "default",
  className,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: ReadoutTone;
  /**
   * Optional per-cell layout — a caller laying its cells out as an even strip
   * rather than a wrapping row uses this to hang a divider off each one.
   */
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="flex items-center gap-1.5 font-mono text-[0.6rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-sm font-semibold tabular-nums tracking-tight",
          TONE_CLASS[tone],
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Monospace footnote under the cells — the "what this means" line. */
export function ReadoutNote({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[0.6rem] leading-relaxed tracking-[0.04em] text-pretty text-muted-foreground">
      {children}
    </p>
  );
}
