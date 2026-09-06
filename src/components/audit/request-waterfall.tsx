"use client";

/**
 * Request waterfall (ROADMAP Phase D).
 *
 * One row per network request Lighthouse recorded, with a timing bar scaled
 * against the run's timeline — the bar is what makes this a waterfall rather
 * than a table, so it gets a real column rather than a tooltip.
 *
 * Presentation only. Every decision the rows depend on — the sort comparators,
 * the bar geometry, the byte/duration formatting, the label derivation and the
 * mark predicates — lives in `@/lib/reports/waterfall-view`, where Vitest
 * (`environment: "node"`, no jsdom in this project) can test it directly. This
 * file maps those results onto markup and nothing else.
 *
 * SECURITY: `path`, `host` and `url` are chosen by the page under audit, so
 * they are attacker-controlled (see the module note on `@/lib/reports/types`).
 * They are rendered as text and as `title` attributes only — React escapes
 * both. Deliberately **no links**: routing 100+ subresource URLs through
 * `safeHttpHref` would still put 100+ attacker-chosen navigation targets in the
 * tab order of a modal sheet, and ROADMAP Phase C's L1 finding is the standing
 * reminder of what a hostile audited site does with a user-facing surface. The
 * full URL is available on hover instead.
 */

import { memo, useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronsUpDown, ChevronUp, FileQuestion, Network } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WaterfallData, WaterfallRequest } from "@/lib/reports/types";
import {
  ABSENT,
  barGeometry,
  barTone,
  clampText,
  DEFAULT_WATERFALL_SORT,
  formatBytes,
  formatDuration,
  formatRowNumber,
  hostOf,
  nextSort,
  requestLabel,
  requestMarks,
  sortRequests,
  summarizeWaterfall,
  type BarTone,
  type RequestMarkId,
  type WaterfallSort,
  type WaterfallSortKey,
} from "@/lib/reports/waterfall-view";
import { scoreBandChipClass } from "@/lib/scores";
import { cn } from "@/lib/utils";

/** Shared header label styling — mono, uppercase, tracked (matches the results table). */
const HEAD_LABEL = "font-mono text-[0.65rem] uppercase tracking-[0.16em]";

/** Dense body cell: tighter than the primitive's `p-2`, since rows run to 100+. */
const BODY_CELL = "px-2 py-1 align-middle";

/**
 * Bar fill per tone. Cyan (`primary`) is the page's own traffic, neutral grey is
 * someone else's, and only render-blocking — an actual Lighthouse finding —
 * takes a score band. That split is deliberate: the history table's engine badge
 * established that non-verdict facts must avoid the good/average/poor tokens, and
 * "third-party" is provenance, not a failure.
 */
const BAR_TONE: Record<BarTone, string> = {
  blocking: "bg-score-poor/75",
  "third-party": "bg-muted-foreground/45",
  "first-party": "bg-primary/70",
};

/** The chip each mark renders as. The abbreviation is the meaning, not the colour. */
const MARKS: Record<RequestMarkId, { abbr: string; label: string; className: string }> = {
  // A real finding, so it earns the "poor" band.
  "render-blocking": {
    abbr: "RB",
    label: "Render-blocking",
    className: scoreBandChipClass("poor"),
  },
  // Provenance, not a verdict — the neutral band, same as an unscored chip.
  "third-party": {
    abbr: "3P",
    label: "Third-party",
    className: scoreBandChipClass("none"),
  },
};

const MARK_CHIP =
  "inline-flex h-[1.05rem] shrink-0 items-center rounded-[3px] border px-1 font-mono text-[0.55rem] uppercase tracking-[0.08em]";

/* -------------------------------------------------------------------------- */

/** One figure in the summary strip: a micro-caps label with a mono value. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={cn(HEAD_LABEL, "text-[0.6rem] text-muted-foreground")}
      >
        {label}
      </span>
      {/* nowrap so "1.0 MB" never breaks between the figure and its unit when
          the strip wraps to a second line on a phone-width sheet. */}
      <span className="whitespace-nowrap font-mono text-xs tabular-nums text-foreground">
        {value}
      </span>
    </span>
  );
}

/** One legend entry: a bar swatch beside the tone it stands for. */
function LegendSwatch({ tone, label }: { tone: BarTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("h-1.5 w-3 rounded-[2px]", BAR_TONE[tone])} />
      <span className="font-mono text-[0.55rem] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
    </span>
  );
}

/**
 * A clickable sort header inside a `<th>` carrying `aria-sort` — the same
 * affordance the History archive uses, so the two tables sort identically.
 * `numeric` right-aligns the column and flips the chevron inboard.
 */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  numeric = false,
  className,
}: {
  label: string;
  sortKey: WaterfallSortKey;
  sort: WaterfallSort;
  onSort: (key: WaterfallSortKey) => void;
  numeric?: boolean;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const ariaSort: React.AriaAttributes["aria-sort"] = active
    ? sort.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";

  const Icon = !active ? ChevronsUpDown : sort.direction === "asc" ? ChevronUp : ChevronDown;

  return (
    <TableHead
      scope="col"
      aria-sort={ariaSort}
      className={cn(HEAD_LABEL, "h-8 px-2", numeric && "text-right", className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "group/sort inline-flex touch-manipulation items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          numeric && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-opacity",
            active ? "text-primary opacity-100" : "opacity-40 group-hover/sort:opacity-70",
          )}
        />
      </button>
    </TableHead>
  );
}

/**
 * The timing bar: a full-width track with the request's segment positioned by
 * {@link barGeometry}. Purely graphic, so the cell also carries an `sr-only`
 * readout of the same two numbers — the bar encodes a start time that appears in
 * no other column, and a chart no screen reader can read is a hole, not a style.
 */
function TimingBar({
  request,
  timelineMs,
}: {
  request: WaterfallRequest;
  timelineMs: number | null;
}) {
  const bar = barGeometry(request, timelineMs);

  if (!bar) {
    // No start time, or no timeline to scale against — say so rather than
    // drawing a bar that would imply a timing Lighthouse never recorded.
    return (
      <>
        <span className="block min-w-[7rem] text-center font-mono text-[0.65rem] text-muted-foreground/50">
          {ABSENT}
        </span>
        <span className="sr-only">No timing recorded</span>
      </>
    );
  }

  const start = formatDuration(request.startTime);
  const duration = formatDuration(request.durationMs);
  const tone = barTone(request);

  return (
    <>
      <span
        title={`Starts at ${start} · ${duration}`}
        className="relative block h-2 w-full min-w-[7rem] overflow-hidden rounded-[2px] bg-muted/60"
      >
        <span
          aria-hidden
          style={{ left: `${bar.offsetPct}%`, width: `${bar.widthPct}%` }}
          className={cn("absolute inset-y-0 rounded-[2px]", BAR_TONE[tone])}
        />
      </span>
      <span className="sr-only">
        Starts at {start}, lasts {duration}
      </span>
    </>
  );
}

/**
 * One request row.
 *
 * Memoised because sorting 100+ rows otherwise re-renders every cell subtree
 * for a change that only reorders them: `request` objects come straight from the
 * fetched payload and keep their identity across sorts, so every prop here is
 * reference-stable and the memo actually hits.
 */
const WaterfallRow = memo(function WaterfallRow({
  request,
  finalHost,
  timelineMs,
  count,
}: {
  request: WaterfallRequest;
  finalHost: string;
  timelineMs: number | null;
  count: number;
}) {
  const label = requestLabel(request, finalHost);
  const marks = requestMarks(request);

  // Hover detail for the parts that don't earn a column. Clamped, because a
  // `data:` URL is a legitimate row and can be megabytes of base64.
  const detail = [
    clampText(request.url, 240),
    request.statusCode !== null ? `HTTP ${request.statusCode}` : null,
    request.protocol || null,
    request.priority ? `${request.priority} priority` : null,
    request.entity || null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <TableRow className="border-border/50 hover:bg-muted/40">
      <TableCell
        className={cn(BODY_CELL, "pr-0 font-mono text-[0.65rem] tabular-nums text-muted-foreground/60")}
      >
        {formatRowNumber(request.index, count)}
      </TableCell>

      {/* `max-w-0` with a min-width is what lets the path truncate instead of
          forcing the table wider than the sheet (same trick as the results table). */}
      <TableCell className={cn(BODY_CELL, "min-w-[9rem] max-w-0")}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            title={detail}
            className={cn(
              "truncate font-mono text-xs",
              label.crossHost ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {label.text}
          </span>
          {marks.map((id) => {
            const mark = MARKS[id];
            return (
              <span key={id} className={cn(MARK_CHIP, mark.className)}>
                <span aria-hidden>{mark.abbr}</span>
                <span className="sr-only">{mark.label}</span>
              </span>
            );
          })}
        </span>
      </TableCell>

      <TableCell
        className={cn(BODY_CELL, "font-mono text-[0.65rem] uppercase tracking-[0.08em] text-muted-foreground")}
      >
        {request.resourceType || ABSENT}
      </TableCell>

      <TableCell className={cn(BODY_CELL, "text-right font-mono text-xs tabular-nums")}>
        {formatBytes(request.transferSize)}
      </TableCell>

      <TableCell className={BODY_CELL}>
        <TimingBar request={request} timelineMs={timelineMs} />
      </TableCell>

      <TableCell
        className={cn(BODY_CELL, "text-right font-mono text-xs tabular-nums text-muted-foreground")}
      >
        {formatDuration(request.durationMs)}
      </TableCell>
    </TableRow>
  );
});

/* -------------------------------------------------------------------------- */

interface RequestWaterfallProps {
  /** The waterfall projection of one stored report. */
  data: WaterfallData;
  /** The run's final URL — the first-party host every row is compared against. */
  finalUrl: string;
}

/**
 * The waterfall panel: a summary strip over a sortable request table.
 *
 * Fills its parent's flex column (the detail sheet's tab body). One scroll
 * container handles BOTH axes — deliberately not the `Table` primitive's own
 * wrapper, because `overflow-x: auto` makes an element a scrollport on the
 * vertical axis too, which would anchor the sticky header to a container that
 * never scrolls and let it slide away with the rows. Owning the scroller keeps
 * the header pinned, keeps wide rows scrolling inside this panel, and keeps the
 * sheet body and the page behind it from ever scrolling sideways.
 */
export function RequestWaterfall({ data, finalUrl }: RequestWaterfallProps) {
  const [sort, setSort] = useState<WaterfallSort>(DEFAULT_WATERFALL_SORT);
  const handleSort = useCallback((key: WaterfallSortKey) => {
    setSort((prev) => nextSort(prev, key));
  }, []);

  const finalHost = useMemo(() => hostOf(finalUrl), [finalUrl]);
  const summary = useMemo(() => summarizeWaterfall(data), [data]);
  // The one genuinely non-trivial computation per render — memoised so a hover
  // or a parent re-render never re-sorts 100+ rows.
  const rows = useMemo(() => sortRequests(data.requests, sort), [data.requests, sort]);

  // `unavailable` and "zero requests" are different claims and get different
  // copy: one says the report never carried the audit, the other says the audit
  // ran and found nothing. Neither is an error.
  if (data.unavailable) {
    return (
      <Empty className="flex-1 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>No network trace in this report</EmptyTitle>
          <EmptyDescription>
            This run was stored without a <span className="font-mono">network-requests</span>{" "}
            audit — reports saved before the waterfall existed have none. Re-run the audit to
            capture one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (data.requests.length === 0) {
    return (
      <Empty className="flex-1 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Network />
          </EmptyMedia>
          <EmptyTitle>The page made no network requests</EmptyTitle>
          <EmptyDescription>
            Lighthouse recorded the trace and it was empty: nothing was fetched during this run.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/60 px-4 py-2.5">
        <Figure label="Requests" value={String(summary.requestCount)} />
        <Figure label="Transferred" value={summary.transferLabel} />
        <Figure label="Third-party" value={String(summary.thirdPartyCount)} />
        <Figure label="Timeline" value={summary.timelineLabel} />
        {/* The bar tones repeat what the RB / 3P chips already say in text, so
            the legend is reinforcement — the table still reads in greyscale. */}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:ml-auto">
          <LegendSwatch tone="first-party" label="First-party" />
          <LegendSwatch tone="third-party" label="Third-party" />
          <LegendSwatch tone="blocking" label="Blocking" />
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <table className="w-full min-w-[36rem] caption-bottom border-separate border-spacing-0 text-sm">
          {/* `border-separate` (rather than the primitive's collapsed default)
              is what keeps the sticky header's bottom hairline painted while
              rows scroll under it — a collapsed border travels with the cell. */}
          <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 [&_th]:border-b [&_th]:border-border/60">
            <TableRow className="hover:bg-transparent">
              <SortHeader label="#" sortKey="index" sort={sort} onSort={handleSort} className="pr-0" />
              {/* `w-full` on this header is what hands the leftover width to the
                  path rather than the bar — the same claim the results table's
                  URL column makes. The bar keeps a fixed, readable track. */}
              <SortHeader
                label="Request"
                sortKey="request"
                sort={sort}
                onSort={handleSort}
                className="w-full"
              />
              <SortHeader label="Type" sortKey="type" sort={sort} onSort={handleSort} />
              <SortHeader label="Size" sortKey="size" sort={sort} onSort={handleSort} numeric />
              <SortHeader
                label="Timeline"
                sortKey="start"
                sort={sort}
                onSort={handleSort}
                className="w-[11rem]"
              />
              <SortHeader label="Time" sortKey="duration" sort={sort} onSort={handleSort} numeric />
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:border-b [&_td]:border-border/40 [&_tr:last-child_td]:border-0">
            {rows.map((request) => (
              <WaterfallRow
                key={request.index}
                request={request}
                finalHost={finalHost}
                timelineMs={data.timelineMs}
                count={summary.requestCount}
              />
            ))}
          </TableBody>
        </table>
      </div>
    </div>
  );
}
