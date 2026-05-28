"use client";

/**
 * Batch summary console (PRD §6 Phase 6 — Comparison & trends).
 *
 * Renders one card per persisted batch (newest-first) with: average score per
 * category, best/worst page by overall score, and pass/fail counts against
 * **user-configurable per-category thresholds**. Thresholds are persisted via
 * {@link useAuditDefaults} (shared with the New Audit form) and all summaries
 * are derived with `useMemo` from the runs handed down by the server page. Each
 * card can also export its own runs (JSON/CSV) and bulk-open their reports.
 */

import { useCallback, useId, useMemo } from "react";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  FileJson,
  Loader2,
  Sheet,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { DriftWarning } from "@/components/audit/drift-warning";
import { EnvironmentBadge } from "@/components/audit/environment-badge";
import { ScoreRing } from "@/components/audit/score-ring";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuditDefaults } from "@/hooks/useAuditDefaults";
import { reportHtmlUrl } from "@/lib/client/auditClient";
import type { BatchInfo, HistoryRow } from "@/lib/db/persistence";
import {
  downloadCsv,
  downloadJson,
  openUrlsInNewTabs,
  timestampSlug,
} from "@/lib/export/download";
import { rowsToCsv, rowsToJson } from "@/lib/export/exporters";
import { assessDrift, benchmarkIndexSpread } from "@/lib/lighthouse/drift";
import { formatBenchmarkIndex } from "@/lib/lighthouse/environment-format";
import { LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";
import { hasBothDevices } from "@/lib/pairing/devicePairs";
import type { CategoryThresholds } from "@/lib/settings/defaults";
import {
  CATEGORY_SHORT_LABELS,
  formatScore,
  scoreColorClass,
} from "@/lib/scores";
import { cn } from "@/lib/utils";
import {
  averageScores,
  bestWorstPages,
  groupRunsByBatch,
  overallScore,
  passFail,
  type PassFailByCategory,
} from "@/lib/batch-summary/summary";

/** Mono uppercase tracked section label — the house "telemetry" label style. */
const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/** Lifecycle label + Badge variant + leading icon for each batch status. */
const STATUS_META: Record<
  BatchInfo["status"],
  {
    label: string;
    variant: React.ComponentProps<typeof Badge>["variant"];
    icon: React.ComponentType<{ className?: string; "data-icon"?: string }>;
    className?: string;
  }
> = {
  queued: { label: "Queued", variant: "secondary", icon: Clock },
  running: { label: "Running", variant: "default", icon: Loader2 },
  completed: {
    label: "Completed",
    variant: "outline",
    icon: CheckCircle2,
    className: "border-score-good/40 text-score-good",
  },
  completed_with_errors: {
    label: "Completed · errors",
    variant: "outline",
    icon: TriangleAlert,
    className: "border-score-average/40 text-score-average",
  },
};

/** Format an ISO timestamp into a readable local datetime; falls back to the raw string. */
function formatBatchAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Strip the scheme for a compact, scannable URL label (full URL stays in the title/tooltip). */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

interface BatchSummaryConsoleProps {
  batches: BatchInfo[];
  runs: HistoryRow[];
}

export function BatchSummaryConsole({ batches, runs }: BatchSummaryConsoleProps) {
  // Thresholds are persisted in the shared audit-defaults store. Until the
  // persisted blob has loaded we render the factory defaults but must NOT write
  // them back — that would clobber a user's saved values on first render.
  const { defaults, update, loaded } = useAuditDefaults();
  const thresholds = defaults.thresholds;

  const setThresholds = useCallback(
    (next: CategoryThresholds) => {
      if (!loaded) return;
      update({ thresholds: next });
    },
    [loaded, update],
  );

  // Group once; each batch card slices its own runs out of the map.
  const runsByBatch = useMemo(() => groupRunsByBatch(runs), [runs]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-6">
        <ThresholdControls thresholds={thresholds} onChange={setThresholds} />

        <ul className="grid list-none grid-cols-1 gap-5 p-0 xl:grid-cols-2 2xl:grid-cols-3">
          {batches.map((batch) => (
            <li key={batch.id}>
              <BatchCard
                batch={batch}
                rows={runsByBatch.get(batch.id) ?? []}
                thresholds={thresholds}
              />
            </li>
          ))}
        </ul>
      </div>
    </TooltipProvider>
  );
}

interface ThresholdControlsProps {
  thresholds: CategoryThresholds;
  onChange: (next: CategoryThresholds) => void;
}

/** The configurable per-category pass-threshold row (defaults to 90 / GOOD_THRESHOLD). */
function ThresholdControls({ thresholds, onChange }: ThresholdControlsProps) {
  const groupId = useId();

  return (
    <section
      aria-labelledby={`${groupId}-legend`}
      className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${groupId}-legend`} className={SECTION_LABEL}>
          Pass thresholds
        </span>
        <span className="font-mono text-[0.65rem] text-muted-foreground tabular-nums">
          score ≥ threshold passes
        </span>
      </div>
      <FieldGroup className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {LIGHTHOUSE_CATEGORIES.map((category) => {
          const inputId = `${groupId}-${category}`;
          return (
            <Field key={category}>
              <FieldLabel htmlFor={inputId} className={SECTION_LABEL}>
                {CATEGORY_SHORT_LABELS[category]}
              </FieldLabel>
              <Input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                value={thresholds[category]}
                onChange={(event) => {
                  // Ignore transient empty/invalid input so the field doesn't
                  // snap to 0 mid-edit; clamp committed values to 0–100.
                  const raw = event.target.valueAsNumber;
                  if (Number.isNaN(raw)) return;
                  const next = Math.min(100, Math.max(0, Math.round(raw)));
                  onChange({ ...thresholds, [category]: next });
                }}
                className="font-mono text-sm tabular-nums"
              />
            </Field>
          );
        })}
      </FieldGroup>
    </section>
  );
}

interface BatchCardProps {
  batch: BatchInfo;
  rows: HistoryRow[];
  thresholds: CategoryThresholds;
}

function BatchCard({ batch, rows, thresholds }: BatchCardProps) {
  const summary = useMemo(
    () => ({
      averages: averageScores(rows),
      pages: bestWorstPages(rows),
      passFail: passFail(rows, thresholds),
    }),
    [rows, thresholds],
  );

  // Host-environment readout for the whole batch (PRD §6 Phase 10): all runs
  // share `options`, so we derive a representative env — mean benchmarkIndex
  // across runs for the power reading, first non-null run's throttling
  // method/multiplier — and a drift assessment over the per-run indices.
  const env = useMemo(() => {
    const benchmarkIndices = rows.map((row) => row.environment?.benchmarkIndex ?? null);
    const spread = benchmarkIndexSpread(benchmarkIndices);
    const firstEnv = rows.find((row) => row.environment)?.environment ?? null;
    const performanceInScope = batch.options.categories.includes("performance");

    const assessment = assessDrift({
      benchmarkIndices,
      cpuSlowdownMultiplier: batch.options.cpuSlowdownMultiplier,
      concurrency: batch.concurrency,
      performanceInScope,
    });

    const representative = firstEnv
      ? {
          benchmarkIndex: spread?.mean ?? null,
          hostUserAgent: "",
          throttlingMethod: firstEnv.throttlingMethod,
          cpuSlowdownMultiplier:
            firstEnv.cpuSlowdownMultiplier ??
            batch.options.cpuSlowdownMultiplier ??
            null,
        }
      : null;

    return { spread, assessment, representative };
  }, [rows, batch.options, batch.concurrency]);

  const doneCount = useMemo(
    () => rows.filter((row) => row.status === "done").length,
    [rows],
  );
  const errorCount = rows.length - doneCount;

  // True device for the batch (PRD §6 Phase 12): `batch.options.formFactor` only
  // records a single representative, so a "both" batch would mislabel. Derive it
  // from the runs — "both" when they span mobile + desktop, else the lone device.
  const deviceLabel = useMemo(
    () =>
      hasBothDevices(rows, (row) => row.formFactor)
        ? "both"
        : batch.options.formFactor,
    [rows, batch.options.formFactor],
  );

  const status = STATUS_META[batch.status];
  const StatusIcon = status.icon;
  const shortId = batch.id.slice(0, 8);

  return (
    <Card>
      <CardHeader className="gap-3 border-b border-border/60 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-foreground tabular-nums">
              {shortId}
            </span>
            <Badge
              variant={status.variant}
              className={cn(
                "gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.18em]",
                status.className,
              )}
            >
              <StatusIcon
                data-icon="inline-start"
                className={batch.status === "running" ? "animate-spin" : undefined}
              />
              {status.label}
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <BatchActions rows={rows} shortId={shortId} />
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatBatchAt(batch.createdAt)}
            </span>
          </div>
        </div>

        {/* Telemetry strip: device · runs · pages · done/error tallies. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-muted-foreground tabular-nums">
          <Badge
            variant="outline"
            className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground"
          >
            {deviceLabel}
          </Badge>
          <span>
            <span className="text-foreground">{batch.options.runs}</span>× runs
          </span>
          <span>
            <span className="text-foreground">{batch.total}</span> pages
          </span>
          <span>
            <span className="text-score-good">{doneCount}</span> done
          </span>
          {errorCount > 0 ? (
            <span>
              <span className="text-score-poor">{errorCount}</span> error
            </span>
          ) : null}
          {env.representative ? (
            <EnvironmentBadge
              environment={env.representative}
              variant="compact"
              drifted={env.assessment.severity !== "none"}
            />
          ) : null}
        </div>

        {/* Drift warning — full-width alert; renders null when there's no drift. */}
        <DriftWarning assessment={env.assessment} calibrateHref="/" />
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {doneCount === 0 ? (
          <p className="text-sm text-muted-foreground">
            No completed runs in this batch
            {errorCount > 0 ? ` — all ${errorCount} failed.` : "."}
          </p>
        ) : (
          <>
            {/* Averages — one score ring per category present across done runs. */}
            <section className="flex flex-col gap-3" aria-label="Average scores">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className={SECTION_LABEL}>Average scores</span>
                {env.spread && env.spread.count > 1 ? (
                  <span className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
                    Host power{" "}
                    <span className="text-foreground">
                      {formatBenchmarkIndex(env.spread.min)}–
                      {formatBenchmarkIndex(env.spread.max)}
                    </span>{" "}
                    across {env.spread.count} runs
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                {LIGHTHOUSE_CATEGORIES.map((category) => (
                  <ScoreRing
                    key={category}
                    score={summary.averages[category] ?? null}
                    label={CATEGORY_SHORT_LABELS[category]}
                    size={60}
                  />
                ))}
              </div>
            </section>

            <Separator className="bg-border/60" />

            {/* Best / worst page by overall score. */}
            <section
              className="grid gap-4 sm:grid-cols-2"
              aria-label="Best and worst pages"
            >
              <PageHighlight
                label="Best page"
                row={summary.pages.best}
                accent="good"
              />
              <PageHighlight
                label="Worst page"
                row={summary.pages.worst}
                accent="poor"
              />
            </section>

            <Separator className="bg-border/60" />

            {/* Pass / fail vs configured thresholds. */}
            <PassFailGrid
              passFail={summary.passFail}
              thresholds={thresholds}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface BatchActionsProps {
  rows: HistoryRow[];
  shortId: string;
}

/**
 * Per-batch export + bulk-open toolbar. Serializes this batch's runs to a file
 * (in the click handler, never on render) and opens every run that has a stored
 * HTML report in a new tab — warning via toast if the popup blocker stopped any.
 */
function BatchActions({ rows, shortId }: BatchActionsProps) {
  // Runs in this batch that actually have an HTML report to open.
  const openableHrefs = useMemo(
    () =>
      rows
        .filter((row) => row.status !== "error" && row.hasHtmlReport)
        .map((row) => reportHtmlUrl(row.id)),
    [rows],
  );
  const hasRows = rows.length > 0;
  const openableCount = openableHrefs.length;

  const baseName = `lighthouse-batch-${shortId}-${timestampSlug()}`;

  const exportJson = useCallback(() => {
    downloadJson(
      `lighthouse-batch-${shortId}-${timestampSlug()}.json`,
      rowsToJson(rows),
    );
  }, [rows, shortId]);

  const exportCsv = useCallback(() => {
    downloadCsv(
      `lighthouse-batch-${shortId}-${timestampSlug()}.csv`,
      rowsToCsv(rows),
    );
  }, [rows, shortId]);

  const openAll = useCallback(() => {
    const opened = openUrlsInNewTabs(openableHrefs);
    if (opened < openableHrefs.length) {
      toast.warning("Some reports didn't open", {
        description: `Opened ${opened} of ${openableHrefs.length} — your browser's popup blocker may have stopped the rest.`,
      });
    }
  }, [openableHrefs]);

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportJson}
            disabled={!hasRows}
            aria-label={`Export batch ${shortId} as JSON`}
          >
            <FileJson data-icon="inline-start" />
            JSON
          </Button>
        </TooltipTrigger>
        <TooltipContent className="font-mono">{baseName}.json</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={!hasRows}
            aria-label={`Export batch ${shortId} as CSV`}
          >
            <Sheet data-icon="inline-start" />
            CSV
          </Button>
        </TooltipTrigger>
        <TooltipContent className="font-mono">{baseName}.csv</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={openAll}
            disabled={openableCount === 0}
            aria-label={`Open all ${openableCount} reports in this batch`}
          >
            <ExternalLink data-icon="inline-start" />
            Open all
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {openableCount === 0
            ? "No reports to open"
            : `Open all ${openableCount} report${openableCount === 1 ? "" : "s"}`}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

interface PageHighlightProps {
  label: string;
  row: HistoryRow | null;
  accent: "good" | "poor";
}

/** Best/worst page tile: label, overall score (colour-banded), linked URL. */
function PageHighlight({ label, row, accent }: PageHighlightProps) {
  const overall = row ? overallScore(row.scores) : null;
  const accentClass = accent === "good" ? "text-score-good" : "text-score-poor";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className={cn(SECTION_LABEL, accentClass)}>{label}</span>
        {overall !== null ? (
          <span
            className={cn(
              "font-mono text-sm font-medium tabular-nums",
              scoreColorClass(overall),
            )}
          >
            {formatScore(overall)}
          </span>
        ) : null}
      </div>
      {row ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={reportHtmlUrl(row.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate font-mono text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
            >
              {shortUrl(row.finalUrl ?? row.url)}
            </a>
          </TooltipTrigger>
          <TooltipContent className="font-mono">
            Open report · {row.finalUrl ?? row.url}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}

interface PassFailGridProps {
  passFail: PassFailByCategory;
  thresholds: CategoryThresholds;
}

/** Per-category "N/total passing" against the configured threshold. */
function PassFailGrid({ passFail, thresholds }: PassFailGridProps) {
  return (
    <section className="flex flex-col gap-3" aria-label="Pass / fail vs thresholds">
      <span className={SECTION_LABEL}>Pass / fail vs thresholds</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {LIGHTHOUSE_CATEGORIES.map((category) => {
          const { pass, fail, total } = passFail[category];
          const allPass = total > 0 && fail === 0;
          const someFail = fail > 0;
          const tally = allPass
            ? "text-score-good"
            : someFail
              ? "text-score-poor"
              : "text-muted-foreground";

          return (
            <div
              key={category}
              className="flex flex-col gap-1 rounded-md border border-border/60 bg-card/30 p-3"
            >
              <div className="flex items-baseline justify-between gap-1">
                <span className={SECTION_LABEL}>
                  {CATEGORY_SHORT_LABELS[category]}
                </span>
                <span className="font-mono text-[0.625rem] text-muted-foreground tabular-nums">
                  ≥{thresholds[category]}
                </span>
              </div>
              <p className={cn("font-mono text-sm tabular-nums", tally)}>
                <span className="font-medium">{pass}</span>
                <span className="text-muted-foreground">/{total}</span>
                <span className="ml-1 text-[0.7rem] uppercase tracking-[0.12em] text-muted-foreground">
                  pass
                </span>
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
