/**
 * Shared contract for scheduled recurring audits (PRD §6 Phase 14 — Scheduled
 * daily archive). Keep this file free of runtime/Next/queue imports so it can
 * be shared by server route handlers and client UI alike.
 *
 * A schedule's *target* is either a fixed URL list (`{ kind: "urls", urls }`) or
 * a crawl spec (`{ kind: "crawl", spec }`); the local scheduler resolves a crawl
 * target by re-running discovery each fire, then submits the resolved URLs
 * through the existing `POST /api/audits` path (no new queue, just a new
 * caller). Cadence is daily-at-HH:MM (24h, server-local) — the smallest model
 * that satisfies the PRD's "daily @ HH:MM" example.
 */

import type { ScheduleNotify } from "@/lib/alerts/types";
import type {
  AuditOptions,
  AuditSource,
  DeviceSelection,
} from "@/lib/lighthouse/types";

/** Cadence kinds the scheduler supports. Only `"daily"` is wired today. */
export type ScheduleCadence = "daily";

/** A fixed URL list target. URLs are validated identically to a batch submit. */
export interface ScheduleUrlsTarget {
  kind: "urls";
  urls: string[];
}

/**
 * A re-runnable crawl spec — the persistent counterpart to a one-shot
 * `DiscoverRequest`. Each fire re-resolves it through the existing discovery
 * engine, then submits the resolved URLs as a batch.
 */
export interface ScheduleCrawlTarget {
  kind: "crawl";
  spec: {
    url: string;
    useSitemap: boolean;
    useCrawl: boolean;
    maxDepth: number;
    maxPages: number;
    excludePaths: string[];
  };
}

export type ScheduleTarget = ScheduleUrlsTarget | ScheduleCrawlTarget;

/** Schedule as the API/UI sees it (target as a discriminated union, dates as ISO strings). */
export interface Schedule {
  id: string;
  /** Free-text name (defaults to a target-derived hint when empty). */
  name: string;
  enabled: boolean;
  cadence: ScheduleCadence;
  /** "HH:MM" 24h, server-local. */
  time: string;
  target: ScheduleTarget;
  options: AuditOptions;
  concurrency: number;
  device: DeviceSelection;
  accuracyMode: boolean;
  /** Engine each fired batch runs on ("local" | "psi"); defaults to "local". */
  source: AuditSource;
  /**
   * Regression-alert preferences (ROADMAP Phase C). Always present on a read —
   * a row stored before the 0008 migration reads back as the factory default,
   * which is disarmed. Contains no credential: the webhook URL is read from
   * `LH_ALERT_WEBHOOK_URL` and never travels with a schedule.
   */
  notify: ScheduleNotify;
  /** ISO timestamp of the most recent fire, or null. */
  lastFiredAt: string | null;
  /** Batch id the most recent fire produced, or null. */
  lastBatchId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Shape accepted by `createSchedule` / `POST /api/schedules` (no id/lifecycle). */
export interface CreateScheduleInput {
  name: string;
  enabled: boolean;
  cadence: ScheduleCadence;
  time: string;
  target: ScheduleTarget;
  options: AuditOptions;
  concurrency: number;
  device: DeviceSelection;
  accuracyMode: boolean;
  /** Engine each fired batch runs on ("local" | "psi"). */
  source: AuditSource;
  /** Regression-alert preferences. Omitted by older callers → disarmed default. */
  notify?: ScheduleNotify;
}

/** Shape accepted by `updateSchedule` / `PATCH /api/schedules/:id`. */
export type UpdateScheduleInput = Partial<CreateScheduleInput>;

/** Validate an "HH:MM" 24h string. Strict (zero-padded). */
export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Hard cap on the number of URLs a `urls` target may carry (matches batch cap). */
export const MAX_SCHEDULE_URLS = 50;
