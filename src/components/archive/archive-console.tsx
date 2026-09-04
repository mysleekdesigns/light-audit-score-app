"use client";

/**
 * Archive console (PRD §6 Phase 14 — Scheduled daily archive).
 *
 * Renders one card per persisted schedule. Each card shows the schedule's
 * cadence + target + last/next fire, lets the user edit it (name, fire time,
 * armed) or delete it, drives it with a single Run now / Pause button (Run now
 * fires it, resuming a paused run where it left off; Pause stops the run in
 * flight), and lists the batches the schedule has actually produced (latest
 * first) with category-score pills. Mutations hit Agent A's `/api/schedules/**`
 * routes and then `router.refresh()` so the server page re-reads SQLite and the
 * UI reflects truth — same pattern as `RerunBatchButton`.
 *
 * All cadence math is computed on the client via the shared `nextFireAt`, off
 * the `useMinuteTick` wall clock, so the "Next run" tick stays fresh without
 * server work and without a hydration mismatch. The Edit dialog reads the same
 * clock, so its preview and the card's cell can never disagree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe,
  Loader2,
  PauseCircle,
  Pencil,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { EditScheduleDialog } from "@/components/archive/edit-schedule-dialog";
import { ScorePill } from "@/components/audit/score-pill";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBatchStream } from "@/hooks/useBatchStream";
import { useMinuteTick } from "@/hooks/useMinuteTick";
import { deleteBatch } from "@/lib/client/auditClient";
import type { BatchInfo, HistoryRow } from "@/lib/db/persistence";
import { nextFireAt } from "@/lib/schedules/cadence";
import {
  describeTarget,
  formatCountdown,
  formatTimestamp,
} from "@/lib/schedules/format";
import type { Schedule } from "@/lib/schedules/types";
import { LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";
import { CATEGORY_SHORT_LABELS } from "@/lib/scores";
import { cn } from "@/lib/utils";

/** Mono uppercase tracked section label — the house "telemetry" label style. */
const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

interface ArchiveConsoleProps {
  schedules: Schedule[];
  /**
   * Every persisted batch — the console filters each schedule's history out of
   * this list via `scheduleId`. Passed down so the SSR page reads SQLite once.
   */
  batches: BatchInfo[];
  /**
   * Optional preloaded run rows per batch id (compact trend strips). Not used
   * today (Archive shows a batch-level trend, not run-level), but reserved so
   * a future expand could enrich without re-shaping the seam.
   */
  runs?: HistoryRow[];
}

export function ArchiveConsole({ schedules, batches }: ArchiveConsoleProps) {
  // Pre-group batches by scheduleId once — each card slices its own slice.
  const batchesBySchedule = useMemo(() => {
    const map = new Map<string, BatchInfo[]>();
    for (const batch of batches) {
      if (batch.scheduleId === null) continue;
      const list = map.get(batch.scheduleId);
      if (list) list.push(batch);
      else map.set(batch.scheduleId, [batch]);
    }
    return map;
  }, [batches]);

  if (schedules.length === 0) {
    return (
      <Empty className="border border-border/60 bg-card/40">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarClock />
          </EmptyMedia>
          <EmptyTitle>No schedules yet</EmptyTitle>
          <EmptyDescription>
            Save a daily schedule from the Lighthouse page to start a recurring
            archive. Each fire re-resolves the target and persists alongside
            ad-hoc runs.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link href="/">Open Lighthouse</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <ul className="flex list-none flex-col gap-5 p-0">
        {schedules.map((schedule) => (
          <li key={schedule.id}>
            <ScheduleCard
              schedule={schedule}
              batches={batchesBySchedule.get(schedule.id) ?? []}
            />
          </li>
        ))}
      </ul>
    </TooltipProvider>
  );
}

interface ScheduleCardProps {
  schedule: Schedule;
  batches: BatchInfo[];
}

function ScheduleCard({ schedule, batches }: ScheduleCardProps) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<
    "delete" | "run" | "pause" | null
  >(null);
  const submitting = pendingAction !== null;
  const [editing, setEditing] = useState(false);
  // Closing the dialog hands focus back here — see `restoreFocusRef`.
  const editButtonRef = useRef<HTMLButtonElement>(null);

  // Cadence math runs client-side: SSR can't render a stable "in 4h 12m"
  // against `Date.now()` without churning hydration. `useMinuteTick` is the
  // shared once-a-minute store — `null` during SSR and the first frame (so the
  // render is hydration-safe), real wall clock from mount on. The Edit dialog
  // subscribes to the same store, so its preview matches this card exactly.
  const nowTick = useMinuteTick();

  const nextFire = useMemo(
    () =>
      schedule.enabled && nowTick ? nextFireAt(schedule.time, nowTick) : null,
    [schedule.enabled, schedule.time, nowTick],
  );

  const target = useMemo(() => describeTarget(schedule.target), [schedule.target]);
  // A schedule with no name is titled by its target instead, so the line under
  // the title carries only what the title does not: the target when a real name
  // owns the title, and the count when there is more than one URL. For an
  // unnamed single-URL schedule that leaves nothing, and the line is dropped
  // rather than restating the title in different words.
  const named = schedule.name.trim().length > 0;
  const subtitle = [named ? target.label : "", target.detail]
    .filter((part) => part.length > 0)
    .join(" · ");

  const totalRuns = batches.length;
  const lastBatch = batches[0] ?? null;

  // Which batch the single Run now / Pause button is watching. The server list
  // is the source of truth once it has refreshed; `firedBatchId` bridges the
  // gap between a successful Run now and that refresh. A persisted row can be
  // left at "running" by a server that died mid-run, so the button trusts the
  // live stream, not the row: the stream's first snapshot of such a batch is
  // already terminal, which reads as "not running".
  const [firedBatchId, setFiredBatchId] = useState<string | null>(null);
  const listedActive =
    batches.find((b) => b.status === "running" || b.status === "queued") ??
    null;
  const fired =
    firedBatchId !== null && !batches.some((b) => b.id === firedBatchId)
      ? firedBatchId
      : null;
  const watchedBatchId = listedActive?.id ?? fired;
  const { isComplete } = useBatchStream(watchedBatchId);
  const isRunning = watchedBatchId !== null && !isComplete;

  // The watched run reached a terminal state (finished, or paused from
  // elsewhere): re-read the server list so run history and the button agree.
  useEffect(() => {
    if (watchedBatchId !== null && isComplete) router.refresh();
  }, [watchedBatchId, isComplete, router]);

  async function callApi(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    return response;
  }

  const handlePause = useCallback(async () => {
    setPendingAction("pause");
    try {
      const response = await callApi(
        `/api/schedules/${encodeURIComponent(schedule.id)}/pause`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => null)) as
        | { cancelledBatchIds?: string[]; error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(
          body?.error?.message ?? `Request failed (${response.status}).`,
        );
      }
      toast.success(
        (body?.cancelledBatchIds?.length ?? 0) > 0
          ? "Paused — Run now picks up where it left off."
          : "Nothing was running.",
      );
      setFiredBatchId(null);
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not pause the run.",
      );
    } finally {
      setPendingAction(null);
    }
  }, [schedule.id, router]);

  const handleDelete = useCallback(async () => {
    // Confirm with the user before destroying a persisted schedule. The native
    // dialog is enough here — a custom one would be over-engineering.
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete schedule “${schedule.name || target.label}”? Past runs stay in the archive; only the recurring entry is removed.`,
      )
    ) {
      return;
    }
    setPendingAction("delete");
    try {
      const response = await callApi(
        `/api/schedules/${encodeURIComponent(schedule.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(`Request failed (${response.status}).`);
      }
      toast.success("Schedule deleted.");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not delete the schedule.",
      );
      setPendingAction(null);
    }
  }, [schedule.id, schedule.name, target.label, router]);

  const handleRunNow = useCallback(async () => {
    setPendingAction("run");
    try {
      const response = await callApi(
        `/api/schedules/${encodeURIComponent(schedule.id)}/run`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => null)) as
        | {
            batchId?: string;
            urlCount?: number;
            resumedFrom?: string | null;
            skipped?: number;
            error?: { message?: string };
          }
        | null;
      if (!response.ok || !body?.batchId) {
        throw new Error(
          body?.error?.message ?? `Request failed (${response.status}).`,
        );
      }
      const { batchId, urlCount = 0, skipped = 0 } = body;
      setFiredBatchId(batchId);
      toast.success(
        body.resumedFrom
          ? `Resumed where the paused run left off — ${urlCount} ${urlCount === 1 ? "URL" : "URLs"} to go, ${skipped} already audited.`
          : "Fired schedule — streaming…",
        {
          action: {
            label: "View",
            onClick: () => {
              router.push(`/?watch=${encodeURIComponent(batchId)}`);
            },
          },
        },
      );
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not fire the schedule.",
      );
    } finally {
      setPendingAction(null);
    }
  }, [schedule.id, router]);

  return (
    <Card>
      <CardHeader className="gap-3 border-b border-border/60 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-heading text-base font-medium leading-snug text-foreground">
                {named ? schedule.name : target.label}
              </h3>
              <Badge
                variant="outline"
                className="gap-1 border-border/60 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground"
              >
                {target.kind === "Crawl" ? (
                  <Globe aria-hidden className="size-2.5" />
                ) : null}
                {target.kind}
              </Badge>
            </div>
            {subtitle ? (
              <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">
                {subtitle}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={isRunning ? handlePause : handleRunNow}
                  disabled={submitting}
                  aria-label={isRunning ? "Pause the run" : "Run schedule now"}
                  className="font-mono text-[0.7rem] uppercase tracking-[0.14em]"
                >
                  {pendingAction === "run" || pendingAction === "pause" ? (
                    <Spinner data-icon="inline-start" />
                  ) : isRunning ? (
                    <PauseCircle data-icon="inline-start" />
                  ) : (
                    <RotateCw data-icon="inline-start" />
                  )}
                  {isRunning ? "Pause" : "Run now"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isRunning
                  ? "Stop the run in progress — Run now picks up where it left off"
                  : "Fire this schedule now — a paused run picks up where it left off"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={editButtonRef}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setEditing(true)}
                  disabled={submitting}
                  aria-label="Edit schedule"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Edit name, fire time, or whether it is armed
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleDelete}
                  disabled={submitting}
                  aria-label="Delete schedule"
                  className="text-muted-foreground hover:text-score-poor"
                >
                  {pendingAction === "delete" ? (
                    <Spinner />
                  ) : (
                    <Trash2 />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete schedule</TooltipContent>
            </Tooltip>
          </div>

          {/* Portalled by Radix, so it sits here only for co-location with the
              button that opens it. Saving re-reads the server page, which is
              what re-renders this card's cadence cells with the new time. */}
          <EditScheduleDialog
            open={editing}
            restoreFocusRef={editButtonRef}
            onOpenChange={setEditing}
            schedule={schedule}
            onSaved={() => router.refresh()}
          />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {/* Cadence telemetry strip — four dense cells, like the batch summary. */}
        <section
          aria-label="Cadence telemetry"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <TelemetryCell label="Cadence" value={`Daily @ ${schedule.time}`}>
            <Clock aria-hidden className="size-3" />
          </TelemetryCell>
          <TelemetryCell
            label="Next run"
            value={
              !schedule.enabled
                ? "—"
                : nextFire
                  ? formatTimestamp(nextFire.toISOString())
                  : "…"
            }
            sub={
              !schedule.enabled
                ? "paused"
                : nextFire && nowTick
                  ? formatCountdown(nextFire, nowTick)
                  : undefined
            }
          >
            <CalendarClock aria-hidden className="size-3" />
          </TelemetryCell>
          <TelemetryCell
            label="Last run"
            value={formatTimestamp(schedule.lastFiredAt)}
            sub={
              schedule.lastBatchId
                ? `batch ${schedule.lastBatchId.slice(0, 8)}`
                : undefined
            }
          >
            <CheckCircle2 aria-hidden className="size-3" />
          </TelemetryCell>
          <TelemetryCell
            label="Total runs"
            value={`${totalRuns}`}
            sub={
              lastBatch?.status === "completed_with_errors"
                ? "last had errors"
                : undefined
            }
            tone={
              lastBatch?.status === "completed_with_errors" ? "warn" : "default"
            }
          >
            <RotateCw aria-hidden className="size-3" />
          </TelemetryCell>
        </section>

        {/* Day-over-day run history strip — a simple list of dated batches with
            their lifecycle status; richer score trends live in /batches. */}
        <RunHistoryStrip
          batches={batches}
          activeBatchId={isRunning ? watchedBatchId : null}
        />
      </CardContent>
    </Card>
  );
}

interface TelemetryCellProps {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "warn";
  children?: React.ReactNode;
}

function TelemetryCell({
  label,
  value,
  sub,
  tone = "default",
  children,
}: TelemetryCellProps) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-card/30 p-3">
      <span className={cn(SECTION_LABEL, "inline-flex items-center gap-1.5")}>
        {children}
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "warn" ? "text-score-average" : "text-foreground",
        )}
      >
        {value}
      </span>
      {sub ? (
        <span className="font-mono text-[0.65rem] text-muted-foreground tabular-nums">
          {sub}
        </span>
      ) : null}
    </div>
  );
}

interface RunHistoryStripProps {
  batches: BatchInfo[];
  /** The batch the card's Pause button is watching, if a run is in flight. */
  activeBatchId: string | null;
}

/** Compact day-over-day list of a schedule's persisted batches (newest first). */
function RunHistoryStrip({ batches, activeBatchId }: RunHistoryStripProps) {
  if (batches.length === 0) {
    return (
      <section
        aria-label="Run history"
        className="rounded-md border border-dashed border-border/60 bg-card/20 p-3 text-center"
      >
        <p className="font-mono text-xs text-muted-foreground">
          No runs yet — fires once the daily window passes (or use “Run now”).
        </p>
      </section>
    );
  }

  // Cap the strip to the last 8 batches to keep the card scannable; the full
  // archive lives at /batches.
  const visible = batches.slice(0, 8);
  const overflow = batches.length - visible.length;

  return (
    <section
      aria-label="Run history"
      className="flex flex-col gap-2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={SECTION_LABEL}>Run history</span>
        {overflow > 0 ? (
          <span className="font-mono text-[0.65rem] text-muted-foreground tabular-nums">
            {visible.length} of {batches.length} shown
          </span>
        ) : null}
      </div>
      <ul className="flex list-none flex-col gap-1.5 p-0">
        {visible.map((batch) => (
          <li key={batch.id}>
            <RunHistoryRow
              batch={batch}
              inFlight={batch.id === activeBatchId}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface RunHistoryRowProps {
  batch: BatchInfo;
  /** True for the run currently in flight — it can be paused, not deleted. */
  inFlight: boolean;
}

/**
 * One persisted batch: the row body links to the live batch view, and a
 * delete control sits at its right edge. The two are siblings (a button can't
 * nest inside a link), sharing one bordered wrapper that highlights as a unit.
 */
function RunHistoryRow({ batch, inFlight }: RunHistoryRowProps) {
  const isError = batch.status === "completed_with_errors";
  const isRunning = batch.status === "running";
  const isQueued = batch.status === "queued";
  const isPaused = batch.status === "cancelled";

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md border border-border/60 bg-card/30 py-1 pr-1 pl-3",
        "transition-colors hover:border-primary/40 hover:bg-card/60",
      )}
    >
    <Link
      href={`/?watch=${encodeURIComponent(batch.id)}`}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3 rounded-sm py-1",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      aria-label={`Open batch ${batch.id} from ${batch.createdAt}`}
    >
      <span className="font-mono text-xs text-foreground tabular-nums">
        {formatTimestamp(batch.createdAt)}
      </span>
      <span className="font-mono text-[0.65rem] text-muted-foreground tabular-nums">
        {batch.id.slice(0, 8)}
      </span>
      <span className="ml-auto inline-flex items-center gap-2">
        {/* Status pill — uses the same band tokens so colour stays in-system. */}
        {isError ? (
          <span className="inline-flex items-center gap-1 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-score-average">
            <TriangleAlert aria-hidden className="size-3" />
            errors
          </span>
        ) : isRunning ? (
          <span className="inline-flex items-center gap-1 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-primary">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            running
          </span>
        ) : isQueued ? (
          <span className="inline-flex items-center gap-1 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            <Clock aria-hidden className="size-3" />
            queued
          </span>
        ) : isPaused ? (
          <span className="inline-flex items-center gap-1 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            <PauseCircle aria-hidden className="size-3" />
            paused
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-score-good">
            <CheckCircle2 aria-hidden className="size-3" />
            done
          </span>
        )}
        <span className="font-mono text-[0.65rem] text-muted-foreground tabular-nums">
          {batch.total} {batch.total === 1 ? "page" : "pages"}
        </span>
        <ExternalLink
          aria-hidden
          className="size-3 text-muted-foreground/70 transition-colors group-hover:text-primary"
        />
      </span>
    </Link>
      <DeleteBatchButton batch={batch} disabled={inFlight} />
    </div>
  );
}

/**
 * Per-batch delete for the run history strip: a destructive icon button behind
 * a confirm dialog (the same guard the History page puts on a run). On confirm
 * it removes the batch — its page results, stored reports and analyses — and
 * refreshes the server component so the row disappears. Disabled for the run
 * in flight: pause it first, then delete.
 */
function DeleteBatchButton({
  batch,
  disabled,
}: {
  batch: BatchInfo;
  disabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const when = formatTimestamp(batch.createdAt);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteBatch(batch.id);
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
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={`Delete run from ${when}`}
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {disabled ? "Pause the run before deleting it" : "Delete this run"}
        </TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this run?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the run from{" "}
            <span className="font-mono text-foreground">{when}</span> — all{" "}
            {batch.total} of its page {batch.total === 1 ? "result" : "results"}{" "}
            and their stored reports. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={(event) => {
              // Keep the dialog mounted through the async call; it closes once
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
 * Day-over-day score pill row — reserved for a future expand where each
 * row drills into the batch's average scores. Today the strip is intentionally
 * compact: opening the batch in /?watch=... is one click away.
 * (Exported so the unused-import linter recognises the touchpoint as live.)
 */
export function ScheduleTrendPills({
  scores,
}: {
  scores: Array<{ label: string; score: number | null }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {LIGHTHOUSE_CATEGORIES.map((category, idx) => {
        const point = scores[idx];
        return (
          <ScorePill
            key={category}
            label={CATEGORY_SHORT_LABELS[category]}
            score={point?.score ?? null}
            title={point?.label}
          />
        );
      })}
    </div>
  );
}
