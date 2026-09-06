"use client";

/**
 * Alert strip (ROADMAP Phase C) — the in-app half of regression alerts.
 *
 * Phase 14 built a scheduler that notified nobody. Phase C closes that loop, and
 * the loop has to close *without a webhook*: a user who never sets
 * `LH_ALERT_WEBHOOK_URL` should still be able to open the Archive and see that
 * Performance crossed below 90 on three pages last night. So the webhook is the
 * optional half and this strip is the guaranteed one — every row says which it
 * was, and a row that reads `in-app` is not a failure, it is the default.
 *
 * ## Instrumentation, not a notification centre
 *
 * There is no unread count, no dismiss, no bell. The strip sits inside the
 * schedule's card as another dense readout beside its cadence cells: mono
 * figures, a band-coloured before/after pair, the bar that was crossed, and how
 * long ago. You read it the way you read the run-history strip above it.
 *
 * ## Colour carries meaning, and no colour is new
 *
 * Every hue here is an existing score-band token. Two independent questions are
 * answered at once and they must not be confused:
 *
 *   - *What happened* — the rail, icon and kind chip take {@link alertBand}:
 *     poor for a bar crossed downwards, average for a slide that crossed
 *     nothing, good for a recovery.
 *   - *Where the scores landed* — each number wears its own band via
 *     `scoreChipClass`, so a 92 → 71 crossing shows green → red inside a red
 *     row, which is the whole story in one line.
 *
 * `dropped_by` is additionally distinguished without colour: it prints no bar,
 * because there was none to cross. A crossing always names the bar it crossed.
 *
 * ## Honesty about an empty strip
 *
 * An empty strip is ambiguous — armed and quiet, disarmed, or too new to have a
 * pair to compare — so it never renders a bare "no alerts". A schedule that has
 * never run at all renders nothing, because "watching" would be a claim it
 * cannot back: the comparison needs two fires.
 */

import { useMemo } from "react";
import {
  BellOff,
  CircleDashed,
  MoveDownRight,
  Radar,
  Send,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { ScorePill } from "@/components/audit/score-pill";
import {
  alertBand,
  formatAlertAge,
} from "@/components/archive/alerts-data";
import {
  alertKindLabel,
  alertSummary,
  formatDelta,
} from "@/lib/alerts/format";
import type {
  AlertKind,
  ScheduleAlertRecord,
  ScheduleNotify,
} from "@/lib/alerts/types";
import {
  CATEGORY_LABELS,
  CATEGORY_SHORT_LABELS,
  scoreBandChipClass,
  scoreBandSolidClass,
  scoreTextClass,
} from "@/lib/scores";
import { cn } from "@/lib/utils";

/** Mono uppercase tracked section label — the house "telemetry" label style. */
const SECTION_LABEL =
  "font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground";

/** How many events a card shows before it starts counting the rest. */
const DEFAULT_LIMIT = 6;

/**
 * Direction glyph per kind. `dropped_by` deliberately uses a *diagonal* move
 * rather than the trend arrow the crossings share — a slide, not a crossing.
 */
const KIND_ICONS: Record<AlertKind, typeof TrendingDown> = {
  crossed_below: TrendingDown,
  recovered_above: TrendingUp,
  dropped_by: MoveDownRight,
};

export interface AlertStripProps {
  /** This schedule's alert rows, newest first (the DB reader's own order). */
  alerts: ScheduleAlertRecord[];
  /**
   * The schedule's **saved** notify config. Decides which empty state is
   * honest, and whether historic rows need a "no longer watching" caveat. Never
   * the browser's live Settings bars — see the `ScheduleNotify` docblock.
   */
  notify: ScheduleNotify;
  /**
   * How many batches the schedule has produced. Two fires are the minimum for a
   * comparison to exist, so this is what separates "watching, nothing crossed"
   * from "there is nothing to compare yet".
   */
  runCount: number;
  /**
   * Shared wall clock from `useMinuteTick` — `null` during SSR and the first
   * frame, which is what keeps the relative ages hydration-safe.
   */
  now: Date | null;
  /** Rows to render before the header starts counting the remainder. */
  limit?: number;
}

export function AlertStrip({
  alerts,
  notify,
  runCount,
  now,
  limit = DEFAULT_LIMIT,
}: AlertStripProps) {
  const visible = useMemo(() => alerts.slice(0, limit), [alerts, limit]);

  // A schedule that has never fired has nothing to say about alerts in either
  // direction: no history, and no basis for claiming to watch anything.
  if (alerts.length === 0 && runCount === 0) return null;

  if (alerts.length === 0) {
    return (
      <AlertStripShell>
        <EmptyNote
          icon={notify.enabled ? Radar : BellOff}
          tone={notify.enabled ? "watching" : "off"}
        >
          {!notify.enabled
            ? "Alerts disarmed — nothing is being compared between fires. Arm them in Edit schedule."
            : runCount < 2
              ? "Armed — the first run is the baseline, so the next fire is the earliest anything can be reported."
              : "Watching — nothing crossed a bar or slid past the minimum since the last fire."}
        </EmptyNote>
      </AlertStripShell>
    );
  }

  const overflow = alerts.length - visible.length;

  return (
    <AlertStripShell
      note={
        overflow > 0
          ? `${visible.length} of ${alerts.length} shown`
          : undefined
      }
      caveat={
        // Rows outlive the switch that produced them. Without this, a disarmed
        // schedule's history reads as live monitoring.
        !notify.enabled ? "disarmed — history only" : undefined
      }
    >
      {/* The row is dense by design; below roughly 38rem it scrolls inside this
          box rather than pushing the card (and the page) sideways. Focusable so
          a keyboard user can reach the scroll — the region holds no other
          tab stop. */}
      <div
        tabIndex={0}
        role="group"
        aria-label="Alert events"
        className={cn(
          "overflow-x-auto rounded-md",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <ul className="flex min-w-[38rem] list-none flex-col gap-1.5 p-0">
          {visible.map((alert) => (
            <li key={alert.id}>
              <AlertRow alert={alert} now={now} />
            </li>
          ))}
        </ul>
      </div>
    </AlertStripShell>
  );
}

/** Section shell + header, shared by the populated strip and its empty states. */
function AlertStripShell({
  note,
  caveat,
  children,
}: {
  note?: string;
  caveat?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label="Regression alerts" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={SECTION_LABEL}>Alerts</span>
        <span className="flex items-baseline gap-2 font-mono text-[0.65rem] text-muted-foreground tabular-nums">
          {caveat ? <span>{caveat}</span> : null}
          {note ? <span>{note}</span> : null}
        </span>
      </div>
      {children}
    </section>
  );
}

/** Dashed placeholder matching the run-history strip's own empty state. */
function EmptyNote({
  icon: Icon,
  tone,
  children,
}: {
  icon: typeof Radar;
  tone: "watching" | "off";
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-dashed border-border/60 bg-card/20 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
      <Icon
        aria-hidden
        className={cn(
          "mt-px size-3.5 shrink-0",
          tone === "watching" ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span>{children}</span>
    </p>
  );
}

/**
 * One alert event. Reads left to right as: what happened · what the scores did ·
 * where · when. The whole row carries `alertSummary` as its native tooltip, so
 * the same sentence the webhook posts is one hover away.
 */
function AlertRow({
  alert,
  now,
}: {
  alert: ScheduleAlertRecord;
  now: Date | null;
}) {
  const band = alertBand(alert.kind);
  const Icon = KIND_ICONS[alert.kind];
  // Scheme stripped, exactly as `describeTarget` renders a schedule's target.
  const host = alert.url.replace(/^https?:\/\//, "");

  return (
    <div
      title={alertSummary(alert)}
      className="flex items-center gap-2.5 rounded-md border border-border/60 bg-card/30 py-1.5 pr-3 pl-2"
    >
      {/* Band rail — the row's loudest signal, and the only full-strength fill. */}
      <span
        aria-hidden
        className={cn(
          "h-6 w-0.5 shrink-0 rounded-full",
          scoreBandSolidClass(band),
        )}
      />
      <Icon aria-hidden className={cn("size-3 shrink-0", scoreTextClass(band))} />
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.12em]",
          scoreBandChipClass(band),
        )}
      >
        {alertKindLabel(alert.kind)}
      </span>

      {/* The pair. Each pill takes its own band, so the movement is visible in
          colour as well as in the numbers; the previous one is dimmed because
          it is the past. */}
      <span className="inline-flex shrink-0 items-center gap-1">
        <ScorePill score={alert.previous} className="opacity-60" />
        <span aria-hidden className="text-muted-foreground">
          →
        </span>
        <ScorePill score={alert.current} />
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[0.65rem] tabular-nums",
          scoreTextClass(band),
        )}
      >
        {formatDelta(alert.delta)}
      </span>

      {/* A crossing names the bar it crossed; a `dropped_by` slide prints none,
          because there was none. */}
      {alert.threshold !== null ? (
        <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground tabular-nums">
          bar {alert.threshold}
        </span>
      ) : null}

      <span
        title={CATEGORY_LABELS[alert.category]}
        className="shrink-0 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-foreground"
      >
        {CATEGORY_SHORT_LABELS[alert.category]}
      </span>
      <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">
        {alert.formFactor}
      </span>

      <span
        title={alert.url}
        className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
      >
        {host}
      </span>

      <DeliveryTag delivered={alert.delivered} />
      <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground tabular-nums">
        {formatAlertAge(alert.createdAt, now)}
      </span>
    </div>
  );
}

/**
 * Whether the webhook took this row. Both states are neutral on purpose:
 * `in-app` is what every alert reads with no webhook configured, and colouring
 * it as a failure would misrepresent the app's default configuration.
 */
function DeliveryTag({ delivered }: { delivered: boolean }) {
  return delivered ? (
    <span
      title="Posted to the configured webhook"
      className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground"
    >
      <Send aria-hidden className="size-2.5" />
      sent
    </span>
  ) : (
    <span
      title="Recorded here only — no webhook took this alert"
      className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground/70"
    >
      <CircleDashed aria-hidden className="size-2.5" />
      in-app
    </span>
  );
}
