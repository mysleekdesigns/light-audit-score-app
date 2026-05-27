"use client";

/**
 * Run-config readout (PRD §6 Phase 9, checklist item 4).
 *
 * A compact, read-only summary of the throttling method, the *effective* CPU
 * slowdown multiplier (or "Auto 4×" when none is pinned — exactly what the
 * DevTools panel uses), and the calibrated recommendation derived from the most
 * recent run's `benchmarkIndex`. Purely presentational: it reflects the form's
 * live state and the already-tested {@link Calibration}; it never recomputes the
 * bracket math itself. Styled to match the precision-instrument data accents used
 * across the audit surfaces (monospace, uppercase, tabular figures).
 */

import { Activity, Cpu, Gauge } from "lucide-react";

import type { Calibration } from "@/lib/lighthouse/calibrate";
import type { Throttling } from "@/lib/lighthouse/types";

/** Lighthouse's built-in CPU slowdown when no multiplier is pinned. */
const LIGHTHOUSE_DEFAULT_MULTIPLIER = 4;

const THROTTLING_LABELS: Record<Throttling, string> = {
  simulated: "Simulated",
  applied: "Applied",
};

export interface RunConfigCardProps {
  /** Throttling method the next run will use. */
  throttling: Throttling;
  /** Pinned CPU multiplier, or `undefined` to let Lighthouse apply its 4× default. */
  cpuSlowdownMultiplier?: number;
  /** Calibration derived from the latest run's benchmarkIndex, or null when none. */
  calibration: Calibration | null;
}

/** One labelled metric cell in the readout grid. */
function ReadoutCell({
  icon,
  label,
  value,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 font-mono text-[0.6rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className={
          "font-mono text-sm font-semibold tabular-nums tracking-tight " +
          (accent ? "text-score-good" : "text-foreground")
        }
      >
        {value}
      </span>
    </div>
  );
}

export function RunConfigCard({
  throttling,
  cpuSlowdownMultiplier,
  calibration,
}: RunConfigCardProps) {
  const isPinned = typeof cpuSlowdownMultiplier === "number";
  const cpuValue = isPinned ? `${cpuSlowdownMultiplier}×` : `Auto ${LIGHTHOUSE_DEFAULT_MULTIPLIER}×`;

  // The recommendation is "satisfied" when a multiplier is pinned at the value
  // the latest run's benchmarkIndex suggests — surface that as an accent.
  const recommendation = calibration
    ? `${calibration.recommendedMultiplier}×`
    : "—";
  const matchesRecommendation =
    calibration != null &&
    isPinned &&
    cpuSlowdownMultiplier === calibration.recommendedMultiplier;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="grid grid-cols-3 gap-3">
        <ReadoutCell
          icon={<Activity className="size-3" aria-hidden />}
          label="Throttle"
          value={THROTTLING_LABELS[throttling]}
        />
        <ReadoutCell
          icon={<Cpu className="size-3" aria-hidden />}
          label="CPU"
          value={cpuValue}
          accent={matchesRecommendation}
        />
        <ReadoutCell
          icon={<Gauge className="size-3" aria-hidden />}
          label="Suggested"
          value={recommendation}
        />
      </div>
      <p className="mt-2.5 font-mono text-[0.6rem] leading-relaxed tracking-[0.04em] text-muted-foreground">
        {calibration
          ? matchesRecommendation
            ? `Calibrated for ${calibration.deviceClassLabel.toLowerCase()} (benchmark ${Math.round(calibration.benchmarkIndex)}).`
            : `Latest host reads ${Math.round(calibration.benchmarkIndex)} — ${calibration.deviceClassLabel.toLowerCase()}. Calibrate to retarget mid-tier mobile.`
          : "Run an audit to read this host's benchmark, then calibrate."}
      </p>
    </div>
  );
}
