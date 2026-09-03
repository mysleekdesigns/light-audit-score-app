"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  ExternalLink,
  FileJson,
  Filter,
  Globe,
  Monitor,
  Search,
  Sheet,
  Smartphone,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { CoreWebVitalsStrip } from "@/components/audit/core-web-vitals";
import { EnvironmentBadge } from "@/components/audit/environment-badge";
import {
  Readout,
  ReadoutCell,
  ReadoutCells,
  ReadoutNote,
} from "@/components/audit/readout";
import { RerunBatchButton } from "@/components/audit/rerun-batch-button";
import { ResultsViewToggle } from "@/components/audit/results-view-toggle";
import { ScoreRings } from "@/components/audit/score-rings";
import { ScoreDelta } from "@/components/compare/score-delta";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuditDefaults } from "@/hooks/useAuditDefaults";
import { useBatchStream } from "@/hooks/useBatchStream";
import {
  clearHistory,
  deleteRun,
  reportHtmlUrl,
  reportJsonUrl,
} from "@/lib/client/auditClient";
import { diffScores, type ScoreDiff } from "@/lib/compare/diff";
import type { HistoryRow } from "@/lib/db/persistence";
import {
  downloadCsv,
  downloadJson,
  openUrlsInNewTabs,
  timestampSlug,
} from "@/lib/export/download";
import { collapseRuns, type CollapsedRun } from "@/lib/history/collapse";
import type { DevicePair } from "@/lib/pairing/devicePairs";
import { hasBothDevices, pairByDevice } from "@/lib/pairing/devicePairs";
import { rowsToCsv, rowsToJson } from "@/lib/export/exporters";
import type { FormFactor, LighthouseCategory } from "@/lib/lighthouse/types";
import type { Batch } from "@/lib/queue/types";
import {
  CATEGORY_SHORT_LABELS,
  formatScore,
  GOOD_THRESHOLD,
  scoreColorClass,
} from "@/lib/scores";
import { cn } from "@/lib/utils";

/** The four score columns, in PRD display order, paired with their sort keys. */
const SCORE_COLUMNS = [
  { category: "performance", sortKey: "performance" },
  { category: "accessibility", sortKey: "accessibility" },
  { category: "best-practices", sortKey: "best-practices" },
  { category: "seo", sortKey: "seo" },
] as const satisfies ReadonlyArray<{
  category: LighthouseCategory;
  sortKey: LighthouseCategory;
}>;

/** Sortable column keys. */
type SortKey = "url" | LighthouseCategory | "createdAt";
type SortDirection = "asc" | "desc";

/**
 * Which device's columns the paired table shows below `xl`. Held once for the
 * whole archive rather than per website section, so switching to Desktop on one
 * site doesn't leave the next section still showing Mobile as you scroll.
 */
type PairedDevice = "mobile" | "desktop";

/** Shared header label styling — mono, uppercase, tracked, matching the house style. */
const HEAD_LABEL = "font-mono text-[0.7rem] uppercase tracking-[0.16em]";

/**
 * Alignment for score column headers, kept in step with {@link ScoreCell} so a
 * category label always sits directly over its numbers.
 *
 * Below `xl` both are flush left, which needs no compensation: label and number
 * start at the same content edge. From `xl` up both are flush right, and the
 * header then has to clear everything between the cell's right border and the
 * number's right edge — the cell's own `p-2` (8px), the `gap-1` before the trend
 * slot (4px), and the `w-4` slot itself (16px) — 28px, which is `pr-7`.
 * Measured, not assumed: at `pr-5` every label sat 8px right of its column.
 */
const SCORE_HEAD = "text-left xl:text-right xl:pr-7";

/**
 * Compact cell padding for the densified archive — tighter vertical rhythm than
 * the default `TableCell` while keeping link/button hit-targets comfortable.
 */
const COMPACT_CELL = "py-2 leading-tight";

/** Format an ISO timestamp into a readable local datetime; falls back to the raw string. */
function formatRunAt(iso: string): string {
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

/** Compare two nullable scores; nulls always sort last regardless of direction. */
function compareScores(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1; // a sinks
  if (bNull) return -1; // b sinks
  return a - b;
}

/**
 * Section rank for the grouped "by URL" ordering: 0 = the site root / homepage,
 * 1 = other public pages, 2 = the blog and all its sub-pages. Combined with host
 * and path this sorts the bare domain to the top, ordinary pages next, and the
 * blog (with every sub-category) last — the way the archive organises by default.
 * Falls back to treating the raw string as its own key for non-URL inputs.
 */
function urlGroupKey(raw: string): { host: string; section: number; path: string } {
  try {
    const u = new URL(raw);
    const host = u.host.replace(/^www\./, "").toLowerCase();
    const path = ((u.pathname || "/").replace(/\/+$/, "") || "/").toLowerCase();
    const section =
      path === "/" ? 0 : path === "/blog" || path.startsWith("/blog/") ? 2 : 1;
    return { host, section, path };
  } catch {
    const fallback = raw.toLowerCase();
    return { host: fallback, section: 1, path: fallback };
  }
}

/** Compare two URLs by the grouped ordering (host → section → path, numeric-aware). */
function compareUrlGroup(a: string, b: string): number {
  const ka = urlGroupKey(a);
  const kb = urlGroupKey(b);
  if (ka.host !== kb.host) return ka.host.localeCompare(kb.host);
  if (ka.section !== kb.section) return ka.section - kb.section;
  return ka.path.localeCompare(kb.path, undefined, { numeric: true });
}

/**
 * A run "passes" the Needs-work gate only when every category is present and at
 * or above the green threshold (90). Errored runs never pass.
 */
function rowPasses(row: HistoryRow): boolean {
  if (row.status === "error") return false;
  return SCORE_COLUMNS.every(({ category }) => {
    const value = row.scores[category];
    return value != null && value >= GOOD_THRESHOLD;
  });
}

/** A run "needs work" when it failed or any category scores below 90. */
function rowNeedsWork(row: HistoryRow): boolean {
  return !rowPasses(row);
}

/**
 * A paired URL needs work when any audited device side needs work. A side that
 * wasn't audited (null) is ignored; a pair always has at least its `primary`.
 */
function pairNeedsWork(pair: DevicePair<CollapsedRun>): boolean {
  const sides = [pair.mobile, pair.desktop].filter(
    (entry): entry is CollapsedRun => entry != null,
  );
  return sides.some((entry) => rowNeedsWork(entry.latest));
}

/**
 * Per-category score deltas between a series' previous and latest run, indexed by
 * category for direct cell lookup. Returns null when there's nothing to compare
 * (a first run, or the latest failed) so the trend simply doesn't render.
 */
function entryScoreDiffs(
  entry: CollapsedRun,
): Partial<Record<LighthouseCategory, ScoreDiff>> | null {
  if (!entry.previous || entry.latest.status === "error") return null;
  const diffs = diffScores(entry.previous.scores, entry.latest.scores);
  const byCategory: Partial<Record<LighthouseCategory, ScoreDiff>> = {};
  for (const diff of diffs) byCategory[diff.category] = diff;
  return byCategory;
}

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

/** A clickable, accessible sort header rendered inside a `<th>` carrying `aria-sort`. */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  numeric = false,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const ariaSort: React.AriaAttributes["aria-sort"] = active
    ? sort.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";

  const Icon = !active
    ? ChevronsUpDown
    : sort.direction === "asc"
      ? ChevronUp
      : ChevronDown;

  return (
    <TableHead
      aria-sort={ariaSort}
      className={cn(HEAD_LABEL, numeric && "text-right", className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "group/sort inline-flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          numeric && "xl:flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-opacity",
            active
              ? "opacity-100 text-primary"
              : "opacity-40 group-hover/sort:opacity-70",
          )}
        />
      </button>
    </TableHead>
  );
}

/**
 * Engine badge styling, keyed on the run's source. Cyan (the primary token) is
 * PSI's colour throughout the app; the local engine takes the theme's violet
 * chart token — the one accent hue that isn't cyan and isn't one of the three
 * score bands, so an engine badge never reads as a good/average/poor verdict.
 */
const SOURCE_BADGE: Record<
  HistoryRow["source"],
  { label: string; title: string; className: string }
> = {
  local: {
    label: "LHA",
    title: "Lighthouse audit — run locally by this machine's Chrome",
    className: "border-chart-5/40 bg-chart-5/10 text-chart-5",
  },
  psi: {
    label: "PSI",
    title: "PageSpeed Insights run — measured on Google's servers",
    className: "border-primary/40 bg-primary/10 text-primary",
  },
};

/**
 * A compact engine badge — violet "LHA" (Lighthouse audit) for this machine's
 * Lighthouse, cyan "PSI" for PageSpeed Insights. Both engines are labelled,
 * never just one: a page audited both ways lands as two rows in the same table,
 * and an absent badge only means "local" to a reader who already knows the
 * convention.
 */
function SourceBadge({ source }: { source: HistoryRow["source"] }) {
  const { label, title, className } = SOURCE_BADGE[source] ?? SOURCE_BADGE.local;
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "font-mono text-[0.6rem] uppercase tracking-[0.12em]",
        className,
      )}
    >
      {label}
    </Badge>
  );
}

/**
 * A single score cell: mono, tabular, colour-banded, with the latest score and —
 * when the page was audited before — a compact trend (arrow + signed delta vs the
 * previous run) sitting to its right. The trend occupies a fixed-width slot so the
 * score column stays right-aligned whether or not a delta is present; the slot
 * renders content only when the score actually moved. Pair the matching
 * {@link SCORE_HEAD} padding on the column header so the label stays over the
 * numbers.
 */
function ScoreCell({
  score,
  diff,
  className,
}: {
  score: number | null | undefined;
  diff?: ScoreDiff | null;
  className?: string;
}) {
  const value = score ?? null;
  return (
    <TableCell className={cn(COMPACT_CELL, "text-left xl:text-right", className)}>
      <span className="inline-flex items-baseline justify-start gap-1 xl:justify-end">
        <span className={cn("font-mono text-sm tabular-nums", scoreColorClass(value))}>
          {formatScore(value)}
        </span>
        <span className="inline-flex w-4 justify-start">
          {diff ? (
            <ScoreDelta
              direction={diff.direction}
              delta={diff.delta}
              title={`Previous run: ${formatScore(diff.baseline)} → now ${formatScore(diff.comparison)}`}
            />
          ) : null}
        </span>
      </span>
    </TableCell>
  );
}

/** Failed-run cell spanning the four score columns: a destructive badge + message. */
function FailedCell({
  message,
  className,
}: {
  message: string | null;
  className?: string;
}) {
  const text = message ?? "Unknown error";
  return (
    <TableCell
      colSpan={SCORE_COLUMNS.length}
      className={cn(COMPACT_CELL, "text-left", className)}
    >
      <div className="flex items-center gap-2">
        <Badge
          variant="destructive"
          className="font-mono text-[0.65rem] uppercase tracking-[0.12em]"
        >
          Failed
        </Badge>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-[22ch] truncate text-xs text-muted-foreground">
              {text}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm font-mono">{text}</TooltipContent>
        </Tooltip>
      </div>
    </TableCell>
  );
}

/** Report links for a completed run with a stored HTML report (+ raw JSON). */
function ReportLinks({ row }: { row: HistoryRow }) {
  if (row.status === "error" || !row.hasHtmlReport) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant="ghost"
            size="icon-xs"
            aria-label="Open HTML report in a new tab"
          >
            <a
              href={reportHtmlUrl(row.id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open HTML report</TooltipContent>
      </Tooltip>
      {row.hasJsonReport ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="icon-xs"
              aria-label="Open raw JSON report in a new tab"
            >
              <a
                href={reportJsonUrl(row.id)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileJson />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Raw JSON</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * Per-run delete: a destructive icon button guarded by a confirm dialog. On
 * confirm it removes the run (row + stored reports) and refreshes the server
 * component so the row disappears.
 */
function DeleteRunButton({ row }: { row: HistoryRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteRun(row.id);
      toast.success("Run deleted.");
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Could not delete the run.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete run for ${row.url}`}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this run?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the run for{" "}
            <span className="font-mono text-foreground">{row.url}</span> and its
            stored reports. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={(event) => {
              // Keep the dialog mounted through the async call; we close it once
              // the delete settles (success path) instead of on click.
              event.preventDefault();
              void handleDelete();
            }}
          >
            {deleting ? "Deleting…" : "Delete run"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Toolbar "Clear history" action: wipes every persisted run + batch and all
 * stored reports, behind a confirm dialog. Disabled when there's nothing to clear.
 */
function ClearHistoryButton({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function handleClear() {
    setClearing(true);
    try {
      const { runs } = await clearHistory();
      toast.success(
        `History cleared — ${runs} run${runs === 1 ? "" : "s"} removed.`,
      );
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Could not clear history.");
    } finally {
      setClearing(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={count === 0}
          aria-label="Clear all history"
          className={className}
        >
          <Trash2 data-icon="inline-start" />
          Clear history
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear all history?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes all {count} run{count === 1 ? "" : "s"} and
            their stored reports. Saved schedules are not affected. This can&apos;t
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={clearing}
            onClick={(event) => {
              event.preventDefault();
              void handleClear();
            }}
          >
            {clearing ? "Clearing…" : "Clear everything"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// --- In-place re-runs -------------------------------------------------------
// A History re-run stays on this page. The row's button re-runs only the device
// it sits on (the row's own form factor) and hands the new batch to the table,
// which watches it over SSE from the table root — so the watch survives the
// row's website section collapsing or a filter hiding the row — and refreshes
// the server rows once it settles. Only that device's half of the row changes;
// filters, sort and open sections are untouched.

/** A re-run in flight, keyed by the id of the run it will replace. */
interface PendingRerun {
  batchId: string;
  url: string;
  formFactor: FormFactor;
}

interface RerunTracking {
  /** Runs whose device is being re-run right now. */
  pending: ReadonlyMap<string, PendingRerun>;
  /** Register a re-run of `row`'s device that just started as `batch`. */
  start: (row: HistoryRow, batch: Batch) => void;
}

const NO_PENDING_RERUNS: ReadonlyMap<string, PendingRerun> = new Map();

const RerunTrackingContext = createContext<RerunTracking>({
  pending: NO_PENDING_RERUNS,
  start: () => {},
});

/** Whether the run with id `runId` (null when there is no run) has a re-run in flight. */
function useRerunPending(runId: string | null): boolean {
  const { pending } = useContext(RerunTrackingContext);
  return runId !== null && pending.has(runId);
}

/** Fades a device's scores while a fresh run for it is computing. */
const PENDING_SCORES = "opacity-40 transition-opacity duration-500";

/**
 * Invisible per-re-run watcher, mounted at the table root: subscribes to the
 * batch's SSE stream and, once it settles, toasts the outcome, refreshes the
 * server rows (which swaps in the new run for that device) and clears the
 * pending marker. A stream that closes without completing means the batch is
 * gone (server restart); that settles too, so the button never spins forever.
 */
function RerunWatcher({
  runId,
  rerun,
  onSettled,
}: {
  runId: string;
  rerun: PendingRerun;
  onSettled: (runId: string) => void;
}) {
  const router = useRouter();
  const { batch, isComplete, connection, error } = useBatchStream(rerun.batchId);
  const settled = isComplete || (connection === "closed" && error !== null);

  // Effect-event so the settle effect depends on `settled` alone and never
  // re-fires on a batch snapshot or a toast/router identity change.
  const settle = useEffectEvent(() => {
    const job = batch?.jobs[0];
    const device = rerun.formFactor;
    if (job?.status === "done") {
      toast.success(`Re-run complete — ${device} scores updated.`, {
        description: rerun.url,
      });
    } else if (job?.status === "error") {
      toast.error(`Re-run failed on ${device}.`, {
        description: job.error?.message ?? rerun.url,
      });
    } else if (job?.status === "cancelled") {
      toast.info("Re-run cancelled.", { description: rerun.url });
    } else {
      toast.error("Lost track of the re-run.", {
        description: error ?? rerun.url,
      });
    }
    router.refresh();
    onSettled(runId);
  });

  useEffect(() => {
    if (settled) settle();
  }, [settled]);

  return null;
}

/**
 * Owns the table's in-flight re-runs: the pending map rows read to spin their
 * button and fade their scores, plus one {@link RerunWatcher} per batch. Sits
 * above the whole table, so a watch outlives the row that started it.
 */
function RerunTrackingProvider({ children }: { children: ReactNode }) {
  const [pendingReruns, setPendingReruns] =
    useState<ReadonlyMap<string, PendingRerun>>(NO_PENDING_RERUNS);

  const start = useCallback((row: HistoryRow, batch: Batch) => {
    setPendingReruns((prev) =>
      new Map(prev).set(row.id, {
        batchId: batch.id,
        url: row.url,
        formFactor: row.formFactor,
      }),
    );
  }, []);
  const settle = useCallback((runId: string) => {
    setPendingReruns((prev) => {
      if (!prev.has(runId)) return prev;
      const next = new Map(prev);
      next.delete(runId);
      return next;
    });
  }, []);
  const value = useMemo<RerunTracking>(
    () => ({ pending: pendingReruns, start }),
    [pendingReruns, start],
  );

  return (
    <RerunTrackingContext value={value}>
      {Array.from(pendingReruns, ([runId, rerun]) => (
        <RerunWatcher
          key={rerun.batchId}
          runId={runId}
          rerun={rerun}
          onSettled={settle}
        />
      ))}
      {children}
    </RerunTrackingContext>
  );
}

/**
 * Per-run action cluster: re-run this single page on this device (PRD §6 Phase
 * 13) without leaving the archive, delete it, plus the report links. Re-run and
 * delete are available even for errored rows, so they sit outside the report
 * links (which collapse to `—` for failures).
 */
function RowActions({ row }: { row: HistoryRow }) {
  const { pending, start } = useContext(RerunTrackingContext);
  return (
    <div className="flex items-center justify-end gap-0.5">
      <RerunBatchButton
        iconOnly
        urls={[row.url]}
        device={row.formFactor}
        options={row.options}
        source={row.source}
        concurrency={1}
        priorBatchId={row.batchId}
        pending={pending.has(row.id)}
        onCreated={(batch) => start(row, batch)}
      />
      <ReportLinks row={row} />
      <DeleteRunButton row={row} />
    </div>
  );
}

/** The archive empty state, shared by the table and cards views. */
function HistoryEmptyState({ isFiltering }: { isFiltering: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-border/70 bg-muted/30">
        <Archive className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">
        {isFiltering ? "No matching runs" : "No audits yet"}
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {isFiltering
          ? "No persisted run matches the current filters."
          : "Completed runs are persisted here automatically. Run an audit to populate the archive."}
      </p>
    </div>
  );
}

/** Quiet caption styling for the "first run" / "no change" trend notes. */
const TREND_CAPTION =
  "font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground/60";

/**
 * A compact "since last run" trend strip for the cards view: only the categories
 * that actually moved, each as a short label + arrow + signed delta. Falls back
 * to a quiet caption when the page is brand-new or unchanged since its last run.
 */
function ScoreTrendStrip({
  diffs,
}: {
  diffs: Partial<Record<LighthouseCategory, ScoreDiff>> | null;
}) {
  if (!diffs) return <p className={TREND_CAPTION}>First run · nothing to compare</p>;

  const moved = SCORE_COLUMNS.map(({ category }) => diffs[category]).filter(
    (diff): diff is ScoreDiff =>
      diff != null && (diff.direction === "up" || diff.direction === "down"),
  );
  if (moved.length === 0)
    return <p className={TREND_CAPTION}>No change since last run</p>;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className={TREND_CAPTION}>vs last</span>
      {moved.map((diff) => (
        <span key={diff.category} className="inline-flex items-center gap-1">
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
            {CATEGORY_SHORT_LABELS[diff.category]}
          </span>
          <ScoreDelta direction={diff.direction} delta={diff.delta} />
        </span>
      ))}
    </div>
  );
}

/** A single ring-card for the cards view — the latest run of one page, with its trend. */
function HistoryRunCard({ entry }: { entry: CollapsedRun }) {
  const { latest } = entry;
  const href = latest.finalUrl ?? latest.url;
  const isError = latest.status === "error";
  const diffs = entryScoreDiffs(entry);
  const pending = useRerunPending(latest.id);

  return (
    <Card size="sm" className="ring-foreground/10">
      <CardHeader className="gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate font-mono text-xs text-foreground underline-offset-4 outline-none hover:text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {latest.url}
            </a>
          </TooltipTrigger>
          <TooltipContent className="font-mono">{href}</TooltipContent>
        </Tooltip>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground"
          >
            {latest.formFactor}
          </Badge>
          <SourceBadge source={latest.source} />
          <span
            title={latest.createdAt}
            className="font-mono text-[0.65rem] tabular-nums text-muted-foreground"
          >
            {formatRunAt(latest.createdAt)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isError ? (
          <div className="flex items-start gap-2">
            <Badge
              variant="destructive"
              className="font-mono text-[0.65rem] uppercase tracking-[0.12em]"
            >
              Failed
            </Badge>
            <span className="text-xs text-muted-foreground">
              {latest.errorMessage ?? "Unknown error"}
            </span>
          </div>
        ) : (
          <div className={cn("flex flex-col gap-4", pending && PENDING_SCORES)}>
            <ScoreRings scores={latest.scores} size={48} />
            <ScoreTrendStrip diffs={diffs} />
            {latest.metrics ? (
              <CoreWebVitalsStrip metrics={latest.metrics} />
            ) : null}
          </div>
        )}
        {latest.environment ? (
          <EnvironmentBadge variant="compact" environment={latest.environment} />
        ) : null}
        <div className="flex items-center justify-end">
          <RowActions row={latest} />
        </div>
      </CardContent>
    </Card>
  );
}

/** The ring-card grid for one website's de-duplicated, filtered + sorted pages. */
function CardsBody({ entries }: { entries: CollapsedRun[] }) {
  return (
    <ul className="grid list-none gap-4 p-0 pt-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {entries.map((entry) => (
        <li key={entry.latest.id}>
          <HistoryRunCard entry={entry} />
        </li>
      ))}
    </ul>
  );
}

// --- Paired (Mobile + Desktop per URL) views -------------------------------
// Mirror the PageSpeed page: when the archive spans both devices, fold each URL's
// (already de-duplicated) mobile + desktop series into a single entry. Pairing is
// scoped per engine + URL so a page audited both locally and via PSI stays
// separate, and each side carries its own "since last run" trend.

/** Mono uppercase device caption ("Mobile" / "Desktop"), matching the house label style. */
const DEVICE_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/**
 * Pair collapsed series into per-URL `{ mobile, desktop }` couples, grouped by
 * engine + URL first so the same page audited via two engines stays separate.
 * Input order is preserved across the grouping and pairing (callers re-sort).
 */
function pairCollapsedRuns(entries: CollapsedRun[]): DevicePair<CollapsedRun>[] {
  const byKey = new Map<string, CollapsedRun[]>();
  for (const entry of entries) {
    const key = `${entry.latest.source} ${entry.latest.url}`;
    const group = byKey.get(key);
    if (group) group.push(entry);
    else byKey.set(key, [entry]);
  }
  const pairs: DevicePair<CollapsedRun>[] = [];
  for (const group of byKey.values()) {
    pairs.push(
      ...pairByDevice(
        group,
        (entry) => entry.latest.url,
        (entry) => entry.latest.formFactor,
      ),
    );
  }
  return pairs;
}

/**
 * One device's section within a {@link PairedHistoryCard}: a device caption (with
 * a run-count marker), then the rings + trend + CWV + environment (done), the
 * failure line (error), or an em-dash note when this URL wasn't audited on this
 * device. Each present device keeps its own re-run / report / delete actions.
 */
function HistoryDeviceSection({
  device,
  entry,
}: {
  device: "Mobile" | "Desktop";
  entry: CollapsedRun | null;
}) {
  const latest = entry?.latest ?? null;
  const isError = latest?.status === "error";
  const diffs = entry ? entryScoreDiffs(entry) : null;
  const pending = useRerunPending(latest?.id ?? null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className={DEVICE_LABEL}>{device}</span>
        {isError ? (
          <Badge
            variant="destructive"
            className="font-mono text-[0.65rem] uppercase tracking-[0.12em]"
          >
            Failed
          </Badge>
        ) : null}
      </div>
      {!latest ? (
        <p className="font-mono text-xs text-muted-foreground/50">
          Not audited on {device.toLowerCase()}
        </p>
      ) : isError ? (
        <p className="text-xs text-muted-foreground">
          {latest.errorMessage ?? "Unknown error"}
        </p>
      ) : (
        <div className={cn("flex flex-col gap-3", pending && PENDING_SCORES)}>
          <ScoreRings scores={latest.scores} size={48} />
          <ScoreTrendStrip diffs={diffs} />
          {latest.metrics ? <CoreWebVitalsStrip metrics={latest.metrics} /> : null}
          {latest.environment ? (
            <EnvironmentBadge variant="compact" environment={latest.environment} />
          ) : null}
        </div>
      )}
      {latest ? (
        <div className="flex items-center justify-end">
          <RowActions row={latest} />
        </div>
      ) : null}
    </div>
  );
}

/** A paired ring-card: one card per URL carrying both device ring-sets, stacked. */
function PairedHistoryCard({ pair }: { pair: DevicePair<CollapsedRun> }) {
  const primary = pair.primary.latest;
  const href = primary.finalUrl ?? primary.url;
  return (
    <Card size="sm" className="ring-foreground/10">
      <CardHeader className="gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate font-mono text-xs text-foreground underline-offset-4 outline-none hover:text-primary hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {pair.url}
            </a>
          </TooltipTrigger>
          <TooltipContent className="font-mono">{href}</TooltipContent>
        </Tooltip>
        <div className="flex flex-wrap items-center gap-2">
          <SourceBadge source={primary.source} />
          <span
            title={primary.createdAt}
            className="font-mono text-[0.65rem] tabular-nums text-muted-foreground"
          >
            {formatRunAt(primary.createdAt)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <HistoryDeviceSection device="Mobile" entry={pair.mobile} />
        <div className="border-t border-border/50" />
        <HistoryDeviceSection device="Desktop" entry={pair.desktop} />
      </CardContent>
    </Card>
  );
}

/** The paired ring-card grid for one website's de-duplicated pages. */
function PairedCardsBody({ pairs }: { pairs: DevicePair<CollapsedRun>[] }) {
  return (
    <ul className="grid list-none gap-4 p-0 pt-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {pairs.map((pair) => (
        <li key={pair.primary.latest.id}>
          <PairedHistoryCard pair={pair} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One device's half of a paired table row: the four score cells then a
 * report/actions cell. A null device (this URL wasn't audited on it) renders em
 * dashes; an errored run collapses the four score cells into a single Failed cell
 * but keeps its actions. `borderless` drops the left hairline on the mobile half.
 */
function HistoryDeviceHalf({
  entry,
  borderless = false,
  stowed = false,
}: {
  entry: CollapsedRun | null;
  borderless?: boolean;
  /**
   * True when this half is the one the narrow-width device switch has put away.
   * Both halves together are twelve columns, which only stop overflowing at
   * ~1180px, so below `xl` only the selected device's cells are displayed; from
   * `xl` up every cell comes back and the paired table reads as it always has.
   */
  stowed?: boolean;
}) {
  const edge = borderless ? undefined : "border-l border-border/50";
  // `table-cell`, not `block`: restoring a stowed <td> has to restore its
  // *table* display or the row's column alignment collapses.
  const stow = stowed ? "hidden xl:table-cell" : undefined;
  const latest = entry?.latest ?? null;
  const pending = useRerunPending(latest?.id ?? null);
  if (!latest) {
    return (
      <>
        {SCORE_COLUMNS.map(({ category }, i) => (
          <TableCell
            key={category}
            className={cn(COMPACT_CELL, "text-left text-muted-foreground/50 xl:text-right", i === 0 && edge, stow)}
          >
            —
          </TableCell>
        ))}
        <TableCell className={cn(COMPACT_CELL, "w-full text-right text-muted-foreground/50 xl:w-auto", stow)}>
          —
        </TableCell>
      </>
    );
  }
  if (latest.status === "error") {
    return (
      <>
        <FailedCell message={latest.errorMessage} className={cn(edge, stow)} />
        <TableCell className={cn(COMPACT_CELL, "w-full text-right xl:w-auto", stow)}>
          <RowActions row={latest} />
        </TableCell>
      </>
    );
  }
  const diffs = entry ? entryScoreDiffs(entry) : null;
  return (
    <>
      {SCORE_COLUMNS.map(({ category }, i) => (
        <ScoreCell
          key={category}
          score={latest.scores[category]}
          diff={diffs?.[category]}
          className={cn(i === 0 && edge, stow, pending && PENDING_SCORES)}
        />
      ))}
      <TableCell className={cn(COMPACT_CELL, "w-full text-right xl:w-auto", stow)}>
        <RowActions row={latest} />
      </TableCell>
    </>
  );
}

/**
 * The paired archive table for one website: one row per URL with the four
 * category scores shown twice under a two-level "Mobile | Desktop" header
 * (matching the PageSpeed page). Each device half carries its own re-run /
 * report / delete actions plus a compact "since last run" trend under each
 * score; a missing device shows em dashes. Rendered inside a website's accordion
 * section, so it never sees an empty set and needs no outer surface of its own.
 */
function PairedTableBody({
  pairs,
  device,
  onDeviceChange,
}: {
  pairs: DevicePair<CollapsedRun>[];
  device: PairedDevice;
  onDeviceChange: (next: PairedDevice) => void;
}) {
  // Below `xl` only one device's columns are displayed; the switch picks which.
  // From `xl` up both come back regardless, so the switch has no effect there —
  // which is why it is hidden at those widths rather than left as a dead control.
  const stowMobile = device === "desktop";
  const stowDesktop = device === "mobile";
  const stow = "hidden xl:table-cell";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 xl:hidden">
        <span className={cn(HEAD_LABEL, "text-muted-foreground")}>Device</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={device}
          onValueChange={(next) => {
            // Radix emits "" when the active item is re-pressed; a device is
            // always shown, so ignore it.
            if (next === "mobile" || next === "desktop") onDeviceChange(next);
          }}
          aria-label="Device columns"
        >
          <ToggleGroupItem
            value="mobile"
            className="font-mono text-[0.65rem] uppercase tracking-[0.16em]"
          >
            <Smartphone data-icon="inline-start" />
            Mobile
          </ToggleGroupItem>
          <ToggleGroupItem
            value="desktop"
            className="font-mono text-[0.65rem] uppercase tracking-[0.16em]"
          >
            <Monitor data-icon="inline-start" />
            Desktop
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/60">
      <Table>
        <TableHeader className="bg-card [&_th]:bg-card">
          {/* Top header: device-spanning groups over the per-device sub-columns.
              Stowing a whole group keeps the surviving one at colSpan 5 and
              leaves URL / Run at on rowSpan 2, so the two-level header stays
              structurally valid with either device alone. */}
          <TableRow className="hover:bg-transparent">
            <TableHead
              rowSpan={2}
              className={cn(HEAD_LABEL, "p-0 align-bottom xl:w-full xl:px-2")}
            >
              <span className="sr-only xl:not-sr-only">URL</span>
            </TableHead>
            {/* Both device captions are stowed below `xl`, not just the
                unselected one: the switch above the table already says which
                device is showing, so the band would only repeat it. */}
            <TableHead
              colSpan={SCORE_COLUMNS.length + 1}
              className={cn(HEAD_LABEL, "text-center text-primary", stow)}
            >
              Mobile
            </TableHead>
            <TableHead
              colSpan={SCORE_COLUMNS.length + 1}
              className={cn(
                HEAD_LABEL,
                "border-l border-border/50 text-center text-primary",
                stow,
              )}
            >
              Desktop
            </TableHead>
            <TableHead
              rowSpan={2}
              className={cn(HEAD_LABEL, "hidden align-bottom xl:table-cell")}
            >
              Run at
            </TableHead>
          </TableRow>
          {/* Sub-header: the four category short-labels + a report slot, per device. */}
          <TableRow className="hover:bg-transparent">
            {SCORE_COLUMNS.map(({ category }) => (
              <TableHead
                key={`m-${category}`}
                className={cn(HEAD_LABEL, SCORE_HEAD, stowMobile && stow)}
              >
                {CATEGORY_SHORT_LABELS[category]}
              </TableHead>
            ))}
            <TableHead className={cn(HEAD_LABEL, "text-right", stowMobile && stow)}>
              <span className="sr-only">Mobile report</span>
            </TableHead>
            {SCORE_COLUMNS.map(({ category }, i) => (
              <TableHead
                key={`d-${category}`}
                className={cn(
                  HEAD_LABEL,
                  SCORE_HEAD,
                  i === 0 && "border-l border-border/50",
                  stowDesktop && stow,
                )}
              >
                {CATEGORY_SHORT_LABELS[category]}
              </TableHead>
            ))}
            <TableHead className={cn(HEAD_LABEL, "text-right", stowDesktop && stow)}>
              <span className="sr-only">Desktop report</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pairs.map((pair) => {
            const primary = pair.primary.latest;
            const href = primary.finalUrl ?? primary.url;
              return (
                <TableRow key={primary.id} className="hover:bg-muted/40">
                  {/* `max-w-0` is what lets the URL truncate inside a table
                      cell, but it also let the column collapse to ~42px on a
                      phone — the engine badge and nothing else — so no row said
                      which page it was. Below `sm` the cap becomes a fixed 8rem
                      the scores cannot squeeze, and truncation still works. */}
                  {/* Below `xl` the URL, the engine badge and the run time all
                      leave the visual layout and the table is scores only — no
                      column narrower than that shows a path without either
                      clipping it or wrapping it over three lines. The cell stays
                      in the DOM as `sr-only` rather than `hidden`, so each row
                      still announces which page it is to assistive tech, and
                      drops its padding so it costs no width. Everything returns
                      from `xl` up. */}
                  <TableCell className={cn(COMPACT_CELL, "p-0 xl:p-2 xl:max-w-0")}>
                    <div className="sr-only items-center gap-1.5 xl:not-sr-only xl:flex">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block min-w-0 flex-1 truncate font-mono text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
                          >
                            {pair.url}
                          </a>
                        </TooltipTrigger>
                        <TooltipContent className="font-mono">{href}</TooltipContent>
                      </Tooltip>
                      <SourceBadge source={primary.source} />
                    </div>
                  </TableCell>
                  <HistoryDeviceHalf
                    entry={pair.mobile}
                    borderless
                    stowed={stowMobile}
                  />
                  <HistoryDeviceHalf entry={pair.desktop} stowed={stowDesktop} />
                  <TableCell className={cn(COMPACT_CELL, "hidden xl:table-cell")}>
                    <span
                      title={primary.createdAt}
                      className="font-mono text-xs tabular-nums text-muted-foreground"
                    >
                      {formatRunAt(primary.createdAt)}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}

/**
 * The flat archive table for one website: one row per page (its latest run) with
 * the four category scores, device, run time, and per-row actions. Column headers
 * stay sortable (sorting is global across every site). Rendered inside a website's
 * accordion section, so it never sees an empty set and needs no surface of its own.
 */
function FlatTableBody({
  entries,
  sort,
  handleSort,
}: {
  entries: CollapsedRun[];
  sort: SortState;
  handleSort: (key: SortKey) => void;
}) {
  const { pending } = useContext(RerunTrackingContext);
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <Table>
        <TableHeader className="bg-card [&_th]:bg-card">
          <TableRow className="hover:bg-transparent">
            <SortHeader
              label="URL"
              sortKey="url"
              sort={sort}
              onSort={handleSort}
              className="w-full"
            />
            <TableHead className={HEAD_LABEL}>Device</TableHead>
            {SCORE_COLUMNS.map(({ category, sortKey }) => (
              <SortHeader
                key={category}
                label={CATEGORY_SHORT_LABELS[category]}
                sortKey={sortKey}
                sort={sort}
                onSort={handleSort}
                numeric
                className={SCORE_HEAD}
              />
            ))}
            <SortHeader
              label="Run at"
              sortKey="createdAt"
              sort={sort}
              onSort={handleSort}
            />
            <TableHead className={cn(HEAD_LABEL, "text-right")}>Report</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            const row = entry.latest;
            const href = row.finalUrl ?? row.url;
            const diffs = entryScoreDiffs(entry);
            const rerunning = pending.has(row.id);
            return (
              <TableRow key={row.id} className="hover:bg-muted/40">
                <TableCell className={cn(COMPACT_CELL, "max-w-0")}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate font-mono text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
                      >
                        {row.url}
                      </a>
                    </TooltipTrigger>
                    <TooltipContent className="font-mono">{href}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className={COMPACT_CELL}>
                  <div className="flex items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground"
                    >
                      {row.formFactor}
                    </Badge>
                    <SourceBadge source={row.source} />
                  </div>
                </TableCell>
                {row.status === "error" ? (
                  <FailedCell message={row.errorMessage} />
                ) : (
                  SCORE_COLUMNS.map(({ category }) => (
                    <ScoreCell
                      key={category}
                      score={row.scores[category]}
                      diff={diffs?.[category]}
                      className={cn(rerunning && PENDING_SCORES)}
                    />
                  ))
                )}
                <TableCell className={COMPACT_CELL}>
                  <span
                    title={row.createdAt}
                    className="font-mono text-xs tabular-nums text-muted-foreground"
                  >
                    {formatRunAt(row.createdAt)}
                  </span>
                </TableCell>
                <TableCell className={cn(COMPACT_CELL, "text-right")}>
                  <RowActions row={row} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** A page's hostname, `www.` stripped; falls back to the raw string for non-URLs. */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return rawUrl;
  }
}

/**
 * Bucket items by the hostname of their URL, preserving first-appearance order
 * (a Map keeps insertion order) — so when the caller passes already-sorted
 * entries the websites come out in that same grouped order, and pages keep their
 * order within each site. Generic over the flat (`CollapsedRun`) and paired
 * (`DevicePair`) layouts via the `getUrl` accessor.
 */
function groupByHost<T>(
  items: readonly T[],
  getUrl: (item: T) => string,
): { host: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const host = hostOf(getUrl(item));
    const bucket = groups.get(host);
    if (bucket) bucket.push(item);
    else groups.set(host, [item]);
  }
  return Array.from(groups, ([host, hostItems]) => ({ host, items: hostItems }));
}

/**
 * One website's collapsible section: an accordion header carrying the hostname
 * and a compact telemetry strip (pages audited + how many still need work), over
 * a body — that site's table or cards — supplied as children. Mirrors the live
 * Audit results' per-host accordion so the two surfaces read the same way.
 */
function HostSection({
  host,
  pageCount,
  needsWorkCount,
  children,
}: {
  host: string;
  pageCount: number;
  needsWorkCount: number;
  children: React.ReactNode;
}) {
  return (
    <AccordionItem
      value={host}
      className="rounded-lg border border-border/60 bg-card/40 px-4"
    >
      <AccordionTrigger className="items-center hover:no-underline">
        <span className="flex flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1 pr-3">
          <span className="flex items-center gap-2">
            <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-mono text-sm text-foreground">{host}</span>
          </span>
          <span className="flex items-center gap-4 font-mono text-[0.7rem] uppercase tracking-[0.16em] tabular-nums">
            {needsWorkCount > 0 ? (
              <span className="text-muted-foreground">
                <span className="text-score-average">{needsWorkCount}</span> need
                work
              </span>
            ) : (
              <span className="text-score-good">All pass</span>
            )}
            <span className="text-muted-foreground">
              <span className="text-foreground">{pageCount}</span>{" "}
              {pageCount === 1 ? "page" : "pages"}
            </span>
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent>{children}</AccordionContent>
    </AccordionItem>
  );
}

interface HistoryTableProps {
  rows: HistoryRow[];
}

/**
 * Sortable + filterable archive of every persisted run. All sorting/filtering
 * happens in-browser over the rows passed from the server (no fetching). Defaults
 * to a grouped "by URL" order (site root → other public pages → blog and its
 * sub-pages, alphabetical within each); the headers still re-sort by URL, any of
 * the four category scores (nulls last), or run time. Filter by URL substring,
 * and/or flip the Needs-work toggle to hide everything that already scores 90+.
 */
function HistoryTableView({ rows }: HistoryTableProps) {
  const filterId = useId();
  const { defaults, update } = useAuditDefaults();
  const view = defaults.resultsView;
  const [query, setQuery] = useState("");
  // Hide URLs that passed every category at 90+, leaving only ones needing work.
  const [needsWorkOnly, setNeedsWorkOnly] = useState(false);
  // Which device half the paired table shows on a phone (see PairedDevice).
  const [pairedDevice, setPairedDevice] = useState<PairedDevice>("mobile");
  // Default order groups by URL (root → pages → blog) rather than by run time.
  const [sort, setSort] = useState<SortState>({
    key: "url",
    direction: "asc",
  });

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : // New column: scores/time default to desc (high→low / newest), URL to asc.
          { key, direction: key === "url" ? "asc" : "desc" },
    );
  }, []);

  // De-duplicate first: one entry per (engine, device, URL) series — its latest
  // run plus the prior run to diff against — so the archive shows a single row per
  // page with a trend, not a stack of repeated runs.
  const entries = useMemo(() => collapseRuns(rows), [rows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? entries.filter((entry) => entry.latest.url.toLowerCase().includes(needle))
      : entries;

    const dir = sort.direction === "asc" ? 1 : -1;
    return filtered.toSorted((a, b) => {
      const ra = a.latest;
      const rb = b.latest;
      if (sort.key === "url") {
        // Grouped order: site root, then other public pages, then the blog and
        // its sub-pages — alphabetical within each section. Same URL (different
        // engine/device) stays newest-first regardless of the sort direction.
        const grouped = compareUrlGroup(ra.url, rb.url);
        if (grouped !== 0) return grouped * dir;
        return rb.createdAt.localeCompare(ra.createdAt);
      }
      if (sort.key === "createdAt") {
        return ra.createdAt.localeCompare(rb.createdAt) * dir;
      }
      // Score columns. Nulls always sink to the bottom regardless of sort
      // direction; only the non-null vs non-null comparison is reversed.
      const av = ra.scores[sort.key];
      const bv = rb.scores[sort.key];
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;
      if (aNull || bNull) return compareScores(av, bv);
      return compareScores(av, bv) * dir;
    });
  }, [entries, query, sort]);

  // When the archive spans BOTH devices, mirror the PageSpeed page and fold each
  // URL's mobile + desktop series into one paired entry. Single-device archives
  // keep the sortable one-row-per-page layout. The layout is decided from the full
  // dataset (not the filtered `visible` set) so it doesn't flip mid-filter. Paired
  // rows are re-sorted by the same grouped "by URL" rule as the flat table.
  const paired = useMemo(
    () => hasBothDevices(rows, (row) => row.formFactor),
    [rows],
  );
  const basePairs = useMemo(() => {
    if (!paired) return [];
    return pairCollapsedRuns(visible).toSorted((a, b) => {
      const grouped = compareUrlGroup(a.url, b.url);
      if (grouped !== 0) return grouped;
      return b.primary.latest.createdAt.localeCompare(a.primary.latest.createdAt);
    });
  }, [paired, visible]);

  // "Needs work" gate: drop everything that passed every category at 90+, leaving
  // only the pages that still need attention. Applied per-page in the flat layout
  // and per-URL (any failing device side) in the paired layout.
  const flatRows = useMemo(
    () =>
      needsWorkOnly
        ? visible.filter((entry) => rowNeedsWork(entry.latest))
        : visible,
    [visible, needsWorkOnly],
  );
  const pairs = useMemo(
    () => (needsWorkOnly ? basePairs.filter(pairNeedsWork) : basePairs),
    [basePairs, needsWorkOnly],
  );

  // How many pages still need work within the current URL filter (independent of
  // the toggle itself) — surfaced on the toggle so its effect stays legible.
  const needsWorkCount = useMemo(
    () =>
      paired
        ? basePairs.filter(pairNeedsWork).length
        : visible.filter((entry) => rowNeedsWork(entry.latest)).length,
    [paired, basePairs, visible],
  );

  // Group the visible pages by website (hostname) into the collapsible sections.
  // Built from the already-sorted entries/pairs, so sites come out in the same
  // grouped order and pages keep their order within each site. Only the active
  // layout's layer is populated (flat vs. paired).
  const flatHostGroups = useMemo(
    () => (paired ? [] : groupByHost(flatRows, (entry) => entry.latest.url)),
    [paired, flatRows],
  );
  const pairedHostGroups = useMemo(
    () => (paired ? groupByHost(pairs, (pair) => pair.url) : []),
    [paired, pairs],
  );

  // Seed the accordion open on the site you audited most recently, so landing on
  // the archive shows that run instead of a wall of closed sections. Derived from
  // the full dataset rather than the filtered view so it can't shift mid-filter —
  // and it only seeds the *initial* open set (`defaultValue`), leaving the user's
  // own expand/collapse choices untouched from then on.
  const defaultOpenHosts = useMemo(() => {
    let newest: HistoryRow | null = null;
    for (const row of rows) {
      if (!newest || row.createdAt.localeCompare(newest.createdAt) > 0) {
        newest = row;
      }
    }
    return newest ? [hostOf(newest.url)] : [];
  }, [rows]);

  const isFiltering = query.trim().length > 0 || needsWorkOnly;

  // What the control band's readout reports: the sites and pages actually on
  // screen under the current filter, from whichever layout layer is populated.
  const visibleSiteCount = paired
    ? pairedHostGroups.length
    : flatHostGroups.length;
  const visiblePageCount = paired ? pairs.length : flatRows.length;

  // The latest runs actually shown — and therefore exported / bulk-opened: the
  // flat list in single-device mode, or both present sides of every visible pair.
  const exportRows = useMemo<HistoryRow[]>(
    () =>
      paired
        ? pairs.flatMap((pair) =>
            [pair.mobile, pair.desktop]
              .filter((entry): entry is CollapsedRun => entry != null)
              .map((entry) => entry.latest),
          )
        : flatRows.map((entry) => entry.latest),
    [paired, pairs, flatRows],
  );

  // HTML reports for the visible rows that actually have one — for bulk-open.
  const openableHrefs = useMemo(
    () =>
      exportRows
        .filter((row) => row.status !== "error" && row.hasHtmlReport)
        .map((row) => reportHtmlUrl(row.id)),
    [exportRows],
  );

  const hasRows = exportRows.length > 0;
  const openableCount = openableHrefs.length;

  // Serialize in the handler (not on render) — exports the currently visible set.
  const exportJson = useCallback(() => {
    downloadJson(`lighthouse-history-${timestampSlug()}.json`, rowsToJson(exportRows));
  }, [exportRows]);

  const exportCsv = useCallback(() => {
    downloadCsv(`lighthouse-history-${timestampSlug()}.csv`, rowsToCsv(exportRows));
  }, [exportRows]);

  const openAll = useCallback(() => {
    const opened = openUrlsInNewTabs(openableHrefs);
    if (opened < openableHrefs.length) {
      toast.warning("Some reports didn't open", {
        description: `Opened ${opened} of ${openableHrefs.length} — your browser's popup blocker may have stopped the rest.`,
      });
    }
  }, [openableHrefs]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-6">
        {/* Control band. These were a bare row on the page background: a small
            search box at the far left and seven buttons pinned to the far
            right, with ~1500px of nothing between them at desk widths and
            three ragged wrapped rows on a phone. They are now one instrument
            panel — a filter band over a footer whose readout says exactly what
            the actions in its bezel will act on. Container query so it reflows
            to the card, not the viewport. */}
        <Card>
          <CardContent className="@container flex flex-col gap-5 px-4">
            <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="font-heading text-base font-medium leading-snug">
                Archive
              </h2>
              <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                Grouped by website · latest run per URL · trend vs previous
              </p>
            </header>

            <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-end @2xl:justify-between @2xl:gap-6">
              <div className="flex min-w-0 flex-1 flex-col gap-2 @2xl:max-w-sm">
                <label
                  htmlFor={filterId}
                  className={cn(HEAD_LABEL, "text-muted-foreground")}
                >
                  Filter by URL
                </label>
                <div className="relative">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id={filterId}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="example.com"
                    className="pl-8 font-mono text-xs"
                  />
                </div>
              </div>

              {/* Below @sm the panel is only ~310px wide, so these stack to the
                  full width instead of packing left and leaving a ragged gap. */}
              <div className="flex flex-col gap-2 @sm:flex-row @sm:flex-wrap @sm:items-center @sm:gap-3">
            {/* Hide everything already scoring 90+; keep only URLs needing work. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={needsWorkOnly ? "default" : "outline"}
                  size="sm"
                  aria-pressed={needsWorkOnly}
                  disabled={rows.length === 0}
                  onClick={() => setNeedsWorkOnly((prev) => !prev)}
                  className="w-full justify-start @sm:w-auto @sm:justify-center"
                >
                  <Filter data-icon="inline-start" />
                  Needs work
                  {needsWorkCount > 0 ? (
                    <span className="font-mono text-[0.7rem] tabular-nums opacity-80">
                      {needsWorkCount}
                    </span>
                  ) : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {needsWorkOnly
                  ? "Showing only URLs with a category below 90. Click to show all runs."
                  : "Hide URLs that passed every category at 90+, leaving only the ones that need work."}
              </TooltipContent>
            </Tooltip>

            {/* `*:flex-1` splits Table / Cards evenly across the full width
                while the control is stretched; it reverts to natural width
                alongside the filter once the panel can hold a row. */}
            <ResultsViewToggle
              value={view}
              onChange={(next) => update({ resultsView: next })}
              className="w-full *:flex-1 @sm:w-auto @sm:*:flex-none"
            />
              </div>
            </div>

            {/* Instrument footer: the numbers the actions operate on, and the
                actions themselves, in one bezel — so "Export 39 runs" is
                answerable without counting rows, and the destructive Clear sits
                with its siblings instead of orphaned on its own wrapped line. */}
            <Readout className="@3xl:flex-row @3xl:items-center @3xl:justify-between @3xl:gap-6">
              <div className="flex min-w-0 flex-col gap-2">
                {/* Four cells wrap 3-then-1 on a phone, stranding a whole row
                    for "Reports". A 2×2 grid fills the strip evenly instead. */}
                <ReadoutCells className="grid grid-cols-2 items-start gap-y-3 @sm:flex">
                  <ReadoutCell
                    icon={<Globe className="size-3" aria-hidden />}
                    label="Sites"
                    value={String(visibleSiteCount)}
                  />
                  <ReadoutCell
                    icon={<Archive className="size-3" aria-hidden />}
                    label="In view"
                    value={`${visiblePageCount} ${visiblePageCount === 1 ? "page" : "pages"}`}
                  />
                  <ReadoutCell
                    icon={<FileJson className="size-3" aria-hidden />}
                    label="Exports"
                    value={`${exportRows.length} ${exportRows.length === 1 ? "run" : "runs"}`}
                  />
                  <ReadoutCell
                    icon={<ExternalLink className="size-3" aria-hidden />}
                    label="Reports"
                    value={String(openableCount)}
                    tone={openableCount > 0 ? "good" : "default"}
                  />
                </ReadoutCells>
                <ReadoutNote>
                  {isFiltering
                    ? "Export and Open all act on the filtered set above. Clear history still removes every persisted run, filtered or not."
                    : "Export and Open all act on every run shown. Clear history removes them all permanently."}
                </ReadoutNote>
              </div>

              <div className="flex w-full shrink-0 flex-col gap-2 @sm:w-auto @sm:flex-row @sm:flex-wrap @sm:items-center @3xl:justify-end">
                {/* The three export actions share one full-width row on a
                    phone; Clear history keeps its own row below rather than
                    sitting a thumb's width from "Open all". */}
                <div
                  className="grid grid-cols-3 gap-1 @sm:flex @sm:items-center"
                  role="group"
                  aria-label="Export and open visible runs"
                >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={exportJson}
                  disabled={!hasRows}
                  aria-label="Export visible runs as JSON"
                  className="w-full @sm:w-auto"
                >
                  <FileJson data-icon="inline-start" />
                  JSON
                </Button>
              </TooltipTrigger>
              <TooltipContent className="font-mono">
                Export {exportRows.length} run{exportRows.length === 1 ? "" : "s"} · JSON
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={exportCsv}
                  disabled={!hasRows}
                  aria-label="Export visible runs as CSV"
                  className="w-full @sm:w-auto"
                >
                  <Sheet data-icon="inline-start" />
                  CSV
                </Button>
              </TooltipTrigger>
              <TooltipContent className="font-mono">
                Export {exportRows.length} run{exportRows.length === 1 ? "" : "s"} · CSV
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={openAll}
                  disabled={openableCount === 0}
                  aria-label={`Open all ${openableCount} visible reports`}
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
                </div>

                {/* Clear all persisted history (every run, regardless of filter). */}
                <ClearHistoryButton
                  count={rows.length}
                  className="w-full @sm:w-auto"
                />
              </div>
            </Readout>
          </CardContent>
        </Card>

        {!hasRows ? (
          <Card className="overflow-hidden">
            <HistoryEmptyState isFiltering={isFiltering} />
          </Card>
        ) : paired ? (
          // One collapsible section per website, the most recently audited site
          // open and the rest closed; the user expands the others they care
          // about. Uncontrolled so an opened section stays open across filtering
          // (Radix keeps its own open-state).
          <Accordion
            type="multiple"
            defaultValue={defaultOpenHosts}
            className="flex flex-col gap-3"
          >
            {pairedHostGroups.map((group) => (
              <HostSection
                key={group.host}
                host={group.host}
                pageCount={group.items.length}
                needsWorkCount={group.items.filter(pairNeedsWork).length}
              >
                {view === "cards" ? (
                  <PairedCardsBody pairs={group.items} />
                ) : (
                  <PairedTableBody
                    pairs={group.items}
                    device={pairedDevice}
                    onDeviceChange={setPairedDevice}
                  />
                )}
              </HostSection>
            ))}
          </Accordion>
        ) : (
          <Accordion
            type="multiple"
            defaultValue={defaultOpenHosts}
            className="flex flex-col gap-3"
          >
            {flatHostGroups.map((group) => (
              <HostSection
                key={group.host}
                host={group.host}
                pageCount={group.items.length}
                needsWorkCount={
                  group.items.filter((entry) => rowNeedsWork(entry.latest)).length
                }
              >
                {view === "cards" ? (
                  <CardsBody entries={group.items} />
                ) : (
                  <FlatTableBody
                    entries={group.items}
                    sort={sort}
                    handleSort={handleSort}
                  />
                )}
              </HostSection>
            ))}
          </Accordion>
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * The History archive: the filter console plus one collapsible section per
 * website, wrapped in the in-place re-run tracker so a row's re-run button can
 * refresh the table without leaving the page.
 */
export function HistoryTable(props: HistoryTableProps) {
  return (
    <RerunTrackingProvider>
      <HistoryTableView {...props} />
    </RerunTrackingProvider>
  );
}
