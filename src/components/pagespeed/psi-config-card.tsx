"use client";

/**
 * PageSpeed config status strip — the PSI sibling of {@link RunConfigCard}.
 *
 * Where the local form's strip reads *accuracy* (throttling, CPU, the calibrated
 * recommendation), PSI's lab conditions are fixed Google-side, so the numbers
 * worth surfacing are what the batch will **cost**: the strategies each URL is
 * analysed on, the per-URL call price, and the batch total measured against the
 * published quota. Purely presentational — the arithmetic is
 * {@link psiRequestCost} and the caller owns the state it reflects.
 *
 * Layout mirrors Run config's exactly (shared {@link Readout} primitives): a
 * full-width bezel anchoring the bottom of the config panel, readout on the left
 * and the panel's actions trailing right once the section is wide enough. It
 * sizes off the *section's* container query, so it reflows the same way whether
 * the panel owns half the card (≥1440px) or all of it.
 */

import type { ReactNode } from "react";
import { Repeat2, Smartphone, Sigma } from "lucide-react";

import {
  Readout,
  ReadoutCell,
  ReadoutCells,
  ReadoutNote,
} from "@/components/audit/readout";
import type { DeviceSelection } from "@/lib/lighthouse/types";
import { psiRequestCost } from "@/lib/pagespeed/quota";

/** How the chosen device reads as a PSI *strategy* (what Google is asked for). */
const STRATEGY_LABELS: Record<DeviceSelection, string> = {
  mobile: "Mobile",
  desktop: "Desktop",
  both: "Mobile + desktop",
};

/** `n` with its unit, singularised — "1 call" / "9 calls". */
function calls(n: number): string {
  return `${n} ${n === 1 ? "call" : "calls"}`;
}

export interface PsiConfigCardProps {
  /** Device selection the next run will use — `"both"` doubles the call price. */
  device: DeviceSelection;
  /** Runs per URL (client-side median-of-N; each run is one PSI API call). */
  runs: number;
  /** URLs currently queued by the active tab. 0 before anything is pasted. */
  targetCount: number;
  /**
   * Panel actions (Save as daily) rendered inside the strip, so the readout and
   * the buttons that act on it share one bezel instead of the action floating
   * off beside the categories row.
   */
  actions?: ReactNode;
}

export function PsiConfigCard({
  device,
  runs,
  targetCount,
  actions,
}: PsiConfigCardProps) {
  const cost = psiRequestCost(device, runs, targetCount);

  return (
    <Readout className="@2xl:flex-row @2xl:items-center @2xl:justify-between @2xl:gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <ReadoutCells>
          <ReadoutCell
            icon={<Smartphone className="size-3" aria-hidden />}
            label="Strategy"
            value={STRATEGY_LABELS[device]}
          />
          <ReadoutCell
            icon={<Repeat2 className="size-3" aria-hidden />}
            label="Per URL"
            value={calls(cost.perUrl)}
          />
          <ReadoutCell
            icon={<Sigma className="size-3" aria-hidden />}
            label="Batch"
            value={targetCount > 0 ? calls(cost.total) : "—"}
            tone={cost.overBurst ? "warn" : "default"}
          />
        </ReadoutCells>
        <ReadoutNote>
          Google&rsquo;s lab conditions are fixed — mobile emulates a mid-tier
          phone on slow 4G — so CPU slowdown and throttling aren&rsquo;t tunable
          here; run a local audit to change those. Chrome UX Report field data
          rides along when a URL has enough real-world traffic.
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
