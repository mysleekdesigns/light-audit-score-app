/**
 * Dense results table (PRD §6 Phase 11 — full-bleed density pass; PRD §6 Phase 12
 * — paired Desktop + Mobile).
 *
 * The compact alternate to the ring-card grid. It auto-detects whether the jobs
 * span one device or both ({@link hasBothDevices} over the jobs):
 *
 *  - **Single-device** — one row per audit job exposing the same data the cards
 *    carry: path, the four category {@link ScorePill}s, an inline micro-CWV
 *    (LCP · TBT · CLS), the compact {@link EnvironmentBadge}, the
 *    {@link JobStatusBadge}, and a `View →` that opens the detail sheet via
 *    `onSelect`.
 *  - **Both devices** — one row per *URL* ({@link pairByDevice}) with the four
 *    category pills shown twice under a two-level "Mobile | Desktop" header; a URL
 *    missing one device renders em dashes in that side, and each side's `View →`
 *    opens that device's job.
 *
 * Sticky mono header, hairline dividers, `tabular-nums` throughout — the full
 * rings / per-run spread stay in the detail sheet, unchanged.
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
import { hasBothDevices, pairByDevice } from "@/lib/pairing/devicePairs";
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
  return <TableCell className="text-right">{scoreContent(job, category)}</TableCell>;
}

/** The inner content of a score cell, reused by the single + paired layouts. */
function scoreContent(
  job: AuditJob,
  category: LighthouseCategory,
): React.ReactNode {
  if (job.status === "done" && job.result) {
    return <ScorePill score={job.result.median.scores[category]} />;
  }
  if (job.status === "error") {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return <Skeleton className="ml-auto h-6 w-9 rounded-md" />;
}

/** The leading "NN · path" URL cell, shared by both layouts. */
function UrlCell({ index, url }: { index: number; url: string }) {
  return (
    <TableCell className="max-w-0">
      <span className="flex min-w-0 items-baseline gap-2.5">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span
          title={url}
          className="truncate font-mono text-xs tabular-nums text-foreground"
        >
          {url.replace(/^https?:\/\//, "")}
        </span>
      </span>
    </TableCell>
  );
}

/** The trailing `View →` action (or an em dash when the job can't be opened yet). */
function ViewCell({
  job,
  onSelect,
}: {
  job: AuditJob;
  onSelect: (job: AuditJob) => void;
}) {
  const interactive = job.status === "done" || job.status === "error";
  return (
    <TableCell className="text-right">
      {interactive ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onSelect(job)}
          aria-label={`View details for ${job.url}`}
          className={cn(HEAD_LABEL, "text-muted-foreground hover:text-foreground")}
        >
          View
          <ArrowRight data-icon="inline-end" />
        </Button>
      ) : (
        <span className="text-muted-foreground/50">—</span>
      )}
    </TableCell>
  );
}

/**
 * Dense single-device table: one row per audit job, four category pills, inline
 * micro-CWV, env, status, and a `View →`. This is the original Phase-11 layout,
 * kept verbatim for any batch that ran a single device.
 */
function SingleDeviceTable({ jobs, onSelect }: ResultsTableProps) {
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
          {jobs.map((job) => (
            <TableRow key={job.id} className="hover:bg-muted/40">
              <UrlCell index={job.index} url={job.url} />
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
              <ViewCell job={job} onSelect={onSelect} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/**
 * One device's half of a paired row: four right-aligned score cells (band-coloured
 * pills, skeletons, or status dashes), the job's status, then its own `View →`.
 * `job` is null when this URL wasn't audited on this device — every slot becomes
 * an em dash. `borderless` drops the left hairline on the first (mobile) half.
 */
function DeviceHalf({
  job,
  onSelect,
  borderless = false,
}: {
  job: AuditJob | null;
  onSelect: (job: AuditJob) => void;
  borderless?: boolean;
}) {
  const edge = borderless ? undefined : "border-l border-border/50";
  if (!job) {
    return (
      <>
        {SCORE_COLUMNS.map((category, i) => (
          <TableCell
            key={category}
            className={cn("text-right text-muted-foreground/50", i === 0 && edge)}
          >
            —
          </TableCell>
        ))}
        <TableCell className="text-muted-foreground/50">—</TableCell>
        <TableCell className="text-right text-muted-foreground/50">—</TableCell>
      </>
    );
  }
  return (
    <>
      {SCORE_COLUMNS.map((category, i) => (
        <TableCell
          key={category}
          className={cn("text-right", i === 0 && edge)}
        >
          {scoreContent(job, category)}
        </TableCell>
      ))}
      <TableCell>
        <JobStatusBadge status={job.status} />
      </TableCell>
      <ViewCell job={job} onSelect={onSelect} />
    </>
  );
}

/**
 * Paired table: one row per URL with the four category pills shown twice — under
 * a two-level header that spans "Mobile" and "Desktop", each over the four short
 * category labels. Each device half carries its own status + `View →` so the user
 * can open either device's detail sheet. URLs missing a device show em dashes.
 */
function PairedTable({ jobs, onSelect }: ResultsTableProps) {
  const pairs = pairByDevice(
    jobs,
    (job) => job.url,
    (job) => job.device,
  );
  return (
    <Card className="overflow-hidden py-0">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          {/* Top header: device-spanning groups over the per-device sub-columns. */}
          <TableRow className="hover:bg-transparent">
            <TableHead
              scope="col"
              rowSpan={2}
              className={cn(HEAD_LABEL, "w-full align-bottom")}
            >
              URL
            </TableHead>
            <TableHead
              scope="colgroup"
              colSpan={SCORE_COLUMNS.length + 2}
              className={cn(HEAD_LABEL, "text-center text-primary")}
            >
              Mobile
            </TableHead>
            <TableHead
              scope="colgroup"
              colSpan={SCORE_COLUMNS.length + 2}
              className={cn(HEAD_LABEL, "border-l border-border/50 text-center text-primary")}
            >
              Desktop
            </TableHead>
          </TableRow>
          {/* Sub-header: the four category short-labels, status + view, per device. */}
          <TableRow className="hover:bg-transparent">
            {SCORE_COLUMNS.map((category) => (
              <TableHead
                key={`m-${category}`}
                scope="col"
                className={cn(HEAD_LABEL, "text-right")}
              >
                {CATEGORY_SHORT_LABELS[category]}
              </TableHead>
            ))}
            <TableHead scope="col" className={HEAD_LABEL}>
              Status
            </TableHead>
            <TableHead scope="col" className={cn(HEAD_LABEL, "text-right")}>
              <span className="sr-only">View mobile</span>
            </TableHead>
            {SCORE_COLUMNS.map((category, i) => (
              <TableHead
                key={`d-${category}`}
                scope="col"
                className={cn(HEAD_LABEL, "text-right", i === 0 && "border-l border-border/50")}
              >
                {CATEGORY_SHORT_LABELS[category]}
              </TableHead>
            ))}
            <TableHead scope="col" className={HEAD_LABEL}>
              Status
            </TableHead>
            <TableHead scope="col" className={cn(HEAD_LABEL, "text-right")}>
              <span className="sr-only">View desktop</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pairs.map((pair, i) => (
            <TableRow key={pair.url} className="hover:bg-muted/40">
              <UrlCell index={i} url={pair.url} />
              <DeviceHalf job={pair.mobile} onSelect={onSelect} borderless />
              <DeviceHalf job={pair.desktop} onSelect={onSelect} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/**
 * Device-aware dense results table. Picks the paired Mobile | Desktop layout when
 * the jobs span both devices, else the single-device layout. Numeric columns are
 * right-aligned; the header row is sticky so column meaning survives a long batch.
 * Wrapped in a `Card` so it reads as a single instrument panel like the History
 * archive.
 */
export function ResultsTable({ jobs, onSelect }: ResultsTableProps) {
  const paired = hasBothDevices(jobs, (job) => job.device);
  return paired ? (
    <PairedTable jobs={jobs} onSelect={onSelect} />
  ) : (
    <SingleDeviceTable jobs={jobs} onSelect={onSelect} />
  );
}
