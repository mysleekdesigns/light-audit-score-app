/**
 * Pure derivations behind the Archive's alert surfaces (ROADMAP Phase C).
 *
 * The strip and the card's status cell both read a schedule's saved
 * {@link ScheduleNotify} and its persisted {@link ScheduleAlertRecord} rows and
 * have to agree about what those mean. Keeping the derivations here — free of
 * React, DOM and network, exactly like `credential-draft.ts` next to the
 * Authentication disclosure — means they unit-test directly and the two
 * surfaces cannot drift.
 *
 * Nothing here formats an alert's *sentence*: `alertKindLabel` / `formatDelta` /
 * `alertSummary` live in `src/lib/alerts/format.ts` so the webhook body and the
 * in-app strip render the same words. This module only answers the questions
 * that are purely about presentation state: which band an alert kind wears,
 * how old a row is, and what a card should say about its config.
 */

import type { AlertKind, ScheduleAlertRecord, ScheduleNotify } from "@/lib/alerts/types";
import { LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";
import type { ScoreBand } from "@/lib/scores";
import type { CategoryThresholds } from "@/lib/settings/defaults";

/**
 * Group alert rows by the schedule that produced them, preserving the order
 * they arrived in (the DB reader hands them back newest-first, and the strip
 * shows newest-first).
 *
 * Mirrors the console's existing `batchesBySchedule` pass: one grouping for the
 * whole page, then each card slices its own slice.
 */
export function groupAlertsBySchedule(
  alerts: readonly ScheduleAlertRecord[],
): Map<string, ScheduleAlertRecord[]> {
  const map = new Map<string, ScheduleAlertRecord[]>();
  for (const alert of alerts) {
    const list = map.get(alert.scheduleId);
    if (list) list.push(alert);
    else map.set(alert.scheduleId, [alert]);
  }
  return map;
}

/**
 * The score band an alert *kind* wears — the strip's only colour decision, and
 * deliberately not the same question as "what band is the current score in".
 *
 * A row shows two things at once: what happened (this) and where the scores
 * landed (`scoreChipClass` on each number). Both are drawn from the existing
 * three band tokens, so the strip introduces no colour of its own:
 *
 * - `crossed_below`   → **poor**. A bar was crossed the wrong way; that is the
 *   loudest thing the archive can tell you.
 * - `dropped_by`      → **average**. A slide that never crossed anything. It
 *   deserves attention, not alarm — and wearing the poor token would make a
 *   98 → 91 drift look like a failure.
 * - `recovered_above` → **good**, always. Forced rather than derived from
 *   `current`, because a category whose bar is 50 can recover *above* it and
 *   still sit in the average band; a recovery that rendered amber would read as
 *   a warning.
 */
export function alertBand(kind: AlertKind): ScoreBand {
  switch (kind) {
    case "crossed_below":
      return "poor";
    case "dropped_by":
      return "average";
    case "recovered_above":
      return "good";
  }
}

/**
 * Compact "how long ago" for an alert row: `12m ago`, `5h ago`, `3d ago`.
 *
 * Locale- and timezone-free on purpose. `formatTimestamp` renders in the
 * viewer's locale and so may only be called client-side; this is called from
 * the same client component but off the shared `useMinuteTick` clock, which is
 * `null` during SSR and the first frame. That `null` returns `"…"`, which is
 * what keeps the strip hydration-safe.
 *
 * A timestamp in the future (a clock nudged backwards between the fire and the
 * render) reads as `just now` rather than a negative age.
 */
export function formatAlertAge(iso: string, now: Date | null): string {
  if (!now) return "…";
  const then = new Date(iso);
  const thenMs = then.getTime();
  if (Number.isNaN(thenMs)) return "—";
  const minutes = Math.floor((now.getTime() - thenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** What the card's Alerts telemetry cell says about a schedule's saved config. */
export interface AlertsStatus {
  /** Whether the saved config will notify at all. */
  armed: boolean;
  /** The cell's headline value. */
  value: string;
  /**
   * The cell's sub-line, or `undefined` when there is nothing truthful to add.
   * Only populated when armed — a disarmed schedule's category list and delta
   * are stored but inert, and printing them would imply they were doing
   * something.
   */
  detail?: string;
}

/**
 * Describe a schedule's *saved* alert config for the card readout.
 *
 * Reads only what was persisted, never the Settings bars: a card that claimed
 * to watch what the browser currently has configured would be lying about what
 * the 03:00 fire will actually do (see the `ScheduleNotify` docblock).
 */
/** Whether two threshold records agree on all five categories. */
function thresholdsEqual(a: CategoryThresholds, b: CategoryThresholds): boolean {
  return LIGHTHOUSE_CATEGORIES.every((category) => a[category] === b[category]);
}

/**
 * Deep value equality for a notify config — what the Edit dialog uses to decide
 * whether `notify` belongs in the PATCH body at all.
 *
 * The dialog sends only what changed (an untouched field would bump `updatedAt`
 * for nothing), and `notify` is the one nested object in that body, so a
 * reference comparison would mark every open-and-close as dirty. Categories are
 * compared in order because both sides are built in the canonical
 * `LIGHTHOUSE_CATEGORIES` order — the same order `sanitizeCategories` returns.
 */
export function notifyEquals(a: ScheduleNotify, b: ScheduleNotify): boolean {
  return (
    a.enabled === b.enabled &&
    a.minDelta === b.minDelta &&
    a.categories.length === b.categories.length &&
    a.categories.every((category, index) => category === b.categories[index]) &&
    thresholdsEqual(a.thresholds, b.thresholds)
  );
}

export function describeAlertsStatus(notify: ScheduleNotify): AlertsStatus {
  if (!notify.enabled) return { armed: false, value: "Disarmed" };
  const watched = notify.categories.length;
  const total = LIGHTHOUSE_CATEGORIES.length;
  return {
    armed: true,
    value: "Armed",
    detail: `${watched}/${total} categories · ≥${notify.minDelta}pt`,
  };
}
