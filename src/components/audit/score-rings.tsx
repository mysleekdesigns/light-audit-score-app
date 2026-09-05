import { cn } from "@/lib/utils";
import { CATEGORY_SHORT_LABELS } from "@/lib/scores";
import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
} from "@/lib/lighthouse/types";

import { ScoreRing } from "./score-ring";

interface ScoreRingsProps {
  /** Category → 0–100 score. Only categories present as keys render a ring. */
  scores: CategoryScores;
  /** Ring diameter in px, forwarded to each {@link ScoreRing}. */
  size?: number;
  className?: string;
}

/**
 * A row of {@link ScoreRing} gauges — one per Lighthouse category present in
 * `scores`, rendered in canonical `LIGHTHOUSE_CATEGORIES` order so the layout is
 * stable regardless of key insertion order. Pure presentational.
 *
 * The cluster is a grid of ring-wide tracks rather than a `flex-wrap` row. Five
 * gauges no longer fit on one line in a narrow card, so the row has to break
 * either way; `repeat(auto-fit, minmax(0, <size>px))` breaks it onto tracks the
 * width of a real ring, which keeps every gauge on the same pitch above and below
 * the wrap (a wrapping flex row re-centres nothing but leaves the second line
 * unaligned with the first) and collapses the unused tracks so the cluster still
 * sits flush left. Track width is the actual ring diameter, so the fit follows
 * the `size` prop rather than a breakpoint tuned to one count: five sit across
 * once the card offers `5·size + 4·gap` (320px at `size=48`), fewer per row below
 * that, and the grid never overflows its card at any width.
 */
export function ScoreRings({ scores, size = 64, className }: ScoreRingsProps) {
  return (
    <div
      className={cn(
        "grid items-start justify-start justify-items-center gap-5",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(0, ${size}px))` }}
    >
      {LIGHTHOUSE_CATEGORIES.filter((cat) => cat in scores).map((cat) => (
        <ScoreRing
          key={cat}
          score={scores[cat] ?? null}
          label={CATEGORY_SHORT_LABELS[cat]}
          size={size}
        />
      ))}
    </div>
  );
}
