"use client";

import { ArrowDown, ArrowUp, ExternalLink, Minus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { reportHtmlUrl } from "@/lib/client/auditClient";
import type { HistoryRow } from "@/lib/db/persistence";
import { CATEGORY_LABELS, METRIC_META, formatScore, scoreColorClass } from "@/lib/scores";
import { cn } from "@/lib/utils";
import {
  diffMetrics,
  diffScores,
  type MetricDiff,
  type ScoreDiff,
} from "@/lib/compare/diff";

const HEAD_LABEL = "font-mono text-[0.7rem] uppercase tracking-[0.16em]";
const IMPROVED = "text-score-good";
const REGRESSED = "text-score-poor";
const NEUTRAL = "text-muted-foreground";

/** Format a signed numeric delta for display (rounded, with sign), or em dash. */
function formatDelta(delta: number | null, fractionDigits = 0): string {
  if (delta === null) return "—";
  if (delta === 0) return "±0";
  const rounded =
    fractionDigits > 0
      ? Number(delta.toFixed(fractionDigits))
      : Math.round(delta);
  if (rounded === 0) return "±0";
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

/** A direction arrow paired with text — colour is never the sole signal. */
function DeltaArrow({
  improved,
  flat,
}: {
  improved: boolean | null;
  /** True when there is a real delta of exactly 0 (vs. a missing value). */
  flat: boolean;
}) {
  if (improved === null) {
    return flat ? (
      <Minus aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    ) : null;
  }
  const Icon = improved ? ArrowUp : ArrowDown;
  return (
    <Icon
      aria-hidden
      className={cn("size-3 shrink-0", improved ? IMPROVED : REGRESSED)}
    />
  );
}

/** Colour class for a delta cell given improvement state. */
function deltaClass(improved: boolean | null): string {
  if (improved === null) return NEUTRAL;
  return improved ? IMPROVED : REGRESSED;
}

/** Screen-reader text describing a delta's direction. */
function deltaSrLabel(improved: boolean | null, flat: boolean): string {
  if (improved === null) return flat ? "no change" : "not comparable";
  return improved ? "improved" : "regressed";
}

/** One category-score diff row. Higher score is better → up arrow = improvement. */
function ScoreRow({ diff }: { diff: ScoreDiff }) {
  const improved =
    diff.direction === "up" ? true : diff.direction === "down" ? false : null;
  const flat = diff.direction === "flat";
  return (
    <TableRow className="hover:bg-muted/40">
      <TableCell className="text-foreground">
        {CATEGORY_LABELS[diff.category]}
      </TableCell>
      <TableCell className="text-right">
        <span className={cn("font-mono text-sm tabular-nums", scoreColorClass(diff.baseline))}>
          {formatScore(diff.baseline)}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <span className={cn("font-mono text-sm tabular-nums", scoreColorClass(diff.comparison))}>
          {formatScore(diff.comparison)}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <span className={cn("inline-flex items-center justify-end gap-1 font-mono text-sm tabular-nums", deltaClass(improved))}>
          <DeltaArrow improved={improved} flat={flat} />
          {formatDelta(diff.delta)}
          <span className="sr-only">{deltaSrLabel(improved, flat)}</span>
        </span>
      </TableCell>
    </TableRow>
  );
}

/** One CWV diff row. Lower numericValue is better → down arrow = improvement. */
function MetricRow({ diff }: { diff: MetricDiff }) {
  const meta = METRIC_META[diff.id];
  const isCls = diff.id === "cumulative-layout-shift";
  const flat = diff.delta === 0;
  return (
    <TableRow className="hover:bg-muted/40">
      <TableCell>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-foreground">
            {meta.abbr}
          </span>
          <span className="truncate text-xs text-muted-foreground">{meta.label}</span>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <span className="font-mono text-sm tabular-nums text-foreground">
          {diff.baseline?.displayValue ?? "—"}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <span className="font-mono text-sm tabular-nums text-foreground">
          {diff.comparison?.displayValue ?? "—"}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <span className={cn("inline-flex items-center justify-end gap-1 font-mono text-sm tabular-nums", deltaClass(diff.improved))}>
          <DeltaArrow improved={diff.improved} flat={flat} />
          {formatDelta(diff.delta, isCls ? 3 : 0)}
          <span className="sr-only">{deltaSrLabel(diff.improved, flat)}</span>
        </span>
      </TableCell>
    </TableRow>
  );
}

/** A compact "open report" link button for one side of the diff. */
function ReportLink({ run, side }: { run: HistoryRow; side: string }) {
  if (!run.hasHtmlReport) {
    return (
      <span className="font-mono text-[0.7rem] uppercase tracking-[0.12em] text-muted-foreground/60">
        {side}: no report
      </span>
    );
  }
  return (
    <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 px-2">
      <a href={reportHtmlUrl(run.id)} target="_blank" rel="noopener noreferrer">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.12em]">
          {side} report
        </span>
        <ExternalLink data-icon="inline-end" />
      </a>
    </Button>
  );
}

interface RunDiffProps {
  baseline: HistoryRow;
  comparison: HistoryRow;
}

/**
 * Side-by-side diff of two runs of the same URL: per-category score deltas
 * (higher = better) and Core Web Vitals deltas (lower = better), each with an
 * up/down/flat arrow + colour + screen-reader direction. Satisfies the PRD's
 * "pick two runs → score/metric diff".
 */
export function RunDiff({ baseline, comparison }: RunDiffProps) {
  const scoreDiffs = diffScores(baseline.scores, comparison.scores);
  const metricDiffs = diffMetrics(baseline.metrics, comparison.metrics);

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-lg border border-border/60">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD_LABEL}>Category</TableHead>
              <TableHead className={cn(HEAD_LABEL, "text-right")}>Baseline</TableHead>
              <TableHead className={cn(HEAD_LABEL, "text-right")}>Comparison</TableHead>
              <TableHead className={cn(HEAD_LABEL, "text-right")}>Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scoreDiffs.map((diff) => (
              <ScoreRow key={diff.category} diff={diff} />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
            Core Web Vitals
          </span>
          <Badge variant="outline" className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground">
            lower is better
          </Badge>
        </div>
        <div className="overflow-hidden rounded-lg border border-border/60">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={HEAD_LABEL}>Metric</TableHead>
                <TableHead className={cn(HEAD_LABEL, "text-right")}>Baseline</TableHead>
                <TableHead className={cn(HEAD_LABEL, "text-right")}>Comparison</TableHead>
                <TableHead className={cn(HEAD_LABEL, "text-right")}>Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metricDiffs.map((diff) => (
                <MetricRow key={diff.id} diff={diff} />
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
        <ReportLink run={baseline} side="Baseline" />
        <ReportLink run={comparison} side="Comparison" />
      </div>
    </div>
  );
}
