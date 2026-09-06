/**
 * Schedule persistence layer (PRD §6 Phase 14).
 *
 * Sister module to `src/lib/db/persistence.ts` — same never-throwing discipline,
 * same `getDb()` accessor. Reads degrade to empty/undefined on error; writes
 * log + swallow. Reconstructing a {@link Schedule} from a row parses the JSON
 * columns (`urls`, `crawl_spec`, `options`) defensively; an unparseable row is
 * dropped from listings rather than crashing the Archive view.
 *
 * ## Schedules carry NO credentials (ROADMAP Phase B)
 *
 * `persistence.ts` *redacts* audit credentials — it keeps the header/cookie
 * names, so a stored run can say which credential it used. A schedule is
 * different in kind: it fires days later, with no batch in memory to re-attach
 * anything from, so a record naming a credential it cannot supply would be a lie
 * about what the next fire will actually do. Both write paths here therefore
 * {@link stripAuditCredentials} outright, and the {@link Schedule} they return
 * matches what a later read gives back.
 *
 * The supported route for a schedule that must authenticate is the environment
 * (`LH_AUDIT_BASIC_AUTH` / `LH_AUDIT_EXTRA_HEADERS` / `LH_AUDIT_COOKIES`, read
 * inside the forked worker via `credentialsFromEnv`): a long-lived credential
 * belongs in the gitignored `.env`, never in SQLite.
 */

import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { getDb } from "@/lib/db/client";
import { schedules, type ScheduleRow } from "@/lib/db/schema";
import { stripAuditCredentials } from "@/lib/lighthouse/credentials";
import type {
  AuditOptions,
  DeviceSelection,
} from "@/lib/lighthouse/types";
import {
  isValidTime,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleCadence,
  type ScheduleCrawlTarget,
  type ScheduleTarget,
  type UpdateScheduleInput,
} from "@/lib/schedules/types";

function warn(op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[schedules] ${op} failed: ${message}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeParse<T>(value: string | null, op: string): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    warn(op, err);
    return null;
  }
}

/** Reconstruct a `ScheduleTarget` from a row's two nullable JSON columns. */
function rowToTarget(row: ScheduleRow): ScheduleTarget | null {
  if (row.crawlSpec !== null) {
    const spec = safeParse<ScheduleCrawlTarget["spec"]>(
      row.crawlSpec,
      "rowToTarget:crawl",
    );
    if (!spec) return null;
    return { kind: "crawl", spec };
  }
  const urls = safeParse<string[]>(row.urls, "rowToTarget:urls");
  if (!urls || !Array.isArray(urls)) return null;
  return { kind: "urls", urls };
}

function rowToSchedule(row: ScheduleRow): Schedule | null {
  const target = rowToTarget(row);
  if (!target) return null;
  const options = safeParse<AuditOptions>(row.options, "rowToSchedule:options");
  if (!options) return null;
  const device = (row.device === "desktop" || row.device === "both"
    ? row.device
    : "mobile") as DeviceSelection;
  const cadence: ScheduleCadence = "daily";
  const time = isValidTime(row.time) ? row.time : "09:00";
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    cadence,
    time,
    target,
    options,
    concurrency: row.concurrency,
    device,
    accuracyMode: row.accuracyMode,
    source: row.source === "psi" ? "psi" : "local",
    lastFiredAt: row.lastFiredAt,
    lastBatchId: row.lastBatchId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Split a `ScheduleTarget` into the two nullable column values. */
function targetColumns(target: ScheduleTarget): {
  urls: string | null;
  crawlSpec: string | null;
} {
  if (target.kind === "crawl") {
    return { urls: null, crawlSpec: JSON.stringify(target.spec) };
  }
  return { urls: JSON.stringify(target.urls), crawlSpec: null };
}

/** Create a schedule and return its persisted shape (or `null` on DB error). */
export function createSchedule(input: CreateScheduleInput): Schedule | null {
  try {
    const id = nanoid();
    const now = nowIso();
    const cols = targetColumns(input.target);
    // A schedule never carries credentials (see the module docblock): strip them
    // here, and return the stripped options so the caller's echo matches the row.
    const options = stripAuditCredentials(input.options);
    getDb()
      .insert(schedules)
      .values({
        id,
        name: input.name,
        enabled: input.enabled,
        cadence: input.cadence,
        time: input.time,
        urls: cols.urls,
        crawlSpec: cols.crawlSpec,
        options: JSON.stringify(options),
        concurrency: input.concurrency,
        device: input.device,
        accuracyMode: input.accuracyMode,
        source: input.source,
        lastFiredAt: null,
        lastBatchId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return {
      id,
      ...input,
      options,
      lastFiredAt: null,
      lastBatchId: null,
      createdAt: now,
      updatedAt: now,
    };
  } catch (err) {
    warn("createSchedule", err);
    return null;
  }
}

/** Patch an existing schedule. Returns the updated row, or `null` on error/miss. */
export function updateSchedule(
  id: string,
  patch: UpdateScheduleInput,
): Schedule | null {
  try {
    const existing = getSchedule(id);
    if (!existing) return null;
    const next: Schedule = {
      ...existing,
      ...patch,
      // Re-derive target columns from the chosen target (existing's if not provided).
      target: patch.target ?? existing.target,
      // Strip on the update path too (see the module docblock): a patch that
      // introduces credentials must not turn a credential-free schedule into one
      // that records them.
      options: stripAuditCredentials(patch.options ?? existing.options),
      updatedAt: nowIso(),
    };
    const cols = targetColumns(next.target);
    getDb()
      .update(schedules)
      .set({
        name: next.name,
        enabled: next.enabled,
        cadence: next.cadence,
        time: next.time,
        urls: cols.urls,
        crawlSpec: cols.crawlSpec,
        options: JSON.stringify(next.options),
        concurrency: next.concurrency,
        device: next.device,
        accuracyMode: next.accuracyMode,
        source: next.source,
        updatedAt: next.updatedAt,
      })
      .where(eq(schedules.id, id))
      .run();
    return next;
  } catch (err) {
    warn("updateSchedule", err);
    return null;
  }
}

/** Mark a schedule's most recent fire (called by the scheduler). */
export function recordScheduleFire(id: string, batchId: string): void {
  try {
    getDb()
      .update(schedules)
      .set({ lastFiredAt: nowIso(), lastBatchId: batchId })
      .where(eq(schedules.id, id))
      .run();
  } catch (err) {
    warn("recordScheduleFire", err);
  }
}

/** Delete a schedule. */
export function deleteSchedule(id: string): boolean {
  try {
    const result = getDb()
      .delete(schedules)
      .where(eq(schedules.id, id))
      .run();
    return result.changes > 0;
  } catch (err) {
    warn("deleteSchedule", err);
    return false;
  }
}

/** Read a single schedule, or `undefined` on miss/error. */
export function getSchedule(id: string): Schedule | undefined {
  try {
    const row = getDb()
      .select()
      .from(schedules)
      .where(eq(schedules.id, id))
      .get();
    if (!row) return undefined;
    return rowToSchedule(row) ?? undefined;
  } catch (err) {
    warn("getSchedule", err);
    return undefined;
  }
}

/** Every persisted schedule, newest first. Returns `[]` on any error. */
export function listSchedules(): Schedule[] {
  try {
    const rows = getDb()
      .select()
      .from(schedules)
      .orderBy(desc(schedules.createdAt))
      .all();
    const out: Schedule[] = [];
    for (const row of rows) {
      const s = rowToSchedule(row);
      if (s) out.push(s);
    }
    return out;
  } catch (err) {
    warn("listSchedules", err);
    return [];
  }
}
