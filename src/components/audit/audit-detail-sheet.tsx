"use client";

import { useState } from "react";
import {
  Check,
  ExternalLink,
  FileJson,
  Info,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";

import { DriftWarning } from "@/components/audit/drift-warning";
import { EnvironmentBadge } from "@/components/audit/environment-badge";
import { FieldDataPanel } from "@/components/pagespeed/field-data-panel";
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { reportHtmlUrl, reportJsonUrl } from "@/lib/client/auditClient";
import {
  assessDrift,
  benchmarkIndexSpread,
} from "@/lib/lighthouse/drift";
import {
  chromeVersionFromUserAgent,
  formatBenchmarkIndex,
} from "@/lib/lighthouse/environment-format";
import {
  LIGHTHOUSE_CATEGORIES,
  type AuditState,
  type FormFactor,
  type Opportunity,
} from "@/lib/lighthouse/types";
import type { AuditJob, AuditResultLite } from "@/lib/queue/types";
import {
  CATEGORY_LABELS,
  CATEGORY_SHORT_LABELS,
  formatScore,
  METRIC_DISPLAY_ORDER,
  METRIC_META,
  scoreColorClass,
} from "@/lib/scores";
import { cn } from "@/lib/utils";

interface AuditDetailSheetProps {
  /** The job the user clicked — drives the title and the default shown device. */
  job: AuditJob | null;
  /**
   * The clicked job's device pair (PRD §6 Phase 12): the 1–2 jobs in the batch
   * sharing its URL. When it holds both a mobile and a desktop job the header
   * shows a device toggle that flips which job's detail renders; with one job it
   * behaves exactly as before. Optional so older callers keep working.
   */
  jobs?: AuditJob[];
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

/** State icon + screen-reader label for one Best Practices audit. */
function AuditStateIcon({ state }: { state: AuditState }) {
  const meta = {
    passed: { Icon: Check, cls: "text-score-good", label: "Passed" },
    failed: { Icon: X, cls: "text-score-poor", label: "Failed" },
    notApplicable: {
      Icon: Minus,
      cls: "text-muted-foreground/60",
      label: "Not applicable",
    },
    informative: { Icon: Info, cls: "text-muted-foreground", label: "Informative" },
  }[state];
  return (
    <span className={cn("mt-0.5 shrink-0", meta.cls)}>
      <meta.Icon className="size-3.5" aria-hidden />
      <span className="sr-only">{meta.label}: </span>
    </span>
  );
}

/**
 * Per-audit breakdown of the Best Practices category — the lens that explains why
 * this tool's BP score can sit *above* the DevTools panel's. The arithmetic header
 * shows passing weight vs total, and the explainer names the usual culprit (the
 * panel runs your extensions, which fail the binary errors-in-console /
 * deprecations / inspector-issues audits). Mirrors `OpportunitiesPanel`.
 */
function BestPracticesPanel({ result }: { result: AuditResultLite }) {
  const audits = result.median.bestPractices ?? [];
  const score = result.median.scores["best-practices"] ?? null;

  if (audits.length === 0) {
    return (
      <Empty className="border border-border/60 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert />
          </EmptyMedia>
          <EmptyTitle>No Best Practices audits</EmptyTitle>
          <EmptyDescription>
            This run didn&apos;t include the Best Practices category.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  // Only weighted audits move the score; informative/N-A carry weight 0.
  const weighted = audits.filter((a) => a.weight > 0);
  const totalWeight = weighted.reduce((sum, a) => sum + a.weight, 0);
  const passedWeight = weighted
    .filter((a) => a.state === "passed")
    .reduce((sum, a) => sum + a.weight, 0);
  const failing = weighted.filter((a) => a.state === "failed").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "font-mono text-2xl font-semibold tabular-nums tracking-tight",
              scoreColorClass(score),
            )}
          >
            {formatScore(score)}
          </span>
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
            Best Practices
          </span>
        </div>
        <div className="text-right font-mono text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
          {passedWeight}/{totalWeight} weight passing
          {failing > 0 ? (
            <span className="text-score-poor">
              {" "}
              · {failing} failing
            </span>
          ) : null}
        </div>
      </div>

      <Alert>
        <Info />
        <AlertTitle>Why this can differ from DevTools</AlertTitle>
        <AlertDescription>
          A normal Chrome window runs your extensions, which inject console
          errors, deprecated API calls, and Chrome Issues — failing the
          errors-in-console, deprecations, and inspector-issues audits and
          lowering the panel&apos;s score. This tool runs clean headless Chrome
          with no extensions. Run the DevTools Lighthouse panel in an Incognito
          window for an apples-to-apples comparison.
        </AlertDescription>
      </Alert>

      <ScrollArea className="h-72 overscroll-contain rounded-md border border-border/60">
        <ul className="flex flex-col divide-y divide-border/50">
          {audits.map((audit) => (
            <li key={audit.id} className="flex flex-col gap-1 px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <AuditStateIcon state={audit.state} />
                  <p className="min-w-0 text-sm font-medium leading-snug text-balance text-foreground">
                    {audit.title}
                  </p>
                </div>
                {audit.weight > 0 ? (
                  <span
                    className="shrink-0 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground tabular-nums"
                    title={`Scoring weight ${audit.weight}`}
                  >
                    w{audit.weight}
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground/60">
                    {audit.state === "notApplicable" ? "N/A" : "Info"}
                  </span>
                )}
              </div>
              {audit.displayValue ? (
                <p className="pl-[1.375rem] font-mono text-xs leading-relaxed text-muted-foreground">
                  {audit.displayValue}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}

/** Categories Lighthouse scores out of 100, in display order, for the per-run table. */
const RUN_CATEGORY_ORDER = LIGHTHOUSE_CATEGORIES;

function EnvironmentSection({ result }: { result: AuditResultLite }) {
  const assessment = assessDrift({
    benchmarkIndices: result.perRunEnvironments.map((env) => env.benchmarkIndex),
    cpuSlowdownMultiplier: result.environment.cpuSlowdownMultiplier,
    concurrency: 1,
    performanceInScope: result.options.categories.includes("performance"),
  });

  const chromeVersion = chromeVersionFromUserAgent(
    result.environment.hostUserAgent,
  );

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Environment</SectionLabel>
      <EnvironmentBadge
        variant="full"
        environment={result.environment}
        drifted={assessment.severity !== "none"}
      />
      {chromeVersion ? (
        <p
          className="font-mono text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground"
          title={result.environment.hostUserAgent || undefined}
        >
          Chrome{" "}
          <span className="text-foreground tabular-nums">{chromeVersion}</span>
        </p>
      ) : null}
      <DriftWarning assessment={assessment} calibrateHref="/" />
    </section>
  );
}

/**
 * Per-run breakdown: each run's category scores + its `benchmarkIndex`, plus a
 * one-line benchmarkIndex spread summary. Closes §8's "surface per-run spread"
 * for both the score and CPU dimensions. Only meaningful when runs > 1.
 */
function PerRunSpread({ result }: { result: AuditResultLite }) {
  const spread = benchmarkIndexSpread(
    result.perRunEnvironments.map((env) => env.benchmarkIndex),
  );

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Per-run spread · {result.runs} runs</SectionLabel>
      <div className="overflow-hidden rounded-md border border-border/60">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Per-run category scores and host CPU benchmark index
          </caption>
          <thead>
            <tr className="border-b border-border/60 bg-muted/30">
              <th
                scope="col"
                className="px-3 py-2 font-mono text-[0.6rem] font-medium uppercase tracking-[0.14em] text-muted-foreground"
              >
                Run
              </th>
              {RUN_CATEGORY_ORDER.map((category) => (
                <th
                  key={category}
                  scope="col"
                  className="px-2 py-2 text-right font-mono text-[0.6rem] font-medium uppercase tracking-[0.14em] text-muted-foreground"
                >
                  {CATEGORY_SHORT_LABELS[category]}
                </th>
              ))}
              <th
                scope="col"
                className="px-3 py-2 text-right font-mono text-[0.6rem] font-medium uppercase tracking-[0.14em] text-muted-foreground"
                title="Host CPU/Memory Power (Lighthouse benchmarkIndex) for this run"
              >
                CPU
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {result.perRunScores.map((scores, i) => {
              const env = result.perRunEnvironments[i];
              return (
                <tr key={i} className="bg-card">
                  <th
                    scope="row"
                    className="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground"
                  >
                    {String(i + 1).padStart(2, "0")}
                  </th>
                  {RUN_CATEGORY_ORDER.map((category) => {
                    const score = scores[category] ?? null;
                    return (
                      <td
                        key={category}
                        className={cn(
                          "px-2 py-2 text-right font-mono text-sm tabular-nums",
                          scoreColorClass(score),
                        )}
                      >
                        {formatScore(score)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-foreground">
                    {formatBenchmarkIndex(env?.benchmarkIndex ?? null)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {spread ? (
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground tabular-nums">
          Benchmark spread{" "}
          <span className="text-foreground">
            {formatBenchmarkIndex(spread.min)}–{formatBenchmarkIndex(spread.max)}
          </span>{" "}
          across {spread.count} {spread.count === 1 ? "run" : "runs"}
        </p>
      ) : null}
    </section>
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

          {result.field ? (
            <>
              <Separator className="bg-border/60" />
              <section className="flex flex-col gap-3">
                <SectionLabel>Field data · CrUX</SectionLabel>
                <FieldDataPanel field={result.field} />
              </section>
            </>
          ) : null}

          <Separator className="bg-border/60" />

          <EnvironmentSection result={result} />

          <Separator className="bg-border/60" />

          <section className="flex flex-col gap-3">
            <SectionLabel>Metrics · median run</SectionLabel>
            <MetricsList result={result} />
          </section>

          {result.runs > 1 ? (
            <>
              <Separator className="bg-border/60" />
              <PerRunSpread result={result} />
            </>
          ) : null}

          {result.options.categories.includes("best-practices") &&
          (result.median.bestPractices?.length ?? 0) > 0 ? (
            <>
              <Separator className="bg-border/60" />
              <section className="flex flex-col gap-3">
                <SectionLabel>Best Practices audits</SectionLabel>
                <BestPracticesPanel result={result} />
              </section>
            </>
          ) : null}

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
  const cancelled = job.status === "cancelled";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      {running ? <Spinner className="text-primary" /> : null}
      <p className="text-sm text-muted-foreground">
        {cancelled
          ? "Cancelled before scoring."
          : running
            ? "Audit in progress…"
            : "Queued — waiting to start…"}
      </p>
    </div>
  );
}

/** The single-job description line: median-of-N · device · Lighthouse version. */
function jobDescription(job: AuditJob): string | null {
  if (job.status === "done" && job.result) {
    const chrome = chromeVersionFromUserAgent(
      job.result.environment.hostUserAgent,
    );
    return `Median of ${job.result.runs} ${
      job.result.runs === 1 ? "run" : "runs"
    } · ${job.result.options.formFactor} · Lighthouse v${
      job.result.lighthouseVersion
    }${chrome ? ` · Chrome ${chrome}` : ""}`;
  }
  return null;
}

/** One job's body, switched on status (done → full detail, error, or pending). */
function JobBody({ job }: { job: AuditJob }) {
  if (job.status === "done" && job.result) {
    return <DoneBody job={job} result={job.result} />;
  }
  if (job.status === "error") return <ErrorBody job={job} />;
  return <PendingBody job={job} />;
}

interface SheetBodyProps {
  /** The clicked job — seeds the active device and the title. */
  clicked: AuditJob;
  jobs: AuditJob[];
}

/**
 * Device-aware sheet body. Splits the pair into mobile/desktop; when both are
 * present it renders a header device toggle (defaulting to the clicked device)
 * that flips which job's detail shows. Keyed by the clicked job id from the shell
 * so the active-device state resets cleanly each time a new job is opened.
 */
function SheetBody({ clicked, jobs }: SheetBodyProps) {
  const mobile = jobs.find((j) => j.device === "mobile") ?? null;
  const desktop = jobs.find((j) => j.device === "desktop") ?? null;
  const hasBoth = mobile !== null && desktop !== null;

  const [device, setDevice] = useState<FormFactor>(clicked.device);
  // The job whose detail is shown: the toggled device when paired, else the
  // single job we have (falling back to the clicked one).
  const active =
    (device === "desktop" ? desktop : mobile) ?? mobile ?? desktop ?? clicked;

  const title = active.result?.finalUrl ?? active.url;
  const description = jobDescription(active);

  function handleDeviceChange(value: string) {
    if (value === "mobile" || value === "desktop") setDevice(value);
  }

  return (
    <>
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
        {hasBoth ? (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={device}
            onValueChange={handleDeviceChange}
            aria-label="Device"
            className="mt-1 w-full"
          >
            <ToggleGroupItem value="mobile" className="flex-1">
              Mobile
            </ToggleGroupItem>
            <ToggleGroupItem value="desktop" className="flex-1">
              Desktop
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </SheetHeader>

      <JobBody job={active} />
    </>
  );
}

export function AuditDetailSheet({
  job,
  jobs,
  open,
  onOpenChange,
}: AuditDetailSheetProps) {
  // Prefer the explicit pair; fall back to the single clicked job for older
  // callers that don't pass `jobs`.
  const pair = jobs && jobs.length > 0 ? jobs : job ? [job] : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/*
        Width override. The Sheet primitive's defaults are
        `data-[side=right]:w-3/4 data-[side=right]:sm:max-w-sm` — the
        `data-[side=right]:` qualifier outranks an unqualified `sm:max-w-xl` by
        CSS specificity, which silently capped this sheet at 384px and chopped
        off the SEO score, metric values, and opportunity displayValues. We
        re-qualify with `data-[side=right]:` so tw-merge can actually replace
        the base, and tier the cap so the dense readout earns more width as the
        viewport grows: 672px at sm+, 768px at lg+, 896px at 2xl+.
      */}
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-2xl lg:data-[side=right]:max-w-3xl 2xl:data-[side=right]:max-w-4xl"
      >
        {job ? (
          // Key by the clicked job so the active-device state resets per open.
          <SheetBody key={job.id} clicked={job} jobs={pair} />
        ) : (
          <SheetHeader className="border-b border-border/60 pr-12">
            <SheetTitle className="truncate font-mono text-sm" />
            <SheetDescription className="sr-only">
              Audit result detail
            </SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}
