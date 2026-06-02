"use client";

/**
 * Live results panel (PRD §6 Phase 3): a responsive grid of per-URL audit cards
 * fed by a {@link Batch} snapshot from `useBatchStream`. Cards update in place as
 * jobs move queued → running → done/error; a done or errored card opens the
 * detail sheet via `onSelect`. Pure view — all state lives in the console parent.
 */

import { memo } from "react";
import { Ban, Radio } from "lucide-react";

import { CoreWebVitalsStrip } from "@/components/audit/core-web-vitals";
import { EnvironmentBadge } from "@/components/audit/environment-badge";
import { FieldAssessmentChip } from "@/components/pagespeed/field-metric-bar";
import { ResultsTable } from "@/components/audit/results-table";
import { ResultsViewToggle } from "@/components/audit/results-view-toggle";
import { ScoreRings } from "@/components/audit/score-rings";
import { JobStatusBadge } from "@/components/audit/status-badge";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuditDefaults } from "@/hooks/useAuditDefaults";
import { assessDrift } from "@/lib/lighthouse/drift";
import { hasBothDevices, pairByDevice } from "@/lib/pairing/devicePairs";
import { cn } from "@/lib/utils";
import type { StreamConnection } from "@/hooks/useBatchStream";
import type { AuditJob, AuditResultLite, Batch } from "@/lib/queue/types";

interface AuditResultsProps {
  batch: Batch;
  connection: StreamConnection;
  onSelect: (job: AuditJob) => void;
  /** Cancel the in-flight batch (queued jobs dropped, running workers killed). */
  onCancel: () => void;
  /** True while a cancel request is in flight (disables the button). */
  cancelling: boolean;
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
  cancelled: "Cancelled",
};

interface HostGroup {
  host: string;
  jobs: AuditJob[];
}

/**
 * Group jobs by their URL's hostname, preserving first-appearance order so the
 * accordion sections track input order. A malformed URL falls back to the raw
 * string rather than crashing the render.
 */
function groupJobsByHost(jobs: AuditJob[]): HostGroup[] {
  const groups = new Map<string, AuditJob[]>();
  for (const job of jobs) {
    let host: string;
    try {
      host = new URL(job.url).hostname;
    } catch {
      host = job.url;
    }
    const existing = groups.get(host);
    if (existing) existing.push(job);
    else groups.set(host, [job]);
  }
  return Array.from(groups, ([host, hostJobs]) => ({ host, jobs: hostJobs }));
}

export function AuditResults({
  batch,
  connection,
  onSelect,
  onCancel,
  cancelling,
}: AuditResultsProps) {
  const { defaults, update } = useAuditDefaults();
  const view = defaults.resultsView;
  const pct = batchProgress(batch);
  const { total, done, error, running } = batch.counts;
  const groups = groupJobsByHost(batch.jobs);
  // The batch can still be stopped while any job is outstanding.
  const canCancel = batch.status === "queued" || batch.status === "running";
  // Only the first website opens on load; the rest start collapsed. Keyed by
  // batch id so a new batch resets to "first open".
  const firstHost = groups[0]?.host;

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
          <div className="flex items-center gap-4">
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
            <ResultsViewToggle
              value={view}
              onChange={(next) => update({ resultsView: next })}
            />
            {canCancel ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onCancel}
                disabled={cancelling}
                aria-label="Cancel audit"
                className="border-score-poor/40 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-score-poor hover:bg-score-poor/10 hover:text-score-poor"
              >
                <Ban data-icon="inline-start" />
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            ) : null}
          </div>
        </div>
        <Progress value={pct} aria-label="Batch progress" />
      </div>

      <Accordion
        key={batch.id}
        type="multiple"
        defaultValue={firstHost ? [firstHost] : []}
        className="flex flex-col gap-2"
      >
        {groups.map((group) => {
          const groupDone = group.jobs.filter((j) => j.status === "done").length;
          const groupError = group.jobs.filter(
            (j) => j.status === "error",
          ).length;
          return (
            <AccordionItem
              key={group.host}
              value={group.host}
              className="rounded-lg border border-border/60 bg-card/40 px-4"
            >
              <AccordionTrigger className="items-center hover:no-underline">
                <span className="flex flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1 pr-3">
                  <span className="font-mono text-sm text-foreground">
                    {group.host}
                  </span>
                  <span className="flex items-center gap-4 font-mono text-[0.7rem] uppercase tracking-[0.16em] text-muted-foreground tabular-nums">
                    {groupError > 0 ? (
                      <span>
                        <span className="text-score-poor">{groupError}</span>{" "}
                        error
                      </span>
                    ) : null}
                    <span>
                      <span className="text-foreground">{groupDone}</span> /{" "}
                      {group.jobs.length}
                    </span>
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                {view === "table" ? (
                  <div className="pt-1">
                    <ResultsTable jobs={group.jobs} onSelect={onSelect} />
                  </div>
                ) : (
                  <CardsGrid jobs={group.jobs} onSelect={onSelect} />
                )}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </section>
  );
}

interface CardsGridProps {
  jobs: AuditJob[];
  onSelect: (job: AuditJob) => void;
}

/**
 * The ring-card grid for one host group. Device-aware: when the group's jobs span
 * both mobile + desktop it renders one {@link PairedAuditCard} per URL (both
 * ring-sets stacked); otherwise one {@link AuditJobCard} per job, unchanged.
 */
function CardsGrid({ jobs, onSelect }: CardsGridProps) {
  const paired = hasBothDevices(jobs, (job) => job.device);

  if (paired) {
    const pairs = pairByDevice(
      jobs,
      (job) => job.url,
      (job) => job.device,
    );
    return (
      <ul className="grid list-none gap-4 p-0 pt-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 min-[1920px]:grid-cols-5 min-[2400px]:grid-cols-6">
        {pairs.map((pair) => (
          <li key={pair.url}>
            <PairedAuditCard
              url={pair.url}
              mobile={pair.mobile}
              desktop={pair.desktop}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="grid list-none gap-4 p-0 pt-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 min-[1920px]:grid-cols-6 min-[2400px]:grid-cols-7">
      {jobs.map((job) => (
        <li key={job.id}>
          <AuditJobCard job={job} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

/** Mono uppercase device caption ("Mobile" / "Desktop") matching the house label style. */
const DEVICE_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/**
 * Compact real-world (CrUX) assessment for a result card — the at-a-glance field
 * verdict alongside the lab rings. Renders nothing for local runs (no `field`);
 * for PSI runs it shows the overall URL (else origin) assessment, or a "no CrUX
 * data" note when the page has insufficient real-user traffic.
 */
function CardFieldRow({ result }: { result: AuditResultLite }) {
  if (!result.field) return null;
  const category =
    result.field.url?.overallCategory ??
    result.field.origin?.overallCategory ??
    null;
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
        Field
      </span>
      {category ? (
        <FieldAssessmentChip category={category} />
      ) : (
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground/60">
          No CrUX data
        </span>
      )}
    </div>
  );
}

interface DeviceSectionProps {
  device: "Mobile" | "Desktop";
  job: AuditJob | null;
  url: string;
  onSelect: (job: AuditJob) => void;
}

/**
 * One device's ring-set within a {@link PairedAuditCard}: a device caption + the
 * job's status, then the four rings (done), an error line (error), skeleton rings
 * (pending), or an em-dash placeholder when this URL wasn't audited on this
 * device. A done/errored section is a button that opens that job's detail sheet.
 */
function DeviceSection({ device, job, url, onSelect }: DeviceSectionProps) {
  const interactive = job?.status === "done" || job?.status === "error";

  const header = (
    <div className="flex items-center justify-between gap-2">
      <span className={DEVICE_LABEL}>{device}</span>
      {job ? <JobStatusBadge status={job.status} /> : null}
    </div>
  );

  let body: React.ReactNode;
  if (!job) {
    body = (
      <p className="font-mono text-xs text-muted-foreground/50">
        Not audited on {device.toLowerCase()}
      </p>
    );
  } else if (job.status === "done" && job.result) {
    body = (
      <div className="flex flex-col gap-3">
        <ScoreRings scores={job.result.median.scores} size={48} />
        <CoreWebVitalsStrip metrics={job.result.median.metrics} />
        <CardFieldRow result={job.result} />
      </div>
    );
  } else if (job.status === "error") {
    body = (
      <p className="text-sm text-score-poor">
        {job.error?.message ?? "Audit failed."}
      </p>
    );
  } else if (job.status === "cancelled") {
    body = (
      <p className="font-mono text-xs text-muted-foreground/60">
        Cancelled before scoring.
      </p>
    );
  } else {
    body = (
      <div className="flex gap-5" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <Skeleton className="size-12 rounded-full" />
            <Skeleton className="h-2 w-9" />
          </div>
        ))}
      </div>
    );
  }

  const content = (
    <div className="flex flex-col gap-3">
      {header}
      {body}
    </div>
  );

  if (interactive && job) {
    return (
      <button
        type="button"
        onClick={() => onSelect(job)}
        aria-label={`View ${device.toLowerCase()} details for ${url}`}
        className={cn(
          "group/device block w-full rounded-lg text-left outline-none transition-colors",
          "hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {content}
      </button>
    );
  }
  return content;
}

interface PairedAuditCardProps {
  url: string;
  mobile: AuditJob | null;
  desktop: AuditJob | null;
  onSelect: (job: AuditJob) => void;
}

/**
 * One card per URL carrying BOTH device ring-sets (PRD §6 Phase 12). The header
 * names the URL; the body stacks a Mobile and a Desktop {@link DeviceSection},
 * each clickable into that device's detail sheet. Used only when a batch ran
 * "both"; single-device batches keep the one-card-per-job {@link AuditJobCard}.
 */
const PairedAuditCard = memo(function PairedAuditCard({
  url,
  mobile,
  desktop,
  onSelect,
}: PairedAuditCardProps) {
  return (
    <Card className="flex h-full flex-col gap-4 p-5">
      <span
        className="truncate font-mono text-sm text-foreground"
        title={url}
      >
        {url.replace(/^https?:\/\//, "")}
      </span>
      <DeviceSection device="Mobile" job={mobile} url={url} onSelect={onSelect} />
      <div className="border-t border-border/50" />
      <DeviceSection device="Desktop" job={desktop} url={url} onSelect={onSelect} />
    </Card>
  );
});

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
          <ScoreRings scores={job.result.median.scores} size={48} />
          <CoreWebVitalsStrip metrics={job.result.median.metrics} />
          <CardFieldRow result={job.result} />
        </div>
      ) : job.status === "error" ? (
        <p className="text-sm text-score-poor">
          {job.error?.message ?? "Audit failed."}
        </p>
      ) : job.status === "cancelled" ? (
        <p className="font-mono text-xs text-muted-foreground/60">
          Cancelled before scoring.
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
