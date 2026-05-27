/**
 * Dense results table (PRD §6 Phase 11 — full-bleed density pass).
 *
 * The compact alternate to the ring-card grid: one row per audit job exposing
 * the same data the cards carry — path, the four category {@link ScorePill}s, an
 * inline micro-CWV (LCP · TBT · CLS), the compact {@link EnvironmentBadge}, the
 * {@link JobStatusBadge}, and a `View →` that opens the unchanged detail sheet via
 * `onSelect`. Sticky mono header, hairline dividers, `tabular-nums` throughout —
 * the full rings / per-run spread stay in the detail sheet, unchanged.
 *
 * Pure presentational (no hooks/state); the `"use client"` boundary lives in the
 * parent `audit-results.tsx`, so this stays server-safe.
 */

import { ArrowRight } from "lucide-react";

import { EnvironmentBadge } from "@/components/audit/environment-badge";
import { ScorePill } from "@/components/audit/score-pill";
import { JobStatusBadge } from "@/components/audit/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { LighthouseCategory, MetricId } from "@/lib/lighthouse/types";
import { CATEGORY_SHORT_LABELS, METRIC_META, scoreColorClass } from "@/lib/scores";
import type { AuditJob } from "@/lib/queue/types";
import { cn } from "@/lib/utils";

/** Shared header label styling — mono, uppercase, tracked (matches the History table). */
const HEAD_LABEL = "font-mono text-[0.7rem] uppercase tracking-[0.16em]";

/** The four score columns in PRD display order. */
const SCORE_COLUMNS: readonly LighthouseCategory[] = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
] as const;

/** The micro-CWV metrics shown inline per row (LCP · TBT · CLS). */
const MICRO_CWV: readonly MetricId[] = [
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
] as const;

interface ResultsTableProps {
  jobs: AuditJob[];
  onSelect: (job: AuditJob) => void;
}

/**
 * A single inline micro-CWV readout (LCP · TBT · CLS): each metric's
 * `displayValue` band-coloured from its 0–1 score (scaled to 0–100, matching
 * {@link CoreWebVitalsStrip}); em dash when a metric is absent.
 */
function MicroCwv({ job }: { job: AuditJob }) {
  if (job.status !== "done" || !job.result) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  const { metrics } = job.result.median;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums">
      {MICRO_CWV.map((id, i) => {
        const metric = metrics[id];
        const meta = METRIC_META[id];
        // Metric `score` is 0–1; scale to 0–100 for the shared band helper.
        const colorClass = scoreColorClass(
          metric?.score == null ? null : metric.score * 100,
        );
        return (
          <span key={id} className="contents">
            {i > 0 ? (
              <span aria-hidden className="text-border">
                ·
              </span>
            ) : null}
            <span
              title={`${meta.label}: ${metric?.displayValue ?? "—"}`}
              className={cn(metric != null ? colorClass : "text-muted-foreground")}
            >
              <span className="text-[0.625rem] uppercase tracking-[0.1em] text-muted-foreground">
                {meta.abbr}
              </span>{" "}
              {metric?.displayValue ?? "—"}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * One score cell: a {@link ScorePill} for done rows, a Skeleton while
 * queued/running, an em dash for errored rows.
 */
function ScoreCell({ job, category }: { job: AuditJob; category: LighthouseCategory }) {
  let content: React.ReactNode;
  if (job.status === "done" && job.result) {
    content = <ScorePill score={job.result.median.scores[category]} />;
  } else if (job.status === "error") {
    content = <span className="text-muted-foreground/50">—</span>;
  } else {
    content = <Skeleton className="ml-auto h-6 w-9 rounded-md" />;
  }
  return <TableCell className="text-right">{content}</TableCell>;
}

/**
 * Dense one-row-per-URL results table. Numeric columns are right-aligned; the
 * header row is sticky so column meaning survives a long batch. Wrapped in a
 * `Card` so it reads as a single instrument panel like the History archive.
 */
export function ResultsTable({ jobs, onSelect }: ResultsTableProps) {
  return (
    <Card className="overflow-hidden py-0">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(HEAD_LABEL, "w-full")}>URL</TableHead>
            {SCORE_COLUMNS.map((category) => (
              <TableHead key={category} className={cn(HEAD_LABEL, "text-right")}>
                {CATEGORY_SHORT_LABELS[category]}
              </TableHead>
            ))}
            <TableHead className={HEAD_LABEL}>Vitals</TableHead>
            <TableHead className={HEAD_LABEL}>Env</TableHead>
            <TableHead className={HEAD_LABEL}>Status</TableHead>
            <TableHead className={cn(HEAD_LABEL, "text-right")}>
              <span className="sr-only">View</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => {
            const index = String(job.index + 1).padStart(2, "0");
            const interactive = job.status === "done" || job.status === "error";
            return (
              <TableRow key={job.id} className="hover:bg-muted/40">
                <TableCell className="max-w-0">
                  <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {index}
                    </span>
                    <span
                      title={job.url}
                      className="truncate font-mono text-xs tabular-nums text-foreground"
                    >
                      {job.url.replace(/^https?:\/\//, "")}
                    </span>
                  </span>
                </TableCell>
                {SCORE_COLUMNS.map((category) => (
                  <ScoreCell key={category} job={job} category={category} />
                ))}
                <TableCell>
                  <MicroCwv job={job} />
                </TableCell>
                <TableCell>
                  {job.status === "done" && job.result ? (
                    <EnvironmentBadge
                      variant="compact"
                      environment={job.result.environment}
                    />
                  ) : (
                    <span className="text-muted-foreground/50">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <JobStatusBadge status={job.status} />
                </TableCell>
                <TableCell className="text-right">
                  {interactive ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onSelect(job)}
                      aria-label={`View details for ${job.url}`}
                      className={cn(
                        HEAD_LABEL,
                        "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      View
                      <ArrowRight data-icon="inline-end" />
                    </Button>
                  ) : (
                    <span className="text-muted-foreground/50">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
