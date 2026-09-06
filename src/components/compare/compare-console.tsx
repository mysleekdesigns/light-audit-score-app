"use client";

import { useId, useMemo, useState } from "react";
import {
  CalendarRange,
  Cpu,
  GitCompareArrows,
  History,
  LineChart,
  Link2,
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
import {
  resolveCompareSelection,
  type CompareSelection,
  type CompareSelectionParams,
} from "@/lib/compare/lineage";

import { RunDiff } from "./run-diff";
import { ScoreSparklines } from "./score-sparklines";
import { ScoreTrendChart } from "./score-trend-chart";
import { WhatChangedCard } from "./what-changed-card";

const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/**
 * The URL picker's label, matched to `ReadoutCell`'s own micro-cap rather than
 * approximated: the picker sits inside the readout bezel as its first cell, so
 * its label has to land on the same baseline and weight as "RUNS" beside it.
 */
const CELL_LABEL =
  "flex items-center gap-1.5 font-mono text-[0.6rem] font-medium uppercase tracking-[0.18em] text-muted-foreground";

/** Hairline between readout cells, once they sit in a row rather than a 2×2 grid. */
const FACT_DIVIDER = "@2xl:border-l @2xl:border-border/60 @2xl:pl-6";

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
  /**
   * The page's query string, so a deep link can preselect a URL and a pair of
   * runs — and, with `changed=1`, open the What Changed card on arrival. Read
   * once to seed this console's state; changing a picker afterwards is not
   * written back to the URL.
   */
  initial?: CompareSelectionParams;
}

/**
 * The Compare console: pick a URL to see its score trend over time (multi-series
 * chart + per-category sparklines), then pick two of its runs to see a
 * score/metric diff. All derivation happens in-browser over the server-provided
 * rows (no fetching). Recharts is client-only, so this is a client component.
 */
export function CompareConsole({ runs, initial }: CompareConsoleProps) {
  const groups = useMemo(() => groupRunsByUrl(runs), [runs]);
  // Resolved against the groups the archive actually has, so a stale link
  // degrades to this page's own defaults instead of a dangling selection.
  const selection = useMemo(
    () => resolveCompareSelection(groups, initial),
    [groups, initial],
  );

  if (groups.length === 0 || !selection) {
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

  return <CompareConsoleInner groups={groups} selection={selection} />;
}

/** Inner console rendered once we know there is ≥1 comparable URL. */
function CompareConsoleInner({
  groups,
  selection,
}: {
  groups: UrlGroup[];
  selection: CompareSelection;
}) {
  const urlSelectId = useId();
  const baselineId = useId();
  const comparisonId = useId();

  // Defaults to the most-audited URL (groups are ordered by run count desc),
  // unless a deep link named another one.
  const [selectedUrl, setSelectedUrl] = useState(selection.url);

  const group = useMemo(
    () => groups.find((g) => g.url === selectedUrl) ?? groups[0],
    [groups, selectedUrl],
  );
  const groupRuns = group.runs; // ascending by time

  const trend = useMemo(() => buildScoreTrend(groupRuns), [groupRuns]);

  // What the selected URL actually holds — the target band's readout. Runs are
  // already ascending by time, so the span is simply first → last.
  const span = useMemo(() => {
    const from = formatDay(groupRuns[0]);
    const to = formatDay(groupRuns[groupRuns.length - 1]);
    if (from === to) return from;
    // Within one month the repeated name is dead weight — and it is exactly what
    // pushed "Jun 11 → Jun 15" onto a second line in the phone's 2×2 readout, so
    // it collapses to "Jun 11 → 15".
    const [fromMonth] = from.split(" ");
    const [toMonth, toDay] = to.split(" ");
    return `${from} → ${fromMonth === toMonth ? toDay : to}`;
  }, [groupRuns]);
  const devices = useMemo(() => describeDevices(groupRuns), [groupRuns]);
  const engines = useMemo(() => describeEngines(groupRuns), [groupRuns]);

  // Diff run selection — defaults: baseline = oldest, comparison = newest,
  // again unless a deep link named a pair that still exists.
  const [baselineId$, setBaselineId] = useState(selection.baselineRunId);
  const [comparisonId$, setComparisonId] = useState(selection.comparisonRunId);

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
    /* Page grid --------------------------------------------------------
       One column of full-width sections to `xl` — 1024–1279px reads exactly
       as 1023px does. From `xl` the page becomes two columns: Target URL over
       Score Trend on the left, Run Diff filling the right beside both. The
       diff is the tallest section by far (two tables plus a footer), so
       pairing it with the two short ones balances the fold instead of leaving
       a half-empty row. What Changed then spans both columns on its own row
       beneath them — it is the one section built from full-width tables. DOM
       order is Target → Trend → Diff → What Changed at every width, so the
       stacked reading never changes.

       The row is left to stretch and the diff pinned with `self-start`, so the
       left column — not the diff — absorbs the row height and the two columns
       end on the same line. Whichever column is shorter grows, so this still
       holds for a URL whose diff is the short one. */
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="flex flex-col gap-6">
        {/* Target band ------------------------------------------------------
          One bezel, one row of cells, and the picker is the first of them —
          its "URL" micro-cap sits exactly where every other cell's label does,
          with the select standing in for the value.

          It was previously two boxes side by side: a capped 672px picker on the
          left and a taller readout on the right. Because the two were bottom
          aligned, the left half opened a void above the picker the moment the
          row engaged (~863px), and the picker stopped growing while the card
          kept going. Folding the picker into the bezel means the width is
          always spoken for: the URL takes whatever the four facts leave, and
          below `@4xl` it simply takes the whole row with the facts spread
          evenly underneath. */}
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

            <Readout>
              <div className="grid gap-x-6 gap-y-4 @4xl:grid-cols-[minmax(0,1fr)_auto] @4xl:items-end">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={urlSelectId} className={CELL_LABEL}>
                    <Link2 className="size-3" aria-hidden />
                    URL
                  </label>
                  <Select value={selectedUrl} onValueChange={handleUrlChange}>
                    {/* The trigger wraps rather than truncates. A single-line trigger
                    clipped 223px of the URL on a phone — and still 123px at
                    1024px — so the one thing the whole page is about was
                    unreadable. Height goes auto and the value's line clamp is
                    lifted; the run-count badge the option carries is dropped
                    here, since the Runs cell in the readout already states it. */}
                    <SelectTrigger
                      id={urlSelectId}
                      className="w-full whitespace-normal py-1.5 text-left font-mono text-xs data-[size=default]:h-auto data-[size=default]:min-h-8 *:data-[slot=select-value]:line-clamp-none"
                    >
                      <SelectValue placeholder="Select a URL">
                        {/* `text-left` lives on the trigger, not here: this span is
                        inline, and `text-align` only applies to a block box —
                        so a wrapped URL inherited the button's UA centring and
                        its second line sat in the middle of the field. */}
                        <span className="min-w-0 wrap-anywhere">
                          {selectedUrl}
                        </span>
                      </SelectValue>
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
                              {g.runs.length}{" "}
                              {g.runs.length === 1 ? "run" : "runs"}
                            </Badge>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {/* Facts. Two rows of two while the bezel is narrow, an even
                  four-column strip once it can hold one — never a wrapping row
                  that packs left and leaves a quarter of the bezel blank. From
                  `@2xl` each cell after the first hangs a hairline off its own
                  left edge, so the strip reads as one ruled instrument face. */}
                <ReadoutCells className="grid grid-cols-2 items-end gap-x-6 gap-y-3 @2xl:grid-cols-4 @2xl:gap-x-0 @4xl:flex">
                  <ReadoutCell
                    icon={<History className="size-3" aria-hidden />}
                    label="Runs"
                    value={String(groupRuns.length)}
                  />
                  <ReadoutCell
                    className={FACT_DIVIDER}
                    icon={<CalendarRange className="size-3" aria-hidden />}
                    label="Span"
                    value={span}
                  />
                  <ReadoutCell
                    className={FACT_DIVIDER}
                    icon={<Smartphone className="size-3" aria-hidden />}
                    label="Devices"
                    value={devices}
                  />
                  <ReadoutCell
                    className={FACT_DIVIDER}
                    icon={<Cpu className="size-3" aria-hidden />}
                    label="Engine"
                    value={engines.label}
                    tone={engines.mixed ? "warn" : "default"}
                  />
                </ReadoutCells>
              </div>
              <ReadoutNote>
                {engines.mixed
                  ? "This URL has both local and PageSpeed runs. They are measured on different hardware, so a diff across the two engines reflects more than the page."
                  : "Pick two runs below to diff their scores and Core Web Vitals."}
              </ReadoutNote>
            </Readout>
          </CardContent>
        </Card>

        {/* Trend section ---------------------------------------------------
            Every card is an `@container`, so its contents size off its own
            column rather than the viewport: this one is 310px on a phone,
            944px stacked at 1024px and 588px in the left column of a 1280px
            desktop, and each width needs a different answer.

            `flex-1` from `xl` hands it whatever the Target band leaves of the
            column, so its bottom edge meets the diff's. The height goes to the
            chart rather than to padding — see `ScoreTrendChart`. */}
        <Card className="@container xl:flex-1">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em]">
              <LineChart aria-hidden className="size-3.5 text-primary" />
              Score Trend
            </CardTitle>
            <CardDescription className="font-mono text-xs tabular-nums">
              {groupRuns.length} {groupRuns.length === 1 ? "run" : "runs"} ·
              oldest → newest
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-5">
            {hasTrend ? (
              <>
                <ScoreTrendChart data={trend} />
                <div className="flex flex-col gap-2">
                  <span className={SECTION_LABEL}>Per-category</span>
                  <ScoreSparklines data={trend} />
                </div>
              </>
            ) : (
              <div className="flex min-h-32 flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 px-4 py-10 text-center @sm:px-6">
                <p className="text-sm font-medium text-foreground">
                  Needs ≥2 runs to show a trend
                </p>
                <p className="max-w-sm text-sm text-pretty text-muted-foreground">
                  This URL has a single audit. Run it again to chart how its
                  scores move over time.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Diff section ------------------------------------------------------
          The right column from `xl`; the whole page's second section below it.
          `self-start` keeps it at its natural height — it is the section that
          sets the row height, and stretching it would only pad its footer. */}
      <Card className="@container xl:self-start">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em]">
            <GitCompareArrows aria-hidden className="size-3.5 text-primary" />
            Run Diff
          </CardTitle>
          <CardDescription className="text-pretty">
            Pick a baseline and comparison run to diff scores and Core Web
            Vitals.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid gap-4 @lg:grid-cols-2">
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
            <div className="flex min-h-24 items-center justify-center rounded-md border border-dashed border-border/60 px-4 py-8 text-center @sm:px-6">
              <p className="max-w-sm text-sm text-pretty text-muted-foreground">
                Baseline and comparison are the same run — pick two different
                runs to see deltas.
              </p>
            </div>
          ) : (
            <RunDiff baseline={baseline} comparison={comparison} />
          )}
        </CardContent>
      </Card>

      {/* What Changed ------------------------------------------------------
          A full-width row under both columns at every width. It is the only
          section built from tables of arbitrary width — up to 80 audits and 120
          requests — so pairing it with a short card would starve it, and it is
          the last question a reader asks, after "did it move?" and "by how
          much?".

          It reuses the two pickers above rather than adding its own, and it
          reads the two stored reports only once opened. */}
      <WhatChangedCard
        className="xl:col-span-2"
        baseline={baseline}
        comparison={comparison}
        defaultOpen={selection.showChanged}
      />
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
              <SelectItem
                key={run.id}
                value={run.id}
                className="font-mono text-xs"
              >
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
