/**
 * Shared contract for regression alerts on schedules (ROADMAP Phase C).
 *
 * Phase 14 built the whole daily scheduler and it notified nobody. This module
 * owns the vocabulary that closes that loop: what an alert *is*, what a schedule
 * has been told to alert on, and how an untrusted stored blob becomes a valid
 * config again.
 *
 * Keep this file free of runtime / Next / queue / DB imports — it is shared by
 * the pure comparison core, the webhook delivery layer, the SQLite readers, the
 * API schema and the client UI alike (the same discipline
 * `src/lib/schedules/types.ts` follows).
 *
 * ## Nothing credential-shaped lives here
 *
 * A Slack/Discord webhook URL *is* credential-shaped — anyone holding it can post
 * into the channel — so it is read from `process.env.LH_ALERT_WEBHOOK_URL` and
 * never appears in this contract, in `app_settings`, in the `schedules` row, or
 * in any payload the client receives. What a schedule persists is preference
 * only: whether to notify, which categories, which bars, and how big a drop has
 * to be. See `.claude/rules/security.md`.
 */

import {
  LIGHTHOUSE_CATEGORIES,
  type FormFactor,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import {
  sanitizeCategories,
  sanitizeThresholds,
  DEFAULT_THRESHOLDS,
  type CategoryThresholds,
} from "@/lib/settings/defaults";

/**
 * What kind of border a score crossed between two consecutive fires of the same
 * schedule.
 *
 * - `crossed_below`   — was at or above the category's pass bar, now below it.
 * - `recovered_above` — was below the bar, now at or above it. The half that
 *   makes this a monitoring product rather than a nagging one: Foo.software
 *   charges for exactly this pair.
 * - `dropped_by`      — still on the same side of the bar, but fell by at least
 *   the schedule's `minDelta` points. Catches a 98 → 91 slide that no bar
 *   crossing would ever report.
 */
export type AlertKind = "crossed_below" | "recovered_above" | "dropped_by";

/**
 * One thing that changed, for one URL, on one device, in one category.
 *
 * Deliberately flat and pure data: the comparison core emits these, SQLite
 * stores them one per row, the webhook body is rendered from them, and the
 * Archive strip renders the same rows back. Nothing here is a display string —
 * formatting belongs to the renderer, so the stored record never goes stale
 * against a copy change.
 */
export interface ScheduleAlert {
  kind: AlertKind;
  /** The audited URL, exactly as the run recorded it. */
  url: string;
  /** Device the pair was compared on — a mobile drop is not a desktop drop. */
  formFactor: FormFactor;
  category: LighthouseCategory;
  /** Score in the previous fire (0–100). Always a number: a pair needs two. */
  previous: number;
  /** Score in the newest fire (0–100). */
  current: number;
  /**
   * `current - previous`. Negative for a regression, positive for a recovery.
   * Stored rather than derived so a row is self-describing in the UI and in the
   * webhook body without recomputation.
   */
  delta: number;
  /**
   * The pass bar in play for `crossed_below` / `recovered_above`, or `null` for
   * `dropped_by` (which is a bar-independent slide).
   */
  threshold: number | null;
}

/**
 * A persisted alert: a {@link ScheduleAlert} plus the provenance needed to show
 * it in the Archive strip long after the fire.
 */
export interface ScheduleAlertRecord extends ScheduleAlert {
  /** Row id (nanoid). */
  id: string;
  /** The schedule whose fire produced it. */
  scheduleId: string;
  /** The newest batch — the one that was compared against its predecessor. */
  batchId: string;
  /** The batch it was compared against. */
  priorBatchId: string;
  /** Whether the webhook accepted this alert (`false` = in-app only). */
  delivered: boolean;
  /** ISO timestamp the comparison ran. */
  createdAt: string;
}

/**
 * Per-schedule notification preferences — the `notify_*` columns on the
 * `schedules` row.
 *
 * ### Why the bars live here rather than being read from Settings at fire time
 *
 * The per-category pass thresholds the plan points at are a *browser* setting:
 * `useAuditDefaults` keeps them in `localStorage` under
 * `SETTINGS_STORAGE_KEY`, because until now nothing but the batch-summary
 * view needed them. A scheduler firing at 03:00 on the server has no
 * `localStorage` to read, so "use the existing threshold settings" is resolved
 * by *seeding*: the Edit-schedule dialog copies the user's current Settings bars
 * into this config the moment they arm alerts, and from then on the schedule
 * owns them. That is also the better semantics — dragging a Settings dial to
 * eyeball one batch should not silently re-arm every alert you configured
 * months ago.
 */
export interface ScheduleNotify {
  /** Master switch. When false the comparison never even runs for this schedule. */
  enabled: boolean;
  /** Categories to watch. Never empty (an empty selection means "all"). */
  categories: LighthouseCategory[];
  /**
   * Minimum absolute point drop that emits a `dropped_by` alert (1–100). Higher
   * is quieter; Lighthouse's own run-to-run noise on Performance is a few points,
   * so the default sits just above it.
   */
  minDelta: number;
  /** Per-category pass bars, seeded from the user's Settings thresholds. */
  thresholds: CategoryThresholds;
}

/** Smallest `dropped_by` delta the UI and API accept. */
export const MIN_ALERT_DELTA = 1;
/** Largest `dropped_by` delta (a 100-point drop is the whole scale). */
export const MAX_ALERT_DELTA = 100;
/**
 * Default `dropped_by` bar. Lighthouse Performance varies by a couple of points
 * between identical runs on the same machine, so 5 is the smallest number that
 * reports movement instead of noise.
 */
export const DEFAULT_ALERT_DELTA = 5;

/**
 * Factory default: **off**. An existing schedule must never start posting to a
 * webhook because the app was upgraded — arming alerts is a decision the user
 * makes, so migration 0008 backfills every row to this.
 */
export const DEFAULT_SCHEDULE_NOTIFY: ScheduleNotify = {
  enabled: false,
  categories: [...LIGHTHOUSE_CATEGORIES],
  minDelta: DEFAULT_ALERT_DELTA,
  thresholds: { ...DEFAULT_THRESHOLDS },
};

/** Clamp a `dropped_by` delta into MIN..MAX; non-numbers → the default. */
export function clampAlertDelta(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ALERT_DELTA;
  }
  return Math.min(
    MAX_ALERT_DELTA,
    Math.max(MIN_ALERT_DELTA, Math.round(value)),
  );
}

/**
 * Turn an untrusted value (a parsed SQLite JSON column, an API body, a stale
 * blob written before a category existed) into a fully-valid
 * {@link ScheduleNotify}. Every field is clamped or whitelisted against the
 * engine's own bounds; anything malformed degrades to the factory default for
 * that field. Never throws.
 *
 * Reuses `sanitizeCategories` / `sanitizeThresholds` deliberately: those are the
 * functions that already know how to upgrade a four-category blob to five, so an
 * alert config written before Agentic Browsing existed gains the fifth bar at 90
 * instead of being discarded.
 */
export function sanitizeNotify(value: unknown): ScheduleNotify {
  const source =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    // Default off: only an explicit `true` arms a schedule.
    enabled: source.enabled === true,
    categories: sanitizeCategories(source.categories),
    minDelta: clampAlertDelta(source.minDelta),
    thresholds: sanitizeThresholds(source.thresholds),
  };
}

/** Re-exported so consumers need only this module for the alert vocabulary. */
export type { CategoryThresholds };
