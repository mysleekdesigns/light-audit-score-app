"use client";

import { useId, useMemo, useState } from "react";
import {
  CalendarRange,
  Cpu,
  GitCompareArrows,
  History,
  LineChart,
  Smartphone,
} from "lucide-react";

import {
  Readout,
  ReadoutCell,
  ReadoutCells,
  ReadoutNote,
} from "@/components/audit/readout";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { HistoryRow } from "@/lib/db/persistence";
import { cn } from "@/lib/utils";
import {
  buildScoreTrend,
  groupRunsByUrl,
  runTime,
  type UrlGroup,
} from "@/lib/compare/diff";

import { RunDiff } from "./run-diff";
import { ScoreSparklines } from "./score-sparklines";
import { ScoreTrendChart } from "./score-trend-chart";

const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/** Format an ISO timestamp into a compact local datetime for option labels. */
function formatRunLabel(row: HistoryRow): string {
  const iso = runTime(row);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Day-only label for the span readout ("Jun 11").
 *
 * Locale is pinned rather than left to the environment: unlike the run pickers
 * (whose option labels only exist once Radix opens them on the client), this
 * text is in the server-rendered HTML, so an ambient locale would differ between
 * server and browser and fail hydration. The surrounding copy is English-only.
 */
function formatDay(row: HistoryRow): string {
  const date = new Date(runTime(row));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
  }).format(date);
}

/** "Mobile", "Desktop", or "Mobile + desktop" for the devices present in a set. */
function describeDevices(runs: HistoryRow[]): string {
  const hasMobile = runs.some((r) => r.formFactor === "mobile");
  const hasDesktop = runs.some((r) => r.formFactor === "desktop");
  if (hasMobile && hasDesktop) return "Mobile + desktop";
  if (hasDesktop) return "Desktop";
  if (hasMobile) return "Mobile";
  return "—";
}

/**
 * Which engines produced these runs. Worth surfacing next to the picker: a local
 * Lighthouse run and a PageSpeed run of the same URL are measured on different
 * hardware, so a diff that straddles both is comparing more than the page.
 */
function describeEngines(runs: HistoryRow[]): {
  label: string;
  mixed: boolean;
} {
  const hasLocal = runs.some((r) => r.source !== "psi");
  const hasPsi = runs.some((r) => r.source === "psi");
  if (hasLocal && hasPsi) return { label: "Local + PSI", mixed: true };
  if (hasPsi) return { label: "PageSpeed", mixed: false };
  return { label: "Local", mixed: false };
}

interface CompareConsoleProps {
  runs: HistoryRow[];
}

/**
 * The Compare console: pick a URL to see its score trend over time (multi-series
 * chart + per-category sparklines), then pick two of its runs to see a
 * score/metric diff. All derivation happens in-browser over the server-provided
 * rows (no fetching). Recharts is client-only, so this is a client component.
 */
export function CompareConsole({ runs }: CompareConsoleProps) {
  const groups = useMemo(() => groupRunsByUrl(runs), [runs]);

  if (groups.length === 0) {
    return (
      <Empty className="border border-dashed border-border/60">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitCompareArrows />
          </EmptyMedia>
          <EmptyTitle>No comparable runs yet</EmptyTitle>
          <EmptyDescription>
            Comparison and trends need at least one successful audit. Run an
            audit, then return here to track scores over time and diff any two
            runs of the same URL.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <CompareConsoleInner groups={groups} />;
}

/** Inner console rendered once we know there is ≥1 comparable URL. */
function CompareConsoleInner({ groups }: { groups: UrlGroup[] }) {
  const urlSelectId = useId();
  const baselineId = useId();
  const comparisonId = useId();

  // Default to the most-audited URL (groups are ordered by run count desc).
  const [selectedUrl, setSelectedUrl] = useState(groups[0].url);

  const group = useMemo(
    () => groups.find((g) => g.url === selectedUrl) ?? groups[0],
    [groups, selectedUrl],
  );
  const groupRuns = group.runs; // ascending by time

  const trend = useMemo(() => buildScoreTrend(groupRuns), [groupRuns]);

  // What the selected URL actually holds — the target band's readout. Runs are
  // already ascending by time, so the span is simply first → last.
  const span = useMemo(
    () => ({
      from: formatDay(groupRuns[0]),
      to: formatDay(groupRuns[groupRuns.length - 1]),
    }),
    [groupRuns],
  );
  const devices = useMemo(() => describeDevices(groupRuns), [groupRuns]);
  const engines = useMemo(() => describeEngines(groupRuns), [groupRuns]);

  // Diff run selection — defaults: baseline = oldest, comparison = newest.
  const [baselineId$, setBaselineId] = useState(() => groupRuns[0].id);
  const [comparisonId$, setComparisonId] = useState(
    () => groupRuns[groupRuns.length - 1].id,
  );

  // Resolve selected ids against the current group, falling back to the
  // oldest/newest run so a URL switch never leaves a dangling selection.
  const baseline = useMemo(
    () => groupRuns.find((r) => r.id === baselineId$) ?? groupRuns[0],
    [groupRuns, baselineId$],
  );
  const comparison = useMemo(
    () =>
      groupRuns.find((r) => r.id === comparisonId$) ??
      groupRuns[groupRuns.length - 1],
    [groupRuns, comparisonId$],
  );

  function handleUrlChange(url: string) {
    setSelectedUrl(url);
    const next = groups.find((g) => g.url === url) ?? groups[0];
    setBaselineId(next.runs[0].id);
    setComparisonId(next.runs[next.runs.length - 1].id);
  }

  const hasTrend = groupRuns.length >= 2;

  return (
    <div className="flex flex-col gap-6">
      {/* Target band ------------------------------------------------------
          The picker used to be a lone 350px select on the page background with
          ~2000px of void beside it at desk widths. It is now an instrument band
          matching the audit consoles: the primary input on the left, a readout
          of what that selection actually contains trailing right once the card
          is wide enough. Sizes off the card's own container query. */}
      <Card>
        <CardContent className="@container flex flex-col gap-4 px-4">
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-heading text-base font-medium leading-snug">
              Target URL
            </h2>
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
              {groups.length} {groups.length === 1 ? "URL" : "URLs"} with runs
            </p>
          </header>

          <div className="flex flex-col gap-4 @3xl:flex-row @3xl:items-end @3xl:justify-between @3xl:gap-6">
            {/* Grows with the card so long URLs stop truncating, but stops
                short of a select stretched across an ultrawide display. */}
            <div className="flex min-w-0 flex-1 flex-col gap-2 @3xl:max-w-2xl">
              <label htmlFor={urlSelectId} className={SECTION_LABEL}>
                URL
              </label>
              <Select value={selectedUrl} onValueChange={handleUrlChange}>
                <SelectTrigger
                  id={urlSelectId}
                  className="w-full font-mono text-xs"
                >
                  <SelectValue placeholder="Select a URL" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {groups.map((g) => (
                      <SelectItem
                        key={g.url}
                        value={g.url}
                        className="font-mono text-xs"
                      >
                        <span className="truncate">{g.url}</span>
                        <Badge
                          variant="outline"
                          className="ml-auto font-mono text-[0.6rem] tabular-nums text-muted-foreground"
                        >
                          {g.runs.length} {g.runs.length === 1 ? "run" : "runs"}
                        </Badge>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <Readout className="@3xl:w-auto @3xl:shrink-0">
              <ReadoutCells>
                <ReadoutCell
                  icon={<History className="size-3" aria-hidden />}
                  label="Runs"
                  value={String(groupRuns.length)}
                />
                <ReadoutCell
                  icon={<CalendarRange className="size-3" aria-hidden />}
                  label="Span"
                  value={
                    span.from === span.to
                      ? span.from
                      : `${span.from} → ${span.to}`
                  }
                />
                <ReadoutCell
                  icon={<Smartphone className="size-3" aria-hidden />}
                  label="Devices"
                  value={devices}
                />
                <ReadoutCell
                  icon={<Cpu className="size-3" aria-hidden />}
                  label="Engine"
                  value={engines.label}
                  tone={engines.mixed ? "warn" : "default"}
                />
              </ReadoutCells>
              <ReadoutNote>
                {engines.mixed
                  ? "This URL has both local and PageSpeed runs. They are measured on different hardware, so a diff across the two engines reflects more than the page."
                  : "Pick two runs below to diff their scores and Core Web Vitals."}
              </ReadoutNote>
            </Readout>
          </div>
        </CardContent>
      </Card>

      {/* Trend + Diff — stacked on narrow screens, side-by-side on very wide. */}
      <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
        {/* Trend section --------------------------------------------------- */}
        <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em]">
            <LineChart aria-hidden className="size-3.5 text-primary" />
            Score Trend
          </CardTitle>
          <CardDescription className="font-mono text-xs tabular-nums">
            {groupRuns.length} {groupRuns.length === 1 ? "run" : "runs"} · oldest →
            newest
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {hasTrend ? (
            <>
              <ScoreTrendChart data={trend} />
              <div className="flex flex-col gap-2">
                <span className={SECTION_LABEL}>Per-category</span>
                <ScoreSparklines data={trend} />
              </div>
            </>
          ) : (
            <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 px-6 py-10 text-center">
              <p className="text-sm font-medium text-foreground">
                Needs ≥2 runs to show a trend
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                This URL has a single audit. Run it again to chart how its scores
                move over time.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

        {/* Diff section ---------------------------------------------------- */}
        <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em]">
            <GitCompareArrows aria-hidden className="size-3.5 text-primary" />
            Run Diff
          </CardTitle>
          <CardDescription>
            Pick a baseline and comparison run to diff scores and Core Web Vitals.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <RunSelect
              id={baselineId}
              label="Baseline"
              value={baseline.id}
              runs={groupRuns}
              onChange={setBaselineId}
            />
            <RunSelect
              id={comparisonId}
              label="Comparison"
              value={comparison.id}
              runs={groupRuns}
              onChange={setComparisonId}
            />
          </div>

          {baseline.id === comparison.id ? (
            <div className="flex min-h-24 items-center justify-center rounded-md border border-dashed border-border/60 px-6 py-8 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">
                Baseline and comparison are the same run — pick two different runs
                to see deltas.
              </p>
            </div>
          ) : (
            <RunDiff baseline={baseline} comparison={comparison} />
          )}
        </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** A labelled run picker (timestamp + device per option). */
function RunSelect({
  id,
  label,
  value,
  runs,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  runs: HistoryRow[];
  onChange: (id: string) => void;
}) {
  // Newest-first in the picker so the most recent runs are easiest to reach.
  const ordered = useMemo(() => [...runs].reverse(), [runs]);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={SECTION_LABEL}>
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full font-mono text-xs">
          <SelectValue placeholder={`Select ${label.toLowerCase()} run`} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {ordered.map((run) => (
              <SelectItem key={run.id} value={run.id} className="font-mono text-xs">
                <span className="tabular-nums">{formatRunLabel(run)}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "ml-auto font-mono text-[0.6rem] uppercase tracking-[0.12em] text-muted-foreground",
                  )}
                >
                  {run.formFactor}
                </Badge>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
