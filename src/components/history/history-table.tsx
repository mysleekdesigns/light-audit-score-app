"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  ExternalLink,
  FileJson,
  Search,
  Sheet,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { CoreWebVitalsStrip } from "@/components/audit/core-web-vitals";
import { EnvironmentBadge } from "@/components/audit/environment-badge";
import { RerunBatchButton } from "@/components/audit/rerun-batch-button";
import { ResultsViewToggle } from "@/components/audit/results-view-toggle";
import { ScoreRings } from "@/components/audit/score-rings";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuditDefaults } from "@/hooks/useAuditDefaults";
import {
  clearHistory,
  deleteRun,
  reportHtmlUrl,
  reportJsonUrl,
} from "@/lib/client/auditClient";
import type { HistoryRow } from "@/lib/db/persistence";
import {
  downloadCsv,
  downloadJson,
  openUrlsInNewTabs,
  timestampSlug,
} from "@/lib/export/download";
import type { DevicePair } from "@/lib/pairing/devicePairs";
import { hasBothDevices, pairByDevice } from "@/lib/pairing/devicePairs";
import { rowsToCsv, rowsToJson } from "@/lib/export/exporters";
import type { LighthouseCategory } from "@/lib/lighthouse/types";
import { CATEGORY_SHORT_LABELS, formatScore, scoreColorClass } from "@/lib/scores";
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

/** Shared header label styling — mono, uppercase, tracked, matching the house style. */
const HEAD_LABEL = "font-mono text-[0.7rem] uppercase tracking-[0.16em]";

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
          numeric && "flex-row-reverse",
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
 * A compact engine badge — cyan "PSI" for PageSpeed Insights runs; nothing for
 * the local engine (the common case stays uncluttered).
 */
function SourceBadge({ source }: { source: HistoryRow["source"] }) {
  if (source !== "psi") return null;
  return (
    <Badge
      variant="outline"
      className="border-primary/40 bg-primary/10 font-mono text-[0.6rem] uppercase tracking-[0.12em] text-primary"
    >
      PSI
    </Badge>
  );
}

/** A single score cell: mono, tabular, colour-banded. */
function ScoreCell({
  score,
  className,
}: {
  score: number | null | undefined;
  className?: string;
}) {
  const value = score ?? null;
  return (
    <TableCell className={cn(COMPACT_CELL, "text-right", className)}>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          scoreColorClass(value),
        )}
      >
        {formatScore(value)}
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
function ClearHistoryButton({ count }: { count: number }) {
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

/**
 * Per-run action cluster: re-run this single page (PRD §6 Phase 13), delete it,
 * plus the report links. Re-run and delete are available even for errored rows,
 * so they sit outside the report links (which collapse to `—` for failures).
 */
function RowActions({ row }: { row: HistoryRow }) {
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
          ? "No persisted run matches that URL filter."
          : "Completed runs are persisted here automatically. Run an audit to populate the archive."}
      </p>
    </div>
  );
}

/** A single ring-card for the cards view — the History analogue of the live result card. */
function HistoryRunCard({ row }: { row: HistoryRow }) {
  const href = row.finalUrl ?? row.url;
  const isError = row.status === "error";

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
              {row.url}
            </a>
          </TooltipTrigger>
          <TooltipContent className="font-mono">{href}</TooltipContent>
        </Tooltip>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground"
          >
            {row.formFactor}
          </Badge>
          <SourceBadge source={row.source} />
          <span
            title={row.createdAt}
            className="font-mono text-[0.65rem] tabular-nums text-muted-foreground"
          >
            {formatRunAt(row.createdAt)}
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
              {row.errorMessage ?? "Unknown error"}
            </span>
          </div>
        ) : (
          <>
            <ScoreRings scores={row.scores} size={48} />
            {row.metrics ? (
              <CoreWebVitalsStrip metrics={row.metrics} />
            ) : null}
          </>
        )}
        {row.environment ? (
          <EnvironmentBadge variant="compact" environment={row.environment} />
        ) : null}
        <div className="flex items-center justify-end">
          <RowActions row={row} />
        </div>
      </CardContent>
    </Card>
  );
}

/** The ring-card grid over the same filtered + sorted rows as the table. */
function HistoryCardsView({
  rows,
  isFiltering,
}: {
  rows: HistoryRow[];
  isFiltering: boolean;
}) {
  if (rows.length === 0) {
    return (
      <Card className="overflow-hidden">
        <HistoryEmptyState isFiltering={isFiltering} />
      </Card>
    );
  }
  return (
    <ul className="grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((row) => (
        <li key={row.id}>
          <HistoryRunCard row={row} />
        </li>
      ))}
    </ul>
  );
}

// --- Paired (Mobile + Desktop per URL) views -------------------------------
// Mirror the PageSpeed page: when the visible runs span both devices, fold each
// URL's mobile + desktop run into a single entry. Pairing is scoped per batch so
// the same URL audited in two different batches never collides (see devicePairs).

/** Mono uppercase device caption ("Mobile" / "Desktop"), matching the house label style. */
const DEVICE_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/**
 * Pair the rows into per-URL `{ mobile, desktop }` couples, grouped by `batchId`
 * first so the same URL run in two batches stays separate. Input order (newest
 * first from `listHistory`) is preserved across both the batch grouping and the
 * pairing, so the paired list stays newest-first.
 */
function pairHistoryRows(rows: HistoryRow[]): DevicePair<HistoryRow>[] {
  const byBatch = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const group = byBatch.get(row.batchId);
    if (group) group.push(row);
    else byBatch.set(row.batchId, [row]);
  }
  const pairs: DevicePair<HistoryRow>[] = [];
  for (const group of byBatch.values()) {
    pairs.push(
      ...pairByDevice(
        group,
        (row) => row.url,
        (row) => row.formFactor,
      ),
    );
  }
  return pairs;
}

/**
 * One device's section within a {@link PairedHistoryCard}: a device caption, then
 * the rings + CWV + environment (done), the failure line (error), or an em-dash
 * note when this URL wasn't audited on this device. Each present device keeps its
 * own re-run / report / delete actions.
 */
function HistoryDeviceSection({
  device,
  row,
}: {
  device: "Mobile" | "Desktop";
  row: HistoryRow | null;
}) {
  const isError = row?.status === "error";
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
      {!row ? (
        <p className="font-mono text-xs text-muted-foreground/50">
          Not audited on {device.toLowerCase()}
        </p>
      ) : isError ? (
        <p className="text-xs text-muted-foreground">
          {row.errorMessage ?? "Unknown error"}
        </p>
      ) : (
        <>
          <ScoreRings scores={row.scores} size={48} />
          {row.metrics ? <CoreWebVitalsStrip metrics={row.metrics} /> : null}
          {row.environment ? (
            <EnvironmentBadge variant="compact" environment={row.environment} />
          ) : null}
        </>
      )}
      {row ? (
        <div className="flex items-center justify-end">
          <RowActions row={row} />
        </div>
      ) : null}
    </div>
  );
}

/** A paired ring-card: one card per URL carrying both device ring-sets, stacked. */
function PairedHistoryCard({ pair }: { pair: DevicePair<HistoryRow> }) {
  const { primary } = pair;
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
        <HistoryDeviceSection device="Mobile" row={pair.mobile} />
        <div className="border-t border-border/50" />
        <HistoryDeviceSection device="Desktop" row={pair.desktop} />
      </CardContent>
    </Card>
  );
}

/** The paired ring-card grid over the same filtered rows as the paired table. */
function PairedHistoryCardsView({
  pairs,
  isFiltering,
}: {
  pairs: DevicePair<HistoryRow>[];
  isFiltering: boolean;
}) {
  if (pairs.length === 0) {
    return (
      <Card className="overflow-hidden">
        <HistoryEmptyState isFiltering={isFiltering} />
      </Card>
    );
  }
  return (
    <ul className="grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {pairs.map((pair) => (
        <li key={pair.primary.id}>
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
  row,
  borderless = false,
}: {
  row: HistoryRow | null;
  borderless?: boolean;
}) {
  const edge = borderless ? undefined : "border-l border-border/50";
  if (!row) {
    return (
      <>
        {SCORE_COLUMNS.map(({ category }, i) => (
          <TableCell
            key={category}
            className={cn(COMPACT_CELL, "text-right text-muted-foreground/50", i === 0 && edge)}
          >
            —
          </TableCell>
        ))}
        <TableCell className={cn(COMPACT_CELL, "text-right text-muted-foreground/50")}>
          —
        </TableCell>
      </>
    );
  }
  if (row.status === "error") {
    return (
      <>
        <FailedCell message={row.errorMessage} className={edge} />
        <TableCell className={cn(COMPACT_CELL, "text-right")}>
          <RowActions row={row} />
        </TableCell>
      </>
    );
  }
  return (
    <>
      {SCORE_COLUMNS.map(({ category }, i) => (
        <ScoreCell
          key={category}
          score={row.scores[category]}
          className={i === 0 ? edge : undefined}
        />
      ))}
      <TableCell className={cn(COMPACT_CELL, "text-right")}>
        <RowActions row={row} />
      </TableCell>
    </>
  );
}

/**
 * The paired archive table: one row per URL with the four category scores shown
 * twice under a two-level "Mobile | Desktop" header (matching the PageSpeed page).
 * Each device half carries its own re-run / report / delete actions; a missing
 * device shows em dashes. Score columns aren't sortable in this mode — a single
 * sort can't disambiguate the two devices — but the URL filter still applies and
 * rows stay newest-first.
 */
function PairedHistoryTableView({
  pairs,
  isFiltering,
}: {
  pairs: DevicePair<HistoryRow>[];
  isFiltering: boolean;
}) {
  // URL + (4 scores + actions) × 2 devices + Run at.
  const totalCols = 2 * (SCORE_COLUMNS.length + 1) + 2;
  return (
    <Card className="overflow-hidden py-0">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card [&_th]:bg-card">
          {/* Top header: device-spanning groups over the per-device sub-columns. */}
          <TableRow className="hover:bg-transparent">
            <TableHead rowSpan={2} className={cn(HEAD_LABEL, "w-full align-bottom")}>
              URL
            </TableHead>
            <TableHead
              colSpan={SCORE_COLUMNS.length + 1}
              className={cn(HEAD_LABEL, "text-center text-primary")}
            >
              Mobile
            </TableHead>
            <TableHead
              colSpan={SCORE_COLUMNS.length + 1}
              className={cn(HEAD_LABEL, "border-l border-border/50 text-center text-primary")}
            >
              Desktop
            </TableHead>
            <TableHead rowSpan={2} className={cn(HEAD_LABEL, "align-bottom")}>
              Run at
            </TableHead>
          </TableRow>
          {/* Sub-header: the four category short-labels + a report slot, per device. */}
          <TableRow className="hover:bg-transparent">
            {SCORE_COLUMNS.map(({ category }) => (
              <TableHead key={`m-${category}`} className={cn(HEAD_LABEL, "text-right")}>
                {CATEGORY_SHORT_LABELS[category]}
              </TableHead>
            ))}
            <TableHead className={cn(HEAD_LABEL, "text-right")}>
              <span className="sr-only">Mobile report</span>
            </TableHead>
            {SCORE_COLUMNS.map(({ category }, i) => (
              <TableHead
                key={`d-${category}`}
                className={cn(HEAD_LABEL, "text-right", i === 0 && "border-l border-border/50")}
              >
                {CATEGORY_SHORT_LABELS[category]}
              </TableHead>
            ))}
            <TableHead className={cn(HEAD_LABEL, "text-right")}>
              <span className="sr-only">Desktop report</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pairs.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={totalCols} className="h-64 p-0">
                <HistoryEmptyState isFiltering={isFiltering} />
              </TableCell>
            </TableRow>
          ) : (
            pairs.map((pair) => {
              const href = pair.primary.finalUrl ?? pair.primary.url;
              return (
                <TableRow key={pair.primary.id} className="hover:bg-muted/40">
                  <TableCell className={cn(COMPACT_CELL, "max-w-0")}>
                    <div className="flex items-center gap-1.5">
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
                      <SourceBadge source={pair.primary.source} />
                    </div>
                  </TableCell>
                  <HistoryDeviceHalf row={pair.mobile} borderless />
                  <HistoryDeviceHalf row={pair.desktop} />
                  <TableCell className={COMPACT_CELL}>
                    <span
                      title={pair.primary.createdAt}
                      className="font-mono text-xs tabular-nums text-muted-foreground"
                    >
                      {formatRunAt(pair.primary.createdAt)}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

interface HistoryTableProps {
  rows: HistoryRow[];
}

/**
 * Sortable + filterable archive of every persisted run. All sorting/filtering
 * happens in-browser over the rows passed from the server (no fetching). Sort by
 * URL, any of the four category scores (nulls last), or run time; filter by URL
 * substring.
 */
export function HistoryTable({ rows }: HistoryTableProps) {
  const filterId = useId();
  const { defaults, update } = useAuditDefaults();
  const view = defaults.resultsView;
  const [query, setQuery] = useState("");
  // Default order matches `listHistory` (newest first).
  const [sort, setSort] = useState<SortState>({
    key: "createdAt",
    direction: "desc",
  });

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : // New column: scores/time default to desc (high→low / newest), URL to asc.
          { key, direction: key === "url" ? "asc" : "desc" },
    );
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((row) => row.url.toLowerCase().includes(needle))
      : rows;

    const dir = sort.direction === "asc" ? 1 : -1;
    return filtered.toSorted((a, b) => {
      let cmp: number;
      if (sort.key === "url") {
        cmp = a.url.localeCompare(b.url);
      } else if (sort.key === "createdAt") {
        cmp = a.createdAt.localeCompare(b.createdAt);
      } else {
        // Score columns. Nulls always sink to the bottom regardless of sort
        // direction; only the non-null vs non-null comparison is reversed.
        const av = a.scores[sort.key];
        const bv = b.scores[sort.key];
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull || bNull) return compareScores(av, bv);
        return compareScores(av, bv) * dir;
      }
      return cmp * dir;
    });
  }, [rows, query, sort]);

  // When the archive spans BOTH devices, mirror the PageSpeed page and fold each
  // URL's mobile + desktop run into one paired entry. Single-device archives keep
  // the original sortable one-row-per-run layout. The layout is decided from the
  // full dataset (not the filtered `visible` set) so it doesn't flip mid-filter;
  // the paired list itself reads from the (newest-first) `visible` rows. Score
  // sorting is disabled in paired mode — a single sort can't disambiguate devices.
  const paired = useMemo(
    () => hasBothDevices(rows, (row) => row.formFactor),
    [rows],
  );
  const pairs = useMemo(
    () => (paired ? pairHistoryRows(visible) : []),
    [paired, visible],
  );

  const isFiltering = query.trim().length > 0;

  // HTML reports for the visible rows that actually have one — for bulk-open.
  const openableHrefs = useMemo(
    () =>
      visible
        .filter((row) => row.status !== "error" && row.hasHtmlReport)
        .map((row) => reportHtmlUrl(row.id)),
    [visible],
  );

  const hasRows = visible.length > 0;
  const openableCount = openableHrefs.length;

  // Serialize in the handler (not on render) — exports the currently visible set.
  const exportJson = useCallback(() => {
    downloadJson(`lighthouse-history-${timestampSlug()}.json`, rowsToJson(visible));
  }, [visible]);

  const exportCsv = useCallback(() => {
    downloadCsv(`lighthouse-history-${timestampSlug()}.csv`, rowsToCsv(visible));
  }, [visible]);

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
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2 sm:max-w-xs sm:flex-1">
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

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <ResultsViewToggle
              value={view}
              onChange={(next) => update({ resultsView: next })}
            />

            {/* Export / bulk-open the currently visible (filtered + sorted) rows. */}
            <div
              className="flex items-center gap-1"
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
                >
                  <FileJson data-icon="inline-start" />
                  JSON
                </Button>
              </TooltipTrigger>
              <TooltipContent className="font-mono">
                Export {visible.length} run{visible.length === 1 ? "" : "s"} · JSON
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
                >
                  <Sheet data-icon="inline-start" />
                  CSV
                </Button>
              </TooltipTrigger>
              <TooltipContent className="font-mono">
                Export {visible.length} run{visible.length === 1 ? "" : "s"} · CSV
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
            <ClearHistoryButton count={rows.length} />
          </div>
        </div>

        {view === "cards" ? (
          paired ? (
            <PairedHistoryCardsView pairs={pairs} isFiltering={isFiltering} />
          ) : (
            <HistoryCardsView rows={visible} isFiltering={isFiltering} />
          )
        ) : paired ? (
          <PairedHistoryTableView pairs={pairs} isFiltering={isFiltering} />
        ) : (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card [&_th]:bg-card">
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
                  />
                ))}
                <SortHeader
                  label="Run at"
                  sortKey="createdAt"
                  sort={sort}
                  onSort={handleSort}
                />
                <TableHead className={cn(HEAD_LABEL, "text-right")}>
                  Report
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={8} className="h-64 p-0">
                    <div className="flex flex-col items-center justify-center gap-3 text-center">
                      <div className="flex size-12 items-center justify-center rounded-full border border-border/70 bg-muted/30">
                        <Archive className="size-5 text-muted-foreground" />
                      </div>
                      <p className="text-sm font-medium text-foreground">
                        {isFiltering ? "No matching runs" : "No audits yet"}
                      </p>
                      <p className="max-w-sm text-sm text-muted-foreground">
                        {isFiltering
                          ? "No persisted run matches that URL filter."
                          : "Completed runs are persisted here automatically. Run an audit to populate the archive."}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((row) => {
                  const href = row.finalUrl ?? row.url;
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
                          <TooltipContent className="font-mono">
                            {href}
                          </TooltipContent>
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
                })
              )}
            </TableBody>
          </Table>
        </Card>
        )}
      </div>
    </TooltipProvider>
  );
}
