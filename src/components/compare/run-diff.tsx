"use client";

import { ArrowDown, ArrowUp, ExternalLink, Hourglass, Minus } from "lucide-react";

import {
  Readout,
  ReadoutCell,
  ReadoutCells,
  ReadoutNote,
} from "@/components/audit/readout";
import {
  DeltaArrow,
  deltaClass,
  deltaSrLabel,
  formatDelta,
  formatMetricDelta,
} from "@/components/compare/score-delta";
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
import { runTime } from "@/lib/compare/diff";
import {
  CATEGORY_LABELS,
  CATEGORY_SHORT_LABELS,
  METRIC_META,
  formatScore,
  scoreColorClass,
} from "@/lib/scores";
import { cn } from "@/lib/utils";
import {
  diffMetrics,
  diffScores,
  type MetricDiff,
  type ScoreDiff,
} from "@/lib/compare/diff";

/**
 * Header label. The letter-spacing is the widest thing in the label column at
 * 320px — "Metric" costs ~11px of pure tracking — so it relaxes only once the
 * card has room for it.
 */
const HEAD_LABEL =
  "font-mono text-[0.65rem] uppercase tracking-[0.08em] @sm:text-[0.7rem] @sm:tracking-[0.16em]";

/**
 * Cell padding for the diff tables.
 *
 * Four columns at the table's default `px-2` overflowed a 320px phone by 25–36px
 * and the column pushed off the edge was Δ — the entire point of a diff. 4px of
 * side padding buys back the width that closes the gap; the full padding returns
 * once the card can afford it.
 */
const CELL = "px-1 @sm:px-2";

/**
 * The label column claims all the table's slack, so the three numeric columns
 * hug the right edge and stay adjacent to each other. Without it, auto layout
 * spread Baseline / Comparison / Δ across a 944px card, leaving each number
 * marooned a couple of hundred pixels from the one it should be compared with.
 */
const LABEL_COL = "w-full";

/**
 * Column header that abbreviates while the card is narrow.
 *
 * Sized off the card's own container rather than the viewport: this table sits
 * in a half-width column from `lg` up, so a viewport breakpoint would restore
 * "Comparison" exactly where the column can least afford it.
 */
function DiffHead({ short, long }: { short: string; long: string }) {
  return (
    <>
      <span className="@sm:hidden">{short}</span>
      <span className="hidden @sm:inline">{long}</span>
    </>
  );
}

/**
 * A row's identity cell: the mono abbreviation always, the full name once the
 * card is wide enough. Both tables share it so a category row and a metric row
 * read as the same instrument, and so a phone spends its width on numbers.
 */
function RowLabel({ abbr, label }: { abbr: string; label: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-foreground">
        {abbr}
      </span>
      {/* SEO's abbreviation *is* its name — printing "SEO SEO" would be noise. */}
      {label.toLowerCase() === abbr.toLowerCase() ? null : (
        <span className="sr-only text-xs text-muted-foreground @sm:not-sr-only">
          {label}
        </span>
      )}
    </div>
  );
}

/** One category-score diff row. Higher score is better → up arrow = improvement. */
function ScoreRow({ diff }: { diff: ScoreDiff }) {
  const improved =
    diff.direction === "up" ? true : diff.direction === "down" ? false : null;
  const flat = diff.direction === "flat";
  return (
    <TableRow className="hover:bg-muted/40">
      <TableCell className={cn(CELL, LABEL_COL)}>
        <RowLabel
          abbr={CATEGORY_SHORT_LABELS[diff.category]}
          label={CATEGORY_LABELS[diff.category]}
        />
      </TableCell>
      <TableCell className={cn(CELL, "text-right")}>
        <span className={cn("font-mono text-xs tabular-nums @sm:text-sm", scoreColorClass(diff.baseline))}>
          {formatScore(diff.baseline)}
        </span>
      </TableCell>
      <TableCell className={cn(CELL, "text-right")}>
        <span className={cn("font-mono text-xs tabular-nums @sm:text-sm", scoreColorClass(diff.comparison))}>
          {formatScore(diff.comparison)}
        </span>
      </TableCell>
      <TableCell className={cn(CELL, "text-right")}>
        <span className={cn("inline-flex items-center justify-end gap-0.5 font-mono text-xs tabular-nums @sm:gap-1 @sm:text-sm", deltaClass(improved))}>
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
  const flat = diff.delta === 0;
  return (
    <TableRow className="hover:bg-muted/40">
      <TableCell className={cn(CELL, LABEL_COL)}>
        <RowLabel abbr={meta.abbr} label={meta.label} />
      </TableCell>
      <TableCell className={cn(CELL, "text-right")}>
        <span className="font-mono text-xs tabular-nums @sm:text-sm text-foreground">
          {diff.baseline?.displayValue ?? "—"}
        </span>
      </TableCell>
      <TableCell className={cn(CELL, "text-right")}>
        <span className="font-mono text-xs tabular-nums @sm:text-sm text-foreground">
          {diff.comparison?.displayValue ?? "—"}
        </span>
      </TableCell>
      <TableCell className={cn(CELL, "text-right")}>
        <span className={cn("inline-flex items-center justify-end gap-0.5 font-mono text-xs tabular-nums @sm:gap-1 @sm:text-sm", deltaClass(diff.improved))}>
          {/* The arrow tracks the value, the colour the judgement: a metric that
              fell is a green down arrow, not a green up arrow beside a minus. */}
          <DeltaArrow
            improved={diff.improved}
            flat={flat}
            points={diff.delta !== null && diff.delta > 0 ? "up" : "down"}
          />
          {formatMetricDelta(diff.delta, diff.comparison ?? diff.baseline)}
          <span className="sr-only">{deltaSrLabel(diff.improved, flat)}</span>
        </span>
      </TableCell>
    </TableRow>
  );
}

/** An "open report" link for one side of the diff — a full-width target on a phone. */
function ReportLink({ run, side }: { run: HistoryRow; side: string }) {
  const label = "font-mono text-[0.7rem] uppercase tracking-[0.12em]";
  if (!run.hasHtmlReport) {
    return (
      <span
        className={cn(
          "inline-flex h-8 items-center justify-center rounded-lg border border-dashed border-border/60 px-2 text-muted-foreground/60 @sm:w-auto",
          label,
        )}
      >
        {side}: no report
      </span>
    );
  }
  return (
    <Button asChild variant="outline" size="sm" className="h-8 w-full gap-1.5 px-2 @sm:w-auto">
      <a href={reportHtmlUrl(run.id)} target="_blank" rel="noopener noreferrer">
        <span className={label}>{side} report</span>
        <ExternalLink data-icon="inline-end" />
      </a>
    </Button>
  );
}

/** Compact elapsed time between the two runs being diffed ("4d 21h", "18m"). */
function formatGap(baseline: HistoryRow, comparison: HistoryRow): string {
  const from = new Date(runTime(baseline)).getTime();
  const to = new Date(runTime(comparison)).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return "—";

  const minutes = Math.round(Math.abs(to - from) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
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
 *
 * Ends in the house instrument footer (`readout.tsx`): the ten rows above
 * tallied into improved / regressed / unchanged, how far apart the two runs
 * were taken, and the report links inside the same bezel rather than floating
 * beneath it.
 */
export function RunDiff({ baseline, comparison }: RunDiffProps) {
  const scoreDiffs = diffScores(baseline.scores, comparison.scores);
  const metricDiffs = diffMetrics(baseline.metrics, comparison.metrics);

  const improved =
    scoreDiffs.filter((d) => d.direction === "up").length +
    metricDiffs.filter((d) => d.improved === true).length;
  const regressed =
    scoreDiffs.filter((d) => d.direction === "down").length +
    metricDiffs.filter((d) => d.improved === false).length;
  const unchanged = scoreDiffs.length + metricDiffs.length - improved - regressed;

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-lg border border-border/60">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD_LABEL, CELL, LABEL_COL)}>
                Category
              </TableHead>
              <TableHead className={cn(HEAD_LABEL, CELL, "text-right")}>
                <DiffHead short="Base" long="Baseline" />
              </TableHead>
              <TableHead className={cn(HEAD_LABEL, CELL, "text-right")}>
                <DiffHead short="Comp" long="Comparison" />
              </TableHead>
              <TableHead className={cn(HEAD_LABEL, CELL, "text-right")}>Δ</TableHead>
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
        <div className="flex flex-wrap items-center gap-2">
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
                <TableHead className={cn(HEAD_LABEL, CELL, LABEL_COL)}>
                  Metric
                </TableHead>
                <TableHead className={cn(HEAD_LABEL, CELL, "text-right")}>
                  <DiffHead short="Base" long="Baseline" />
                </TableHead>
                <TableHead className={cn(HEAD_LABEL, CELL, "text-right")}>
                  <DiffHead short="Comp" long="Comparison" />
                </TableHead>
                <TableHead className={cn(HEAD_LABEL, CELL, "text-right")}>Δ</TableHead>
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

      <Readout className="mt-auto">
        <ReadoutCells className="grid grid-cols-2 items-start gap-y-3 @sm:flex">
          <ReadoutCell
            icon={<ArrowUp className="size-3" aria-hidden />}
            label="Improved"
            value={String(improved)}
            tone={improved > 0 ? "good" : "default"}
          />
          <ReadoutCell
            icon={<ArrowDown className="size-3" aria-hidden />}
            label="Regressed"
            value={String(regressed)}
            tone={regressed > 0 ? "warn" : "default"}
          />
          <ReadoutCell
            icon={<Minus className="size-3" aria-hidden />}
            label="Unchanged"
            value={String(unchanged)}
          />
          <ReadoutCell
            icon={<Hourglass className="size-3" aria-hidden />}
            label="Apart"
            value={formatGap(baseline, comparison)}
          />
        </ReadoutCells>
        <ReadoutNote>
          {`Across ${scoreDiffs.length} category scores and ${metricDiffs.length} Core Web Vitals.`}
        </ReadoutNote>
        <div className="grid grid-cols-1 gap-2 @sm:flex @sm:flex-wrap @sm:items-center">
          <ReportLink run={baseline} side="Baseline" />
          <ReportLink run={comparison} side="Comparison" />
        </div>
      </Readout>
    </div>
  );
}
