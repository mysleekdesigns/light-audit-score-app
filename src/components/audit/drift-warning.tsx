/**
 * Drift warning (PRD §6 Phase 10, checklist item 2).
 *
 * Renders a {@link DriftAssessment} (from the pure `drift.ts`) as an on-brand
 * alert: a one-line headline + the assessment's plain-English reasons (host-power
 * drift, wide benchmarkIndex spread, concurrency contention), and a one-click
 * link to Calibrate when the host is over/under-powered. Returns `null` when
 * there's no drift to report, so callers can render it unconditionally.
 *
 * Purely presentational and server-safe (the link is a plain anchor), so it
 * renders in both the client audit console and the server-rendered batch summary.
 */

import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { DriftAssessment } from "@/lib/lighthouse/drift";
import { cn } from "@/lib/utils";

export interface DriftWarningProps {
  assessment: DriftAssessment;
  /**
   * Href for the "Calibrate" affordance (e.g. the New-Audit page where the
   * Calibrate button lives). Omit to hide the link.
   */
  calibrateHref?: string;
  className?: string;
}

export function DriftWarning({
  assessment,
  calibrateHref,
  className,
}: DriftWarningProps) {
  if (assessment.severity === "none" || assessment.reasons.length === 0) {
    return null;
  }

  const showCalibrate = assessment.powerDrift && calibrateHref;

  return (
    <Alert
      variant="destructive"
      className={cn(
        "border-score-average/40 bg-score-average/5 text-score-average",
        className,
      )}
    >
      <TriangleAlert className="size-4" aria-hidden />
      <AlertTitle className="font-mono text-xs font-semibold uppercase tracking-[0.12em]">
        Environment may distort Performance
      </AlertTitle>
      <AlertDescription className="text-muted-foreground">
        <ul className="flex list-none flex-col gap-1.5">
          {assessment.reasons.map((reason, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="select-none text-score-average">
                ▸
              </span>
              <span className="text-pretty">{reason}</span>
            </li>
          ))}
        </ul>
        {showCalibrate ? (
          <a
            href={calibrateHref}
            className="mt-2.5 inline-flex w-fit items-center gap-1 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-score-average underline-offset-4 hover:underline"
          >
            Calibrate
            <span aria-hidden>→</span>
          </a>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
