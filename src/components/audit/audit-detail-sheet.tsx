"use client";

import { ExternalLink, FileJson, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { reportHtmlUrl, reportJsonUrl } from "@/lib/client/auditClient";
import {
  LIGHTHOUSE_CATEGORIES,
  type Opportunity,
} from "@/lib/lighthouse/types";
import type { AuditJob, AuditResultLite } from "@/lib/queue/types";
import {
  CATEGORY_LABELS,
  formatScore,
  METRIC_DISPLAY_ORDER,
  METRIC_META,
  scoreColorClass,
} from "@/lib/scores";
import { cn } from "@/lib/utils";

interface AuditDetailSheetProps {
  job: AuditJob | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Mono uppercase tracking section label, matching the house "precision instrument" style. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
      {children}
    </p>
  );
}

/** Sort opportunities by estimated savings (desc); nulls sink to the bottom. */
function sortOpportunities(opportunities: Opportunity[]): Opportunity[] {
  return opportunities.toSorted((a, b) => {
    if (a.savingsMs === null && b.savingsMs === null) return 0;
    if (a.savingsMs === null) return 1;
    if (b.savingsMs === null) return -1;
    return b.savingsMs - a.savingsMs;
  });
}

function CategoryScoreGrid({ result }: { result: AuditResultLite }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60 sm:grid-cols-4">
      {LIGHTHOUSE_CATEGORIES.map((category) => {
        const score = result.median.scores[category] ?? null;
        return (
          <div
            key={category}
            className="flex flex-col items-center gap-1.5 bg-card px-2 py-4"
          >
            <span
              className={cn(
                "font-mono text-3xl font-semibold tabular-nums tracking-tight",
                scoreColorClass(score)
              )}
            >
              {formatScore(score)}
            </span>
            <span className="text-center font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
              {CATEGORY_LABELS[category]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MetricsList({ result }: { result: AuditResultLite }) {
  return (
    <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border/60 bg-border/60">
      {METRIC_DISPLAY_ORDER.map((id) => {
        const metric = result.median.metrics[id] ?? null;
        const meta = METRIC_META[id];
        const score = metric?.score ?? null;
        return (
          <div
            key={id}
            className="flex items-center justify-between gap-3 bg-card px-3 py-2"
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="font-mono text-[0.6rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {meta.abbr}
              </span>
              <span className="truncate text-sm text-foreground">
                {meta.label}
              </span>
            </div>
            <span
              className={cn(
                "shrink-0 font-mono text-sm tabular-nums",
                scoreColorClass(score === null ? null : score * 100)
              )}
            >
              {metric?.displayValue ?? "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function OpportunitiesPanel({ result }: { result: AuditResultLite }) {
  const opportunities = sortOpportunities(result.median.opportunities);

  if (opportunities.length === 0) {
    return (
      <Empty className="border border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert />
          </EmptyMedia>
          <EmptyTitle>No opportunities flagged</EmptyTitle>
          <EmptyDescription>
            Lighthouse surfaced no actionable diagnostics for this run.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ScrollArea className="h-72 overscroll-contain rounded-md border border-border/60">
      <ul className="flex flex-col divide-y divide-border/50">
        {opportunities.map((opportunity) => (
          <li key={opportunity.id} className="flex flex-col gap-1 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm font-medium leading-snug text-balance text-foreground">
                {opportunity.title}
              </p>
              {opportunity.displayValue ? (
                <span
                  className={cn(
                    "shrink-0 font-mono text-xs tabular-nums",
                    scoreColorClass(
                      opportunity.score === null ? null : opportunity.score * 100
                    )
                  )}
                >
                  {opportunity.displayValue}
                </span>
              ) : null}
            </div>
            {opportunity.description ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {opportunity.description}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

function DoneBody({ job, result }: { job: AuditJob; result: AuditResultLite }) {
  return (
    <>
      <ScrollArea className="min-h-0 flex-1 overscroll-contain">
        <div className="flex flex-col gap-6 p-4">
          {result.runWarnings.length > 0 ? (
            <Alert>
              <TriangleAlert />
              <AlertTitle>
                {result.runWarnings.length === 1
                  ? "1 run warning"
                  : `${result.runWarnings.length} run warnings`}
              </AlertTitle>
              <AlertDescription>
                <ul className="flex flex-col gap-1">
                  {result.runWarnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <section className="flex flex-col gap-3">
            <SectionLabel>Category scores</SectionLabel>
            <CategoryScoreGrid result={result} />
          </section>

          <Separator className="bg-border/60" />

          <section className="flex flex-col gap-3">
            <SectionLabel>Metrics · median run</SectionLabel>
            <MetricsList result={result} />
          </section>

          <Separator className="bg-border/60" />

          <section className="flex flex-col gap-3">
            <SectionLabel>Opportunities &amp; diagnostics</SectionLabel>
            <OpportunitiesPanel result={result} />
          </section>
        </div>
      </ScrollArea>

      <SheetFooter className="border-t border-border/60">
        <Button asChild className="w-full">
          <a href={reportHtmlUrl(job.id)} target="_blank" rel="noopener noreferrer">
            <ExternalLink data-icon="inline-start" />
            Open full HTML report
          </a>
        </Button>
        <Button asChild variant="ghost" size="sm" className="w-full">
          <a href={reportJsonUrl(job.id)} target="_blank" rel="noopener noreferrer">
            <FileJson data-icon="inline-start" />
            Raw JSON
          </a>
        </Button>
      </SheetFooter>
    </>
  );
}

function ErrorBody({ job }: { job: AuditJob }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Audit failed</AlertTitle>
        <AlertDescription>
          {job.error?.message ?? "The audit ended with an unknown error."}
        </AlertDescription>
      </Alert>
    </div>
  );
}

function PendingBody({ job }: { job: AuditJob }) {
  const running = job.status === "running";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {running ? <Spinner className="text-primary" /> : null}
      <p className="text-sm text-muted-foreground">
        {running ? "Audit in progress…" : "Queued — waiting to start…"}
      </p>
    </div>
  );
}

export function AuditDetailSheet({
  job,
  open,
  onOpenChange,
}: AuditDetailSheetProps) {
  const title = job ? job.result?.finalUrl ?? job.url : "";

  const description =
    job?.status === "done" && job.result
      ? `Median of ${job.result.runs} ${
          job.result.runs === 1 ? "run" : "runs"
        } · ${job.result.options.formFactor} · Lighthouse v${
          job.result.lighthouseVersion
        }`
      : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b border-border/60 pr-12">
          <SheetTitle className="truncate font-mono text-sm">{title}</SheetTitle>
          {description ? (
            <SheetDescription className="font-mono text-xs">
              {description}
            </SheetDescription>
          ) : (
            <SheetDescription className="sr-only">
              Audit result detail
            </SheetDescription>
          )}
        </SheetHeader>

        {job?.status === "done" && job.result ? (
          <DoneBody job={job} result={job.result} />
        ) : job?.status === "error" ? (
          <ErrorBody job={job} />
        ) : job ? (
          <PendingBody job={job} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
