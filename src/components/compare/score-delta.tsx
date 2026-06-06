import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import type { ScoreDirection } from "@/lib/compare/diff";
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

/** A direction arrow paired with text — colour is never the sole signal. */
export function DeltaArrow({
  improved,
  flat,
  className,
}: {
  improved: boolean | null;
  /** True when there is a real delta of exactly 0 (vs. a missing value). */
  flat: boolean;
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
  const Icon = improved ? ArrowUp : ArrowDown;
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
