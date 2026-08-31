"use client";

/**
 * Run-config status strip (PRD §6 Phase 9, checklist item 4).
 *
 * A compact, read-only summary of the throttling method, the *effective* CPU
 * slowdown multiplier (or "Auto 4×" when none is pinned — exactly what the
 * DevTools panel uses), and the calibrated recommendation derived from the most
 * recent run's `benchmarkIndex`. Purely presentational: it reflects the form's
 * live state and the already-tested {@link Calibration}; it never recomputes the
 * bracket math itself. Styled to match the precision-instrument data accents used
 * across the audit surfaces (monospace, uppercase, tabular figures).
 *
 * Layout: a full-width bezel that anchors the bottom of the Run-config panel —
 * readout on the left, the panel's actions ({@link RunConfigCardProps.actions})
 * trailing on the right once the section is wide enough, stacked under it below
 * that. The strip sizes off the *section's* container query, not the viewport,
 * so it reflows the same way whether Run config owns half the card or all of it.
 */

import type { ReactNode } from "react";
import { Activity, Cpu, Gauge } from "lucide-react";

import {
  Readout,
  ReadoutCell,
  ReadoutCells,
  ReadoutNote,
} from "@/components/audit/readout";
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
  /**
   * Panel actions (Calibrate / Match DevTools / Save as daily) rendered inside
   * the strip. Keeping them in the same bezel as the numbers they act on turns
   * the readout plus a floating button stack into one instrument footer.
   */
  actions?: ReactNode;
}

export function RunConfigCard({
  throttling,
  cpuSlowdownMultiplier,
  calibration,
  actions,
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
    <Readout className="@2xl:flex-row @2xl:items-center @2xl:justify-between @2xl:gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <ReadoutCells>
          <ReadoutCell
            icon={<Activity className="size-3" aria-hidden />}
            label="Throttle"
            value={THROTTLING_LABELS[throttling]}
          />
          <ReadoutCell
            icon={<Cpu className="size-3" aria-hidden />}
            label="CPU"
            value={cpuValue}
            tone={matchesRecommendation ? "good" : "default"}
          />
          <ReadoutCell
            icon={<Gauge className="size-3" aria-hidden />}
            label="Suggested"
            value={recommendation}
          />
        </ReadoutCells>
        <ReadoutNote>
          {calibration
            ? matchesRecommendation
              ? `Calibrated for ${calibration.deviceClassLabel.toLowerCase()} (benchmark ${Math.round(calibration.benchmarkIndex)}).`
              : `Latest host reads ${Math.round(calibration.benchmarkIndex)} — ${calibration.deviceClassLabel.toLowerCase()}. Calibrate to retarget mid-tier mobile.`
            : "Run an audit to read this host's benchmark, then calibrate."}
        </ReadoutNote>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 @2xl:justify-end">
          {actions}
        </div>
      ) : null}
    </Readout>
  );
}
