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
 *
 * Layout is mobile-first and built from the house **instrument bands** (see
 * `readout.tsx`): a header, a dial grid, comparison bands, and an `mt-auto`
 * instrument footer whose bezel carries derived readings *and* the card's
 * actions. Both the threshold console and every batch card are `@container`s,
 * so each sizes off its own width — a batch card is the whole page on a phone,
 * half of it at `xl` and a third at `2xl`, and viewport breakpoints would read
 * the wrong number at two of those three.
 */

import { useCallback, useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileJson,
  FileText,
  Gauge,
  Layers,
  Loader2,
  FileDiff,
  RotateCcw,
  RotateCw,
  Sheet,
  Target,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { DriftWarning } from "@/components/audit/drift-warning";
import { EnvironmentBadge } from "@/components/audit/environment-badge";
import {
  Readout,
  ReadoutCell,
  ReadoutCells,
  ReadoutNote,
} from "@/components/audit/readout";
import { RerunBatchButton } from "@/components/audit/rerun-batch-button";
import { ScoreRing } from "@/components/audit/score-ring";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { downloadBatchReport } from "@/lib/client/reportExport";
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
import {
  LIGHTHOUSE_CATEGORIES,
  type DeviceSelection,
} from "@/lib/lighthouse/types";
import { compareHref, pickRerunComparison } from "@/lib/compare/lineage";
import { hasBothDevices } from "@/lib/pairing/devicePairs";
import {
  DEFAULT_THRESHOLDS,
  type CategoryThresholds,
} from "@/lib/settings/defaults";
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
  pagesClearingThresholds,
  passFail,
  type PassFailByCategory,
} from "@/lib/batch-summary/summary";

/** Mono uppercase tracked section label — the house "telemetry" label style. */
const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/** The mono micro-caption that trails a band's heading. */
const BAND_CAPTION =
  "font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground";

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
  cancelled: {
    label: "Cancelled",
    variant: "outline",
    icon: Ban,
    className: "border-border/60 text-muted-foreground",
  },
};

/**
 * Format an ISO timestamp into a readable datetime; falls back to the raw string.
 *
 * The locale is pinned: this console is server-rendered, and an ambient locale
 * formats differently on the server than in a non-`en-US` browser, which fails
 * hydration.
 */
function formatBatchAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
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

/** `1 page` / `3 pages`. */
function pages(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
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

  // What the current bars actually cost, across the whole archive — the derived
  // reading the threshold console's footer reports back. A batch clears when
  // every page it measured cleared.
  const reach = useMemo(() => {
    let clearingPages = 0;
    let scoredPages = 0;
    let clearingBatches = 0;
    let scoredBatches = 0;

    for (const batch of batches) {
      const tally = pagesClearingThresholds(
        runsByBatch.get(batch.id) ?? [],
        thresholds,
      );
      if (tally.total === 0) continue;
      scoredBatches += 1;
      scoredPages += tally.total;
      clearingPages += tally.clearing;
      if (tally.clearing === tally.total) clearingBatches += 1;
    }

    return { clearingPages, scoredPages, clearingBatches, scoredBatches };
  }, [batches, runsByBatch, thresholds]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-6">
        <ThresholdControls
          thresholds={thresholds}
          onChange={setThresholds}
          reach={reach}
        />

        <ul
          className="grid list-none grid-cols-1 gap-5 p-0 xl:grid-cols-2 2xl:grid-cols-3"
          aria-label="Batch summaries"
        >
          {batches.map((batch) => (
            // `flex` so the card stretches to the row's height and its footer
            // bezel can pin to the bottom — action bars line up across a row.
            <li key={batch.id} className="flex">
              <BatchCard
                batch={batch}
                rows={runsByBatch.get(batch.id) ?? []}
                // The batch this one re-ran, so its card can offer a diff. Read
                // from the whole archive rather than `batches`, which drops
                // cancelled batches — the pages a cancelled batch DID finish are
                // still persisted and still comparable.
                priorRows={
                  batch.priorBatchId
                    ? (runsByBatch.get(batch.priorBatchId) ?? [])
                    : []
                }
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
  reach: {
    clearingPages: number;
    scoredPages: number;
    clearingBatches: number;
    scoredBatches: number;
  };
}

/**
 * The configurable per-category pass-threshold console (defaults to 90 /
 * GOOD_THRESHOLD).
 *
 * An instrument band: heading + state-aware caption, a dial grid of the five
 * bars, and a footer bezel reporting what those bars cost across the whole
 * archive — a derived number, not an echo of the dials — with the reset action
 * inside the same bezel. The dials cap at 28rem from `@3xl` so the readout
 * takes the slack instead of five number inputs stretching to a desk width; the
 * cap grew with the fifth dial so each stays ~80px rather than five sharing the
 * width four used to have.
 */
function ThresholdControls({
  thresholds,
  onChange,
  reach,
}: ThresholdControlsProps) {
  const groupId = useId();

  const bars = LIGHTHOUSE_CATEGORIES.map((category) => thresholds[category]);
  const lowest = Math.min(...bars);
  const highest = Math.max(...bars);
  const isDefault = LIGHTHOUSE_CATEGORIES.every(
    (category) => thresholds[category] === DEFAULT_THRESHOLDS[category],
  );

  const caption = isDefault
    ? `Default bar · ${highest}`
    : lowest === highest
      ? `Custom bar · ${lowest}`
      : `Custom bars · ${lowest}–${highest}`;

  const allClear =
    reach.scoredPages > 0 && reach.clearingPages === reach.scoredPages;

  return (
    <Card className="@container">
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2
            id={`${groupId}-legend`}
            className="font-heading text-base font-medium"
          >
            Pass thresholds
          </h2>
          <span className={BAND_CAPTION}>{caption}</span>
        </div>

        {/* Dial grid beside the readout from `@3xl`; stacked below it, where the
            five bars sit 3-then-2 rather than shrinking to five 45px inputs.
            Three columns, not two: five cells in a 2-wide grid strand the last
            one alone on a row of its own, and a 320px card still gives each of
            three ~72px — room for "100" and its spinner. */}
        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] @3xl:items-start @3xl:gap-6">
          <FieldGroup className="grid grid-cols-3 gap-3 @md:grid-cols-5">
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
                    autoComplete="off"
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

          <Readout className="@5xl:flex-row @5xl:items-center @5xl:justify-between @5xl:gap-6">
            <div className="flex min-w-0 flex-col gap-2">
              <ReadoutCells className="grid grid-cols-2 items-start gap-y-3 @sm:flex">
                <ReadoutCell
                  icon={<Target className="size-3" aria-hidden />}
                  label="Pages clear"
                  value={`${reach.clearingPages}/${reach.scoredPages}`}
                  tone={allClear ? "good" : "default"}
                />
                <ReadoutCell
                  icon={<Layers className="size-3" aria-hidden />}
                  label="Batches clear"
                  value={`${reach.clearingBatches}/${reach.scoredBatches}`}
                  tone={
                    reach.scoredBatches > 0 &&
                    reach.clearingBatches === reach.scoredBatches
                      ? "good"
                      : "default"
                  }
                />
              </ReadoutCells>
              <ReadoutNote>
                A page clears when every category it scored sits at or above that
                category&rsquo;s bar, and a batch clears when all of its measured
                pages do. These bars are shared with the Lighthouse page&rsquo;s defaults.
              </ReadoutNote>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...DEFAULT_THRESHOLDS })}
              disabled={isDefault}
              className="w-full shrink-0 @sm:w-fit"
            >
              <RotateCcw data-icon="inline-start" />
              Reset to {DEFAULT_THRESHOLDS.performance}
            </Button>
          </Readout>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The `↻ re-run of <prior>` lineage chip — and, when the two batches share a
 * comparable page, the "what changed" entry point beside it (ROADMAP Phase E).
 *
 * The chip is where a user actually asks the question, so the link lands them on
 * `/compare` already pointing at the right pair: the prior batch's run as the
 * baseline, this batch's as the comparison, with the What Changed card open.
 * Resolving a prior BATCH id to a prior RUN is done by `pickRerunComparison`,
 * a pure, unit-tested helper — it matches on `(url, formFactor)` so a `"both"`
 * batch never diffs a mobile run against a desktop one, and ranks by score
 * points lost so a multi-page batch lands on the page that regressed hardest.
 *
 * **It degrades by disappearing.** No shared page, a failed prior run, or a
 * prior run stored without a JSON report all mean there is nothing to diff, and
 * the link is simply not rendered — the tooltip says why rather than offering a
 * link that would land on a broken selection.
 */
function LineageChip({
  priorBatchId,
  rows,
  priorRows,
}: {
  priorBatchId: string;
  rows: HistoryRow[];
  priorRows: HistoryRow[];
}) {
  const target = useMemo(
    () => pickRerunComparison(rows, priorRows),
    [rows, priorRows],
  );

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="gap-1 border-border/60 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground tabular-nums"
          >
            <RotateCw aria-hidden className="size-2.5" />
            re-run of{" "}
            <span translate="no">{priorBatchId.slice(0, 8)}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="font-mono">Re-run of batch {priorBatchId}</p>
          {target ? null : (
            <p className="text-pretty">
              No page here has a completed prior run with a stored report, so there is nothing
              to diff.
            </p>
          )}
        </TooltipContent>
      </Tooltip>

      {target ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
            >
              <Link
                href={compareHref(target)}
                aria-label={`What changed — diff ${shortUrl(target.url)} on ${target.formFactor} against the prior run`}
              >
                <FileDiff aria-hidden className="size-2.5" />
                what changed
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="text-pretty">
              Diff this re-run against the prior one, audit by audit.
            </p>
            <p className="font-mono break-all text-muted-foreground" translate="no">
              {shortUrl(target.url)} · {target.formFactor}
            </p>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}

interface BatchCardProps {
  batch: BatchInfo;
  rows: HistoryRow[];
  /** Runs of the batch this one re-ran; empty for a fresh batch (PRD §6 Phase 13). */
  priorRows: HistoryRow[];
  thresholds: CategoryThresholds;
}

function BatchCard({ batch, rows, priorRows, thresholds }: BatchCardProps) {
  const summary = useMemo(
    () => ({
      averages: averageScores(rows),
      pages: bestWorstPages(rows),
      passFail: passFail(rows, thresholds),
      clearing: pagesClearingThresholds(rows, thresholds),
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

  // Unique URLs across the runs, preserving order. A "both" batch lists each URL
  // twice (mobile + desktop), so dedupe — the re-run's `device:"both"` re-fans it.
  const rerunUrls = useMemo(
    () => [...new Set(rows.map((row) => row.url))],
    [rows],
  );

  return (
    // `@container` so every band below sizes off this card, which is the whole
    // page on a phone, half of it at `xl` and a third at `2xl`.
    <Card className="@container w-full">
      <CardHeader className="gap-3 border-b border-border/60 pb-4">
        {/* Identity: id + lifecycle + lineage, with the timestamp trailing right
            once there is room and dropping to its own line before that. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2
            className="font-mono text-sm text-foreground tabular-nums"
            translate="no"
          >
            <span className="sr-only">Batch{" "}</span>
            {shortId}
          </h2>
          <Badge
            variant={status.variant}
            className={cn(
              "gap-1.5 font-mono text-[0.625rem] uppercase tracking-[0.18em]",
              status.className,
            )}
          >
            <StatusIcon
              data-icon="inline-start"
              className={
                batch.status === "running"
                  ? "animate-spin motion-reduce:animate-none"
                  : undefined
              }
            />
            {status.label}
          </Badge>
          {batch.priorBatchId ? (
            <LineageChip
              priorBatchId={batch.priorBatchId}
              rows={rows}
              priorRows={priorRows}
            />
          ) : null}
          <span className="font-mono text-xs text-muted-foreground tabular-nums @sm:ml-auto">
            {formatBatchAt(batch.createdAt)}
          </span>
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

      <CardContent className="flex flex-1 flex-col gap-5">
        {doneCount === 0 ? (
          <p className="text-sm text-pretty text-muted-foreground">
            No completed runs in this batch
            {errorCount > 0 ? ` — all ${errorCount} failed.` : "."}
          </p>
        ) : (
          <>
            {/* Dial grid — one gauge per category, spread evenly across the card
                rather than packed left. Five rings sit 3-then-2 on the narrowest
                card and go five-across from `@md`, the width at which each cell
                clears the 60px gauge plus its caption with room to spare. Three
                columns rather than two: at two, the fifth ring is stranded alone
                on a row, and a 320px card still gives each of three ~75px. */}
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
              <div className="grid grid-cols-3 items-start gap-x-2 gap-y-4 @md:grid-cols-5">
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
              className="grid gap-3 @lg:grid-cols-2"
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

        <BatchFooter
          rows={rows}
          shortId={shortId}
          batchId={batch.id}
          thresholds={thresholds}
          rerunUrls={rerunUrls}
          device={deviceLabel}
          options={batch.options}
          source={batch.source}
          concurrency={batch.concurrency}
          priorBatchId={batch.id}
          overall={overallScore(summary.averages)}
          clearing={summary.clearing}
          errorCount={errorCount}
        />
      </CardContent>
    </Card>
  );
}

interface BatchFooterProps {
  rows: HistoryRow[];
  shortId: string;
  /** Full batch id — what the HTML-report export is addressed to. */
  batchId: string;
  /**
   * The bars the exported report's pass/fail tallies must be judged against.
   * They live in `localStorage`, so the SERVER cannot look them up — the export
   * request carries them, which is why this is a POST. Without it the file would
   * disagree with the card the user was reading when they clicked Export.
   */
  thresholds: CategoryThresholds;
  /** Unique URLs across the batch's runs (order-preserving), for the re-run. */
  rerunUrls: string[];
  /** Derived device selection for the batch (`"both"` re-fans mobile + desktop). */
  device: DeviceSelection;
  /** Resolved options the batch ran with, to reproduce on re-run. */
  options: BatchInfo["options"];
  /** Engine the batch ran on ("local" | "psi"), to reproduce on re-run. */
  source: BatchInfo["source"];
  /** Resolved concurrency the batch ran at, to reproduce on re-run. */
  concurrency: number;
  /** This batch's id — recorded as lineage on the re-run. */
  priorBatchId: string;
  /** Mean of the batch's category averages, or null when nothing scored. */
  overall: number | null;
  /** Pages clearing every bar they were scored against. */
  clearing: { clearing: number; total: number };
  /** Runs in the batch that failed. */
  errorCount: number;
}

/**
 * The card's instrument footer: one bezel holding what the batch is worth
 * (overall average, pages clearing every bar, what the exports and Open all
 * would act on) *and* the actions themselves — so "export 74 runs" is
 * answerable without counting rows, and the toolbar can no longer crowd the
 * batch id off the header on a phone.
 *
 * Re-submits the batch's exact URLs + options through `POST /api/audits`
 * (recording lineage) and deep-links to the live stream; serializes this
 * batch's runs to a file (in the click handler, never on render); and opens
 * every run that has a stored HTML report in a new tab — warning via toast if
 * the popup blocker stopped any.
 */
function BatchFooter({
  rows,
  shortId,
  batchId,
  thresholds,
  rerunUrls,
  device,
  options,
  source,
  concurrency,
  priorBatchId,
  overall,
  clearing,
  errorCount,
}: BatchFooterProps) {
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

  /**
   * The HTML report is the one export that is a server round-trip: it reads
   * every stored LHR in the batch to draw the waterfalls and filmstrips, which
   * takes long enough to need a pending state and can fail in ways JSON/CSV
   * cannot. Held as plain state and flipped in the handler — never in an effect
   * (eslint and the repo's `lint-fix` hook both refuse `setState` there).
   */
  const [buildingReport, setBuildingReport] = useState(false);

  const exportReport = useCallback(async () => {
    setBuildingReport(true);
    try {
      const filename = await downloadBatchReport({
        batchId,
        thresholds,
        fallbackFilename: `lighthouse-report-${shortId}-${timestampSlug()}.html`,
      });
      toast.success("Report exported", {
        // The second sentence is a disclosure, not a flourish. The file carries
        // the audited pages' full request URLs and real screenshots of them, and
        // its whole purpose is to be forwarded — so the one moment the user is
        // certain to be looking is the moment it lands. Credential-shaped query
        // values are redacted during assembly, but that is a net over an
        // unbounded space of parameter names, so the honest line is "check it",
        // not "it's clean". (ROADMAP Phase H security review, finding 1.)
        description: `${filename} — self-contained; opens offline and prints to PDF. It includes each page's request URLs and screenshots, so give it a look before sending on a staging or logged-in audit.`,
        duration: 10000,
      });
    } catch (err) {
      toast.error("Report export failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBuildingReport(false);
    }
  }, [batchId, shortId, thresholds]);

  const openAll = useCallback(() => {
    const opened = openUrlsInNewTabs(openableHrefs);
    if (opened < openableHrefs.length) {
      toast.warning("Some reports didn't open", {
        description: `Opened ${opened} of ${openableHrefs.length} — your browser's popup blocker may have stopped the rest.`,
      });
    }
  }, [openableHrefs]);

  const allClear = clearing.total > 0 && clearing.clearing === clearing.total;

  return (
    <Readout className="mt-auto @3xl:flex-row @3xl:items-center @3xl:justify-between @3xl:gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        {/* Four cells wrap 3-then-1 on a phone, stranding a whole row for the
            last one. A 2×2 grid fills the strip evenly instead. */}
        <ReadoutCells className="grid grid-cols-2 items-start gap-y-3 @sm:flex">
          <ReadoutCell
            icon={<Gauge className="size-3" aria-hidden />}
            label="Overall"
            value={formatScore(overall)}
          />
          <ReadoutCell
            icon={<Target className="size-3" aria-hidden />}
            label="Clear"
            value={`${clearing.clearing}/${clearing.total}`}
            tone={allClear ? "good" : "default"}
          />
          <ReadoutCell
            icon={<FileJson className="size-3" aria-hidden />}
            label="Exports"
            value={`${rows.length} ${rows.length === 1 ? "run" : "runs"}`}
          />
          <ReadoutCell
            icon={<ExternalLink className="size-3" aria-hidden />}
            label="Reports"
            value={String(openableCount)}
            tone={openableCount > 0 ? "good" : "default"}
          />
        </ReadoutCells>
        <ReadoutNote>
          Re-run repeats {pages(rerunUrls.length)}{" "}
          with this batch&rsquo;s exact options and records the lineage.
          {errorCount > 0
            ? ` The exports carry all ${rows.length} runs, failures included.`
            : null}
          {openableCount === 0 ? " No stored reports left to open." : null}
        </ReadoutNote>
      </div>

      {/* Five actions: the four data actions stay a 2×2 block on a phone so each
          is a full-width tap target, and the client report spans the full width
          beneath them. That is hierarchy rather than a workaround for the odd
          count — the report is the thing you hand to someone else, the other
          four are things you do with the run — and it also keeps the phone
          layout dividing evenly, with no orphan stranded on a line of its own.
          From `@sm` all five sit on one row and trail right. */}
      <div
        className="grid shrink-0 grid-cols-2 gap-2 @sm:flex @sm:flex-wrap @sm:items-center @sm:gap-1.5 @3xl:justify-end"
        role="group"
        aria-label={`Actions for batch ${shortId}`}
      >
        <RerunBatchButton
          urls={rerunUrls}
          device={device}
          options={options}
          source={source}
          concurrency={concurrency}
          priorBatchId={priorBatchId}
          className="w-full @sm:w-auto"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openAll}
              disabled={openableCount === 0}
              aria-label={`Open all ${openableCount} reports in this batch`}
              className="w-full @sm:w-auto"
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={exportJson}
              disabled={!hasRows}
              aria-label={`Export batch ${shortId} as JSON`}
              className="w-full @sm:w-auto"
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
              className="w-full @sm:w-auto"
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
              variant="default"
              size="sm"
              onClick={exportReport}
              disabled={!hasRows || buildingReport}
              aria-label={`Export batch ${shortId} as a client-ready HTML report`}
              // `aria-busy` rather than only a spinner: the label changes too, so
              // a screen reader is told the button is working without having to
              // infer it from an icon swap.
              aria-busy={buildingReport}
              className="col-span-2 w-full @sm:w-auto"
            >
              {buildingReport ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <FileText data-icon="inline-start" />
              )}
              {buildingReport ? "Building…" : "Report"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {buildingReport
              ? "Reading this batch's stored reports…"
              : "One self-contained HTML file — opens offline, prints to PDF. Includes request URLs and screenshots."}
          </TooltipContent>
        </Tooltip>
      </div>
    </Readout>
  );
}

interface PageHighlightProps {
  label: string;
  row: HistoryRow | null;
  accent: "good" | "poor";
}

/**
 * Best/worst page tile: label, overall score (colour-banded), linked URL.
 *
 * `min-w-0` is what lets the URL be clipped at all — without it the tile's
 * automatic minimum size is the full unbroken URL, which blew the tile (and,
 * through the grid, the whole card) past the card's edge at every width. The
 * URL then wraps to two lines rather than truncating: on a 240px card an
 * ellipsis after `contextforge.dev/b…` says nothing the tooltip doesn't.
 */
function PageHighlight({ label, row, accent }: PageHighlightProps) {
  const overall = row ? overallScore(row.scores) : null;
  const accentClass = accent === "good" ? "text-score-good" : "text-score-poor";

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border/60 bg-card/30 p-3">
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
              className="line-clamp-2 min-w-0 font-mono text-xs wrap-anywhere text-foreground underline-offset-4 hover:text-primary hover:underline"
              translate="no"
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
      {/* Three across, then five from `@lg` — the width at which a tile can hold
          "Perf" and "≥90" on one line. Two columns would strand the fifth tile
          alone on a row; three keeps the block square-edged at every width, and
          the label row below wraps to carry the narrower tile. */}
      <div className="grid grid-cols-3 gap-2 @lg:grid-cols-5">
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
              className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 bg-card/30 p-3"
            >
              {/* `flex-wrap` for the same reason the tally below carries it: at
                  three columns on a 320px card the label and its bar are wider
                  than the tile, and as one unwrappable row they spilled it. */}
              <div className="flex flex-wrap items-baseline justify-between gap-x-1">
                <span className={SECTION_LABEL}>
                  {CATEGORY_SHORT_LABELS[category]}
                </span>
                <span className="font-mono text-[0.625rem] text-muted-foreground tabular-nums">
                  ≥{thresholds[category]}
                </span>
              </div>
              <p
                className={cn(
                  // No whitespace separates "3/74" from "pass", so as one text
                  // run it has nowhere to break and spilled the tile at 320px.
                  // Flex items wrap where a text run could not.
                  "flex flex-wrap items-baseline font-mono text-sm tabular-nums",
                  tally,
                )}
              >
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
