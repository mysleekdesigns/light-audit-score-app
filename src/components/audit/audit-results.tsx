"use client";

/**
 * Live results panel (PRD §6 Phase 3): a responsive grid of per-URL audit cards
 * fed by a {@link Batch} snapshot from `useBatchStream`. Cards update in place as
 * jobs move queued → running → done/error; a done or errored card opens the
 * detail sheet via `onSelect`. Pure view — all state lives in the console parent.
 */

import { memo } from "react";
import { Radio } from "lucide-react";

import { CoreWebVitalsStrip } from "@/components/audit/core-web-vitals";
import { EnvironmentBadge } from "@/components/audit/environment-badge";
import { ScoreRings } from "@/components/audit/score-rings";
import { JobStatusBadge } from "@/components/audit/status-badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { assessDrift } from "@/lib/lighthouse/drift";
import { cn } from "@/lib/utils";
import type { StreamConnection } from "@/hooks/useBatchStream";
import type { AuditJob, Batch } from "@/lib/queue/types";

interface AuditResultsProps {
  batch: Batch;
  connection: StreamConnection;
  onSelect: (job: AuditJob) => void;
}

/** Whole-batch progress as a 0–100 percentage of finished (done + error) jobs. */
function batchProgress(batch: Batch): number {
  const { total, done, error } = batch.counts;
  if (total === 0) return 0;
  return Math.round(((done + error) / total) * 100);
}

const STATUS_LABEL: Record<Batch["status"], string> = {
  queued: "Queued",
  running: "Auditing",
  completed: "Complete",
  completed_with_errors: "Complete · with errors",
};

export function AuditResults({ batch, connection, onSelect }: AuditResultsProps) {
  const pct = batchProgress(batch);
  const { total, done, error, running } = batch.counts;

  return (
    <section className="flex flex-col gap-4" aria-label="Audit results">
      {/* Telemetry strip: batch status, live counts, connection, progress. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
              {STATUS_LABEL[batch.status]}
            </span>
            {connection === "reconnecting" ? (
              <span className="flex items-center gap-1.5 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-score-average">
                <Radio className="size-3 animate-pulse" />
                Reconnecting
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-4 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-muted-foreground tabular-nums">
            <span>
              <span className="text-foreground">{done}</span> done
            </span>
            {error > 0 ? (
              <span>
                <span className="text-score-poor">{error}</span> error
              </span>
            ) : null}
            {running > 0 ? (
              <span>
                <span className="text-primary">{running}</span> running
              </span>
            ) : null}
            <span>
              <span className="text-foreground">{done + error}</span> / {total}
            </span>
          </div>
        </div>
        <Progress value={pct} aria-label="Batch progress" />
      </div>

      <ul className="grid list-none gap-4 p-0 md:grid-cols-2">
        {batch.jobs.map((job) => (
          <li key={job.id}>
            <AuditJobCard job={job} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface AuditJobCardProps {
  job: AuditJob;
  onSelect: (job: AuditJob) => void;
}

const AuditJobCard = memo(function AuditJobCard({
  job,
  onSelect,
}: AuditJobCardProps) {
  const interactive = job.status === "done" || job.status === "error";
  const index = String(job.index + 1).padStart(2, "0");

  // Card-level drift: flag host-power / per-run CPU spread only. Concurrency
  // contention is a batch-wide concern surfaced elsewhere, so pin concurrency 1.
  const drifted =
    job.status === "done" && job.result
      ? assessDrift({
          benchmarkIndices: job.result.perRunEnvironments.map(
            (env) => env.benchmarkIndex,
          ),
          cpuSlowdownMultiplier: job.result.environment.cpuSlowdownMultiplier,
          concurrency: 1,
          performanceInScope:
            job.result.options.categories.includes("performance"),
        }).severity !== "none"
      : false;

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {index}
          </span>
          <span className="truncate font-mono text-sm text-foreground" title={job.url}>
            {job.url.replace(/^https?:\/\//, "")}
          </span>
        </div>
        <JobStatusBadge status={job.status} />
      </div>

      {job.status === "done" && job.result ? (
        <div className="flex flex-col gap-4">
          <EnvironmentBadge
            variant="compact"
            environment={job.result.environment}
            drifted={drifted}
          />
          <ScoreRings scores={job.result.median.scores} size={56} />
          <CoreWebVitalsStrip metrics={job.result.median.metrics} />
        </div>
      ) : job.status === "error" ? (
        <p className="text-sm text-score-poor">
          {job.error?.message ?? "Audit failed."}
        </p>
      ) : (
        <div className="flex flex-col gap-4" aria-hidden>
          <div className="flex gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex flex-col items-center gap-2">
                <Skeleton className="size-14 rounded-full" />
                <Skeleton className="h-2 w-10" />
              </div>
            ))}
          </div>
          <Skeleton className="h-8 w-full" />
        </div>
      )}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={() => onSelect(job)}
        aria-label={`View details for ${job.url}`}
        className="group block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Card
          className={cn(
            "h-full p-5 transition-shadow group-hover:ring-primary/50",
            job.status === "error" && "ring-score-poor/40",
          )}
        >
          {body}
        </Card>
      </button>
    );
  }

  return <Card className="p-5">{body}</Card>;
});
