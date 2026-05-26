import { cn } from "@/lib/utils";
import { formatScore, scoreColorClass } from "@/lib/scores";

interface ScoreRingProps {
  /** 0–100 Lighthouse score, or null when unscored. */
  score: number | null;
  /** Caption rendered beneath the gauge (e.g. "Perf"). */
  label: string;
  /** Outer diameter in px (default ~64). */
  size?: number;
  className?: string;
}

/**
 * A circular SVG gauge: a faint full track ring + a colour-banded progress arc
 * proportional to `score`/100, with the rounded score centred and a mono caption
 * beneath. The arc colour is driven by the score band via `currentColor`, so the
 * same semantic token system colours every ring. Pure presentational.
 */
export function ScoreRing({ score, label, size = 64, className }: ScoreRingProps) {
  // Geometry: keep the stroke proportional to the diameter so the gauge reads
  // crisp at any size. The radius leaves a half-stroke margin on each side.
  const strokeWidth = Math.max(3, Math.round(size * 0.09));
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;

  const hasScore = score !== null && !Number.isNaN(score);
  const clamped = hasScore ? Math.min(100, Math.max(0, score)) : 0;
  // Dash offset draws the arc from the top, clockwise, proportional to score.
  const dashOffset = circumference * (1 - clamped / 100);

  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <div
        className="relative shrink-0"
        style={{ width: size, height: size }}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label}: ${formatScore(score)}`}
          className={cn("-rotate-90", hasScore ? scoreColorClass(score) : "text-muted-foreground")}
        >
          {/* Faint full track. */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="text-border"
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={hasScore ? undefined : "1 6"}
          />
          {/* Colour-banded progress arc (hidden when unscored). */}
          {hasScore ? (
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          ) : null}
        </svg>
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center justify-center font-mono font-medium tabular-nums",
            hasScore ? scoreColorClass(score) : "text-muted-foreground"
          )}
          style={{ fontSize: Math.round(size * 0.3) }}
        >
          {formatScore(score)}
        </span>
      </div>
      <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
