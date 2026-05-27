"use client";

/**
 * Batch summary console (PRD §6 Phase 6 — Comparison & trends).
 *
 * Renders one card per persisted batch (newest-first) with: average score per
 * category, best/worst page by overall score, and pass/fail counts against
 * **user-configurable per-category thresholds**. Thresholds live in component
 * state (in-memory; persisting them is Phase 7) and all summaries are derived
 * with `useMemo` from the runs handed down by the server page.
 */

import { useId, useMemo, useState } from "react";
import { CheckCircle2, Clock, Loader2, TriangleAlert } from "lucide-react";

import { ScoreRing } from "@/components/audit/score-ring";
import { Badge } from "@/components/ui/badge";
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
import { reportHtmlUrl } from "@/lib/client/auditClient";
import type { BatchInfo, HistoryRow } from "@/lib/db/persistence";
import {
  LIGHTHOUSE_CATEGORIES,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import {
  CATEGORY_SHORT_LABELS,
  formatScore,
  GOOD_THRESHOLD,
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

type Thresholds = Record<LighthouseCategory, number>;

/** Every category defaults to the "good" bar (90). */
const DEFAULT_THRESHOLDS: Thresholds = {
  performance: GOOD_THRESHOLD,
  accessibility: GOOD_THRESHOLD,
  "best-practices": GOOD_THRESHOLD,
  seo: GOOD_THRESHOLD,
};

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
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);

  // Group once; each batch card slices its own runs out of the map.
  const runsByBatch = useMemo(() => groupRunsByBatch(runs), [runs]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-6">
        <ThresholdControls thresholds={thresholds} onChange={setThresholds} />

        <ul className="flex list-none flex-col gap-5 p-0">
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
  thresholds: Thresholds;
  onChange: (next: Thresholds) => void;
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
  thresholds: Thresholds;
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

  const doneCount = useMemo(
    () => rows.filter((row) => row.status === "done").length,
    [rows],
  );
  const errorCount = rows.length - doneCount;

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
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatBatchAt(batch.createdAt)}
          </span>
        </div>

        {/* Telemetry strip: device · runs · pages · done/error tallies. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-muted-foreground tabular-nums">
          <Badge
            variant="outline"
            className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground"
          >
            {batch.options.formFactor}
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
        </div>
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
              <span className={SECTION_LABEL}>Average scores</span>
              <div className="flex flex-wrap items-start gap-6">
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
  thresholds: Thresholds;
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
