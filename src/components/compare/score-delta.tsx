import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import type { ScoreDirection } from "@/lib/compare/diff";
import type { MetricValue } from "@/lib/lighthouse/types";
import { cn } from "@/lib/utils";

/**
 * Shared delta presentation primitives (PRD §6 Phase 6 — Comparison & trends).
 *
 * The single source of truth for how a baseline → comparison change is shown:
 * an up/down/flat arrow paired with a signed value, colour-banded green
 * (improved) / red (regressed) / muted (no change or not comparable), with the
 * direction always carried by the arrow + a screen-reader word so colour is
 * never the sole signal. Used by the Compare run-diff and the History archive's
 * per-score trend.
 */

/** Improvement / regression / neutral colour tokens — shared by every delta surface. */
export const DELTA_IMPROVED = "text-score-good";
export const DELTA_REGRESSED = "text-score-poor";
export const DELTA_NEUTRAL = "text-muted-foreground";

/** Format a signed numeric delta for display (rounded, with sign), or em dash. */
export function formatDelta(delta: number | null, fractionDigits = 0): string {
  if (delta === null) return "—";
  if (delta === 0) return "±0";
  const rounded =
    fractionDigits > 0 ? Number(delta.toFixed(fractionDigits)) : Math.round(delta);
  if (rounded === 0) return "±0";
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

/**
 * Format a Core Web Vitals delta in the same unit the row's values are shown in.
 *
 * Metric deltas are raw `numericValue` differences — milliseconds for timings —
 * so an LCP row used to read "3.4 s → 2.3 s, −1140", mixing two units inside one
 * line. The unit is recovered from Lighthouse's own `displayValue` ("2.3 s",
 * "120 ms") rather than assumed, so the delta always matches the numbers beside
 * it; CLS has no unit and keeps three decimals.
 */
export function formatMetricDelta(
  delta: number | null,
  sample: MetricValue | null,
): string {
  if (delta === null) return "—";
  const unit = sample?.displayValue?.match(/([a-z]+)\s*$/i)?.[1] ?? "";

  if (unit.toLowerCase() === "s") {
    const seconds = delta / 1000;
    const rounded = Number(seconds.toFixed(Math.abs(seconds) < 1 ? 2 : 1));
    return rounded === 0 ? "±0" : `${rounded > 0 ? "+" : ""}${rounded} s`;
  }
  if (unit) {
    const rounded = Math.round(delta);
    return rounded === 0 ? "±0" : `${rounded > 0 ? "+" : ""}${rounded} ${unit}`;
  }
  const rounded = Number(delta.toFixed(3));
  return rounded === 0 ? "±0" : `${rounded > 0 ? "+" : ""}${rounded}`;
}

/** Colour class for a delta given improvement state. */
export function deltaClass(improved: boolean | null): string {
  if (improved === null) return DELTA_NEUTRAL;
  return improved ? DELTA_IMPROVED : DELTA_REGRESSED;
}

/** Screen-reader text describing a delta's direction. */
export function deltaSrLabel(improved: boolean | null, flat: boolean): string {
  if (improved === null) return flat ? "no change" : "not comparable";
  return improved ? "improved" : "regressed";
}

/**
 * A direction arrow paired with text — colour is never the sole signal.
 *
 * The arrow follows the *number* and the colour carries the *judgement*. For
 * category scores those coincide (higher is better), so `points` can be left
 * off. For Core Web Vitals they deliberately diverge: an improved LCP is a
 * negative delta, and pairing "−1.1 s" with an up arrow read as a contradiction.
 * Passing `points="down"` there gives a green down arrow — the value fell, and
 * falling is good.
 */
export function DeltaArrow({
  improved,
  flat,
  points,
  className,
}: {
  improved: boolean | null;
  /** True when there is a real delta of exactly 0 (vs. a missing value). */
  flat: boolean;
  /** Which way the arrow points; defaults to the improvement direction. */
  points?: "up" | "down";
  className?: string;
}) {
  if (improved === null) {
    return flat ? (
      <Minus
        aria-hidden
        className={cn("size-3 shrink-0 text-muted-foreground", className)}
      />
    ) : null;
  }
  const Icon = (points ?? (improved ? "up" : "down")) === "up" ? ArrowUp : ArrowDown;
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3 shrink-0",
        improved ? DELTA_IMPROVED : DELTA_REGRESSED,
        className,
      )}
    />
  );
}

/**
 * A compact inline category-score trend — just a colour-banded up/down arrow
 * (green = improved, red = regressed). The magnitude lives in an SR-only label
 * and the optional `title` tooltip, keeping the visual to a clean direction cue.
 * Renders nothing unless the score actually moved (`up`/`down`), so dense
 * surfaces stay quiet for unchanged or first-time runs. Higher score is better →
 * up = improvement.
 */
export function ScoreDelta({
  direction,
  delta,
  className,
  title,
}: {
  direction: ScoreDirection;
  delta: number | null;
  className?: string;
  /** Optional native tooltip, e.g. the before → after values. */
  title?: string;
}) {
  if (direction !== "up" && direction !== "down") return null;
  const improved = direction === "up";
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center",
        improved ? DELTA_IMPROVED : DELTA_REGRESSED,
        className,
      )}
    >
      <DeltaArrow improved={improved} flat={false} />
      <span className="sr-only">
        {improved ? "improved" : "regressed"}
        {delta != null ? ` by ${Math.abs(delta)}` : ""}
      </span>
    </span>
  );
}
