/**
 * Drizzle schema for local persistence (PRD §6 Phase 4).
 *
 * Two tables back the History / comparison features:
 *  - `batches` — one row per audit batch (the unit a user submits): resolved
 *    options, concurrency, lifecycle status + timestamps.
 *  - `runs`    — one row per per-URL job within a batch. Holds the median
 *    category scores (as discrete, sortable columns), the form factor (for the
 *    History "Device" column), the full metrics/options as JSON, and the
 *    filenames of the persisted report files under `./data/reports/`.
 *
 * A `runs` row is written when a job settles: `status = 'done'` with scores +
 * report filenames, or `status = 'error'` with `errorMessage` and null scores.
 * `runs.id` is the job id, which doubles as the report `runId`
 * (`GET /api/reports/:runId`).
 *
 * Keep this file import-light (drizzle only) — it is consumed by the runtime DB
 * client, the persistence layer, and drizzle-kit at generate time.
 */

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One audit batch (a set of per-URL jobs sharing one options set). */
export const batches = sqliteTable("batches", {
  /** Batch id (nanoid). */
  id: text("id").primaryKey(),
  /** queued | running | completed | completed_with_errors. */
  status: text("status").notNull(),
  /** Resolved `AuditOptions` as JSON. */
  options: text("options").notNull(),
  /** Resolved (clamped) concurrency the batch ran at. */
  concurrency: integer("concurrency").notNull(),
  /** Number of jobs in the batch. */
  total: integer("total").notNull(),
  /** ISO timestamps for the batch lifecycle. */
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
});

/** One per-URL run (job). `id` == job id == report `runId`. */
export const runs = sqliteTable("runs", {
  /** Run id (== job id == report runId). */
  id: text("id").primaryKey(),
  /** Owning batch. */
  batchId: text("batch_id")
    .notNull()
    .references(() => batches.id),
  /** 0-based position within the batch, for stable ordering. */
  idx: integer("idx").notNull(),
  /** Requested URL. */
  url: text("url").notNull(),
  /** Final URL after redirects (null for failed runs). */
  finalUrl: text("final_url"),
  /** done | error. */
  status: text("status").notNull(),
  /** Failure reason when `status = 'error'`. */
  errorMessage: text("error_message"),
  /** Emulated device (mobile | desktop) — drives the History "Device" column. */
  formFactor: text("form_factor").notNull(),
  /** simulated | applied. */
  throttling: text("throttling"),
  /** Number of Lighthouse runs the median was taken over. */
  runs: integer("runs"),
  lighthouseVersion: text("lighthouse_version"),
  /** Median category scores, 0–100, as discrete sortable columns (null = unscored). */
  scorePerformance: integer("score_performance"),
  scoreAccessibility: integer("score_accessibility"),
  scoreBestPractices: integer("score_best_practices"),
  scoreSeo: integer("score_seo"),
  /** Full resolved `AuditOptions` as JSON. */
  options: text("options").notNull(),
  /** Full `CoreWebVitals` (median run) as JSON; null for failed runs. */
  metrics: text("metrics"),
  /**
   * Host / effective-throttling environment of the median run (PRD §6 Phase 10):
   * `benchmark_index` is Lighthouse's "CPU/Memory Power" (real — can be fractional),
   * `throttling_method` the *effective* method ("simulate" | "devtools" | …), and
   * `cpu_slowdown_multiplier` the multiplier actually applied. Null for failed runs
   * (and on rows written before this migration).
   */
  benchmarkIndex: real("benchmark_index"),
  hostUserAgent: text("host_user_agent"),
  throttlingMethod: text("throttling_method"),
  cpuSlowdownMultiplier: real("cpu_slowdown_multiplier"),
  /** Report filenames under `./data/reports/` (null when absent). */
  reportJson: text("report_json"),
  reportHtml: text("report_html"),
  /** ISO fetchTime from the median LHR. */
  fetchTime: text("fetch_time"),
  /** ISO timestamp this row was persisted (History sort key). */
  createdAt: text("created_at").notNull(),
});

export type BatchRow = typeof batches.$inferSelect;
export type NewBatchRow = typeof batches.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
