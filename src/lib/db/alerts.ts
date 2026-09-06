/**
 * Regression-alert persistence (ROADMAP Phase C).
 *
 * Third sibling of `src/lib/db/persistence.ts` and `src/lib/db/schedules.ts`,
 * with the same never-throwing discipline: reads degrade to `[]`/`undefined`,
 * writes log and swallow. An alert is a *record of something that already
 * happened*; failing a batch (or stopping the scheduler's tick loop) because
 * SQLite hiccuped while writing one would trade a real result for a note about
 * it.
 *
 * Two jobs live here, and they are deliberately in one module because they are
 * the two halves of one question — "what changed since this schedule last ran?":
 *
 *  1. **The comparison's input.** {@link readBatchRunScores} projects a batch's
 *     finished runs down to the `(url, formFactor, scores)` triples
 *     `compareBatches` pairs on, and {@link previousCompletedBatchId} finds the
 *     fire to compare against. Both read `runs`/`batches` directly via
 *     `getDb()` — `schedules.ts` already does its own selects rather than
 *     routing through `persistence.ts`, and the alternative here would be
 *     loading whole `HistoryRow`s (options, metrics, environment, report flags)
 *     to read five integers.
 *  2. **The comparison's output.** {@link recordAlerts} writes one row per
 *     alert and {@link listScheduleAlerts} / {@link listRecentAlerts} read them
 *     back for the Archive strip. Persisting rather than recomputing is what
 *     makes the feature useful with no webhook configured at all, and what
 *     leaves a record of what *would* have been sent when delivery fails.
 *
 * ## Free-text columns are validated on the way out
 *
 * `schedule_alerts.kind` and `.category` are plain TEXT (the same choice
 * `analyses.category` makes, so a sixth Lighthouse category needs no
 * migration). That means a row can hold a value this build has never heard of —
 * hand-edited, or written by a newer version the user rolled back from. Reads
 * therefore whitelist both columns and **drop** an unparseable row rather than
 * throwing, exactly as `rowToSchedule` drops a schedule whose JSON columns no
 * longer parse: one bad row must not blank the Archive.
 *
 * ## Nothing credential-shaped is stored
 *
 * The alert rows carry URLs, devices, categories and integers. The webhook URL
 * that delivered them is read from `process.env.LH_ALERT_WEBHOOK_URL` at
 * delivery time and never reaches SQLite — see `.claude/rules/security.md` and
 * the docblock on `src/lib/alerts/types.ts`.
 */

import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import type { AlertRunScore } from "@/lib/alerts/compare";
import type {
  AlertKind,
  ScheduleAlert,
  ScheduleAlertRecord,
} from "@/lib/alerts/types";
import { getDb } from "@/lib/db/client";
import {
  batches,
  runs,
  scheduleAlerts,
  type NewScheduleAlertRow,
  type ScheduleAlertRow,
} from "@/lib/db/schema";
import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";

/** Log + swallow a persistence failure (never propagate to the caller). */
function warn(op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[alerts] ${op} failed: ${message}`);
}

/**
 * Batch statuses whose run set is final and complete enough to compare.
 *
 * `cancelled` is excluded on purpose: a paused batch holds results for whatever
 * subset of its URLs happened to finish first, so comparing against it would
 * report every unaudited page as a change. `queued`/`running` are excluded for
 * the same reason — they are simply not done yet.
 */
const COMPARABLE_BATCH_STATUSES = ["completed", "completed_with_errors"] as const;

/** The three {@link AlertKind} values, as a runtime whitelist for row reads. */
const ALERT_KINDS: readonly AlertKind[] = [
  "crossed_below",
  "recovered_above",
  "dropped_by",
];

/** Default number of alerts a listing returns per schedule. */
const DEFAULT_ALERT_LIMIT = 20;

function isAlertKind(value: string): value is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(value);
}

function isLighthouseCategory(value: string): value is LighthouseCategory {
  return (LIGHTHOUSE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The `(url, formFactor, scores)` triples of a batch's successful runs — the
 * comparison's input for one fire.
 *
 * Only `status = 'done'` rows are included: a failed run has null scores, and a
 * page that errored today has not "dropped to 0", it simply has no number. The
 * five score columns map to {@link CategoryScores} exactly as `rowToHistory`
 * does in `persistence.ts` — **null is never coalesced to 0**, because an
 * unscored category and a zero are different facts and the comparison core
 * treats them as such (a pair needs two real numbers).
 *
 * Ordered by the run's position in its batch so a caller iterating the result
 * sees the batch's own order. Returns `[]` on any error.
 */
export function readBatchRunScores(batchId: string): AlertRunScore[] {
  try {
    const rows = getDb()
      .select({
        url: runs.url,
        formFactor: runs.formFactor,
        performance: runs.scorePerformance,
        accessibility: runs.scoreAccessibility,
        bestPractices: runs.scoreBestPractices,
        seo: runs.scoreSeo,
        agenticBrowsing: runs.scoreAgenticBrowsing,
      })
      .from(runs)
      .where(and(eq(runs.batchId, batchId), eq(runs.status, "done")))
      .orderBy(asc(runs.idx))
      .all();
    return rows.map((row) => {
      const scores: CategoryScores = {
        performance: row.performance,
        accessibility: row.accessibility,
        "best-practices": row.bestPractices,
        seo: row.seo,
        // Null on rows written before the 0007 migration and on runs that
        // didn't select the category — an unscored category, never a 0.
        "agentic-browsing": row.agenticBrowsing,
      };
      return {
        url: row.url,
        formFactor: row.formFactor === "desktop" ? "desktop" : "mobile",
        scores,
      };
    });
  } catch (err) {
    warn("readBatchRunScores", err);
    return [];
  }
}

/**
 * The schedule's most recent *completed* batch strictly before `beforeBatchId`,
 * or `undefined` when the schedule has no earlier fire to compare against.
 *
 * "Completed" is {@link COMPARABLE_BATCH_STATUSES} — a batch that finished with
 * some failed URLs still has a comparable run set, a cancelled (paused) one does
 * not. "Strictly before" is by `created_at`, which is the order the schedule
 * actually fired in; the reference batch itself is excluded by the same
 * comparison, since nothing was created before itself.
 *
 * Returns `undefined` on a first fire, an unknown batch id, or any error.
 */
export function previousCompletedBatchId(
  scheduleId: string,
  beforeBatchId: string,
): string | undefined {
  try {
    const db = getDb();
    const reference = db
      .select({ createdAt: batches.createdAt })
      .from(batches)
      // Scoped to this schedule as well as this id: both callers already pass
      // the schedule's own batch, but without the predicate a caller passing a
      // foreign batch would silently anchor the timeline to someone else's fire.
      .where(and(eq(batches.id, beforeBatchId), eq(batches.scheduleId, scheduleId)))
      .get();
    // An unknown batch has no position in the schedule's timeline, so there is
    // no "before" to resolve — never fall back to "the newest other batch".
    if (!reference) return undefined;

    const row = db
      .select({ id: batches.id })
      .from(batches)
      .where(
        and(
          eq(batches.scheduleId, scheduleId),
          lt(batches.createdAt, reference.createdAt),
          inArray(batches.status, [...COMPARABLE_BATCH_STATUSES]),
        ),
      )
      .orderBy(desc(batches.createdAt))
      .get();
    return row?.id;
  } catch (err) {
    warn("previousCompletedBatchId", err);
    return undefined;
  }
}

/** Reconstruct a {@link ScheduleAlertRecord}, or `null` for an unreadable row. */
function rowToAlert(row: ScheduleAlertRow): ScheduleAlertRecord | null {
  // Free-text columns (see the module docblock): whitelist, then drop the row
  // rather than surfacing a category or kind the renderer can't name.
  if (!isAlertKind(row.kind)) return null;
  if (!isLighthouseCategory(row.category)) return null;
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    batchId: row.batchId,
    priorBatchId: row.priorBatchId,
    kind: row.kind,
    url: row.url,
    formFactor: row.formFactor === "desktop" ? "desktop" : "mobile",
    category: row.category,
    previous: row.previous,
    current: row.current,
    delta: row.delta,
    threshold: row.threshold,
    delivered: row.delivered,
    createdAt: row.createdAt,
  };
}

/** Map rows to records, dropping any that no longer parse. */
function rowsToAlerts(rows: readonly ScheduleAlertRow[]): ScheduleAlertRecord[] {
  const out: ScheduleAlertRecord[] = [];
  for (const row of rows) {
    const record = rowToAlert(row);
    if (record) out.push(record);
  }
  return out;
}

/**
 * Persist one comparison's alerts — one row each — and return the records as
 * stored.
 *
 * Every row of a single comparison shares one `createdAt`: they describe the
 * same event, and a shared timestamp is what lets a listing group them without
 * a separate "alert batch" table. `delivered` records whether the webhook
 * accepted this set; a false there is not an error state, it is the ordinary
 * case when no webhook is configured at all.
 *
 * Never throws — returns `[]` if the insert fails, so a delivery that already
 * happened isn't retried by a caller reading the return value as "nothing sent".
 */
export function recordAlerts(
  scheduleId: string,
  batchId: string,
  priorBatchId: string,
  alerts: readonly ScheduleAlert[],
  delivered: boolean,
): ScheduleAlertRecord[] {
  if (alerts.length === 0) return [];
  try {
    const createdAt = new Date().toISOString();
    const rows: NewScheduleAlertRow[] = alerts.map((alert) => ({
      id: nanoid(),
      scheduleId,
      batchId,
      priorBatchId,
      kind: alert.kind,
      url: alert.url,
      formFactor: alert.formFactor,
      category: alert.category,
      previous: alert.previous,
      current: alert.current,
      delta: alert.delta,
      threshold: alert.threshold,
      delivered,
      createdAt,
    }));
    getDb().insert(scheduleAlerts).values(rows).run();
    return rows.map((row) => ({
      id: row.id,
      scheduleId,
      batchId,
      priorBatchId,
      kind: row.kind as AlertKind,
      url: row.url,
      formFactor: row.formFactor === "desktop" ? "desktop" : "mobile",
      category: row.category as LighthouseCategory,
      previous: row.previous,
      current: row.current,
      delta: row.delta,
      threshold: row.threshold ?? null,
      delivered,
      createdAt,
    }));
  } catch (err) {
    warn("recordAlerts", err);
    return [];
  }
}

/**
 * The most recent alerts for one schedule, newest first. Returns `[]` on error
 * or when the schedule has never alerted.
 */
export function listScheduleAlerts(
  scheduleId: string,
  limit: number = DEFAULT_ALERT_LIMIT,
): ScheduleAlertRecord[] {
  if (limit <= 0) return [];
  try {
    const rows = getDb()
      .select()
      .from(scheduleAlerts)
      .where(eq(scheduleAlerts.scheduleId, scheduleId))
      .orderBy(desc(scheduleAlerts.createdAt))
      .limit(limit)
      .all();
    return rowsToAlerts(rows);
  } catch (err) {
    warn("listScheduleAlerts", err);
    return [];
  }
}

/**
 * The most recent alerts across every schedule, newest first — the Archive
 * page's single read.
 *
 * The limit is *per schedule* rather than global on purpose: the page shows a
 * strip under each schedule card, so a chatty schedule must not be able to push
 * a quiet one's only alert off the end of a global top-N.
 */
export function listRecentAlerts(
  limitPerSchedule: number = DEFAULT_ALERT_LIMIT,
): ScheduleAlertRecord[] {
  if (limitPerSchedule <= 0) return [];
  try {
    const scheduleIds = getDb()
      .selectDistinct({ scheduleId: scheduleAlerts.scheduleId })
      .from(scheduleAlerts)
      .all()
      .map((row) => row.scheduleId);
    const out: ScheduleAlertRecord[] = [];
    for (const scheduleId of scheduleIds) {
      out.push(...listScheduleAlerts(scheduleId, limitPerSchedule));
    }
    // Each per-schedule slice is already newest-first; the merge orders the
    // whole strip so the page can render it without sorting again.
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  } catch (err) {
    warn("listRecentAlerts", err);
    return [];
  }
}

/**
 * Remove a schedule's alert rows and return how many went. Called by
 * `deleteSchedule` **before** the schedule row itself: `foreign_keys = ON` and
 * `schedule_alerts.schedule_id` is `ON DELETE no action`, so a schedule that has
 * ever alerted is undeletable until its children are gone (the same order
 * `deleteRun` uses for `analyses`). Returns 0 on error.
 */
export function deleteScheduleAlerts(scheduleId: string): number {
  try {
    const result = getDb()
      .delete(scheduleAlerts)
      .where(eq(scheduleAlerts.scheduleId, scheduleId))
      .run();
    return result.changes;
  } catch (err) {
    warn("deleteScheduleAlerts", err);
    return 0;
  }
}
