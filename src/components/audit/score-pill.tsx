/**
 * Score pill (PRD §6 Phase 11) — the dense counterpart to {@link ScoreRing}.
 *
 * A small, rounded, monospace chip showing a single 0–100 Lighthouse score,
 * colour-banded from the *same* band → token source of truth as the ring
 * ({@link scoreChipClass} → {@link scoreBand}), so the two can never disagree.
 * Built for the dense results table where a row of pills — one per Lighthouse
 * category — replaces a row of gauges. Pure presentational and server-safe (no
 * hooks/state).
 */

import { cn } from "@/lib/utils";
import { formatScore, scoreChipClass } from "@/lib/scores";

export interface ScorePillProps {
  /** 0–100 Lighthouse score, or null/undefined when unscored. */
  score: number | null | undefined;
  /**
   * Optional short caption rendered before the number (e.g. "Perf"). In a table
   * the column header already names the category, so this is usually omitted.
   */
  label?: string;
  /** Native tooltip; defaults to "<label>: <score>" (or just the score). */
  title?: string;
  className?: string;
}

export function ScorePill({ score, label, title, className }: ScorePillProps) {
  const text = formatScore(score);
  return (
    <span
      title={title ?? (label ? `${label}: ${text}` : text)}
      className={cn(
        "inline-flex min-w-[2.25rem] items-center justify-center gap-1 rounded-md border px-1.5 py-0.5",
        "font-mono text-xs font-medium tabular-nums tracking-tight",
        scoreChipClass(score),
        className,
      )}
    >
      {label ? (
        <span className="text-[0.6rem] uppercase tracking-[0.12em] opacity-70">
          {label}
        </span>
      ) : null}
      {text}
    </span>
  );
}
