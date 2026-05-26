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
 * A horizontal row of {@link ScoreRing} gauges — one per Lighthouse category
 * present in `scores`, rendered in canonical `LIGHTHOUSE_CATEGORIES` order so the
 * layout is stable regardless of key insertion order. Wraps on narrow screens.
 * Pure presentational.
 */
export function ScoreRings({ scores, size, className }: ScoreRingsProps) {
  return (
    <div className={cn("flex flex-wrap items-start gap-5", className)}>
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
