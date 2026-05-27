/**
 * Environment badge (PRD §6 Phase 10, checklist item 1).
 *
 * A read-only readout of the host / effective-throttling environment a run
 * executed under — Lighthouse's `benchmarkIndex` ("CPU/Memory Power") with its
 * device-class label, plus the effective throttling method + CPU multiplier. Two
 * shapes share one formatter ({@link environment-format}):
 *   - `variant="compact"` — a single chip for dense surfaces (result cards).
 *   - `variant="full"`    — a three-cell readout grid (detail sheet, batch summary),
 *     matching the run-config card's precision-instrument data accents.
 *
 * Purely presentational and server-safe (no hooks/state), so it renders in both
 * the client audit console and the server-rendered batch summary.
 */

import { Cpu } from "lucide-react";

import {
  benchmarkDeviceLabel,
  cpuMultiplierLabel,
  formatBenchmarkIndex,
  throttlingMethodLabel,
} from "@/lib/lighthouse/environment-format";
import type { RunEnvironment } from "@/lib/lighthouse/types";
import { cn } from "@/lib/utils";

export interface EnvironmentBadgeProps {
  environment: RunEnvironment | null;
  variant?: "compact" | "full";
  /** When true, accent the readout to signal the host likely distorted scores. */
  drifted?: boolean;
  className?: string;
}

/** One labelled cell in the full readout grid (mirrors the run-config card). */
function Cell({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string | null;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[0.6rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-sm font-semibold tabular-nums tracking-tight",
          accent ? "text-score-average" : "text-foreground",
        )}
      >
        {value}
      </span>
      {sub ? (
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.04em] text-muted-foreground">
          {sub}
        </span>
      ) : null}
    </div>
  );
}

export function EnvironmentBadge({
  environment,
  variant = "compact",
  drifted = false,
  className,
}: EnvironmentBadgeProps) {
  if (!environment) return null;

  const power = formatBenchmarkIndex(environment.benchmarkIndex);
  const deviceLabel = benchmarkDeviceLabel(environment.benchmarkIndex);
  const method = throttlingMethodLabel(environment.throttlingMethod);
  const multiplier = cpuMultiplierLabel(environment.cpuSlowdownMultiplier);

  if (variant === "full") {
    return (
      <div
        className={cn(
          "grid grid-cols-3 gap-3 rounded-lg border border-border/60 bg-muted/30 p-3",
          drifted && "border-score-average/40 bg-score-average/5",
          className,
        )}
      >
        <Cell
          label="CPU/Mem Power"
          value={power}
          sub={deviceLabel}
          accent={drifted}
        />
        <Cell label="Throttle" value={method} />
        <Cell label="CPU" value={multiplier} />
      </div>
    );
  }

  // Compact: a single mono chip, "⌁ 4058 · Simulated 4×".
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5",
        "font-mono text-[0.6rem] font-medium uppercase tracking-[0.08em] tabular-nums",
        drifted
          ? "border-score-average/40 bg-score-average/10 text-score-average"
          : "border-border/60 bg-muted/40 text-muted-foreground",
        className,
      )}
      title={
        deviceLabel
          ? `CPU/Memory Power ${power} (${deviceLabel}) · ${method} ${multiplier}`
          : `CPU/Memory Power ${power} · ${method} ${multiplier}`
      }
    >
      <Cpu className="size-3 shrink-0" aria-hidden />
      <span>{power}</span>
      <span aria-hidden className="text-border">
        ·
      </span>
      <span className="normal-case">{`${method} ${multiplier}`}</span>
    </span>
  );
}
