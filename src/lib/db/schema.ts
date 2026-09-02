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

import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** One audit batch (a set of per-URL jobs sharing one options set). */
export const batches = sqliteTable("batches", {
  /** Batch id (nanoid). */
  id: text("id").primaryKey(),
  /** queued | running | completed | completed_with_errors. */
  status: text("status").notNull(),
  /** Engine that ran the batch: "local" (forked Chrome) | "psi" (PageSpeed Insights). */
  source: text("source").notNull().default("local"),
  /** Resolved `AuditOptions` as JSON. */
  options: text("options").notNull(),
  /** Resolved (clamped) concurrency the batch ran at. */
  concurrency: integer("concurrency").notNull(),
  /** Number of jobs in the batch. */
  total: integer("total").notNull(),
  /**
   * The batch this one was created from via Re-run / Regenerate (PRD §6 Phase 13).
   * Null for originally-submitted batches. Records lineage so a re-run's new runs
   * are one click from the Phase-6 compare / trend of the same URLs.
   */
  priorBatchId: text("prior_batch_id"),
  /**
   * The schedule that fired this batch (PRD §6 Phase 14). Null for ad-hoc batches.
   * Lets the Archive view group runs by schedule for day-over-day trends.
   */
  scheduleId: text("schedule_id"),
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
  /** Engine that produced this run: "local" (forked Chrome) | "psi" (PageSpeed Insights). */
  source: text("source").notNull().default("local"),
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
   * Real-world CrUX field data ({@link FieldData}) as JSON — present only for PSI
   * runs when CrUX has data for the URL/origin; null for local runs and failures.
   */
  field: text("field"),
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

/**
 * Scheduled recurring batches (PRD §6 Phase 14 — Scheduled daily archive).
 *
 * One row per saved schedule. The target is *either* a fixed URL list (URLs JSON
 * is non-empty, crawlSpec is null) *or* a crawl spec (crawlSpec JSON is non-null,
 * URLs may be empty). Cadence is daily-at-HH:MM (24h, server-local), recorded as
 * the literal string `HH:MM` so the local scheduler can resolve next-fire purely.
 * `lastFiredAt` / `lastBatchId` close the loop with the existing `batches` table:
 * the Archive view groups runs by `schedule_id` (via `batches.scheduleId`).
 */
export const schedules = sqliteTable("schedules", {
  /** Schedule id (nanoid). */
  id: text("id").primaryKey(),
  /** Human-readable name (free text; defaults to a target-derived hint when empty). */
  name: text("name").notNull(),
  /** When false, the local scheduler will never fire this row. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Cadence: daily at HH:MM (24h, server-local). */
  cadence: text("cadence").notNull(),
  /** "HH:MM" 24h. Validated by the scheduler module on read/write. */
  time: text("time").notNull(),
  /** Fixed URL list as JSON (`string[]`) — non-empty for `urls` targets. */
  urls: text("urls"),
  /** Crawl spec as JSON (`CrawlSpec`) — present for `crawl` targets. */
  crawlSpec: text("crawl_spec"),
  /** Resolved `AuditOptions` as JSON (same shape `batches.options` stores). */
  options: text("options").notNull(),
  /** Resolved (clamped) concurrency to run each batch with. */
  concurrency: integer("concurrency").notNull(),
  /** `device` (PRD §6 Phase 12): "mobile" | "desktop" | "both". */
  device: text("device").notNull(),
  /** Engine each fired batch runs on: "local" (forked Chrome) | "psi" (PageSpeed Insights). */
  source: text("source").notNull().default("local"),
  /** Accuracy-mode flag (PRD §6 Phase 9) applied to each fire. */
  accuracyMode: integer("accuracy_mode", { mode: "boolean" }).notNull().default(false),
  /** ISO timestamp this schedule last fired, or null. */
  lastFiredAt: text("last_fired_at"),
  /** Last batch id this schedule produced (null until it has fired). */
  lastBatchId: text("last_batch_id"),
  /** ISO creation timestamp. */
  createdAt: text("created_at").notNull(),
  /** ISO timestamp of the last edit. */
  updatedAt: text("updated_at").notNull(),
});

/**
 * AI score analyses (the "explain & fix my score" feature).
 *
 * One row per analyzed `(run, category)` pair: a markdown diagnosis plus a JSON
 * array of prioritized, web-researched fixes (with cited source URLs), produced
 * by the Claude Agent SDK. Persisting it means reopening a run shows the analysis
 * instantly without re-spending tokens; re-running overwrites the row (the unique
 * index on `run_id + category` makes the upsert deterministic). Child of `runs`
 * via `run_id` — `deleteRun` / `clearHistory` remove these first (FK is ON).
 */
export const analyses = sqliteTable(
  "analyses",
  {
    /** Analysis id (nanoid). */
    id: text("id").primaryKey(),
    /** The analyzed run (== report runId == job id). */
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    /** Lighthouse category analyzed ("performance" | "accessibility" | "best-practices" | "seo"). */
    category: text("category").notNull(),
    /** The 0–100 category score at analysis time (null if that category was unscored). */
    categoryScore: integer("category_score"),
    /** Model id that produced the analysis. */
    model: text("model").notNull(),
    /** Markdown diagnosis prose. */
    diagnosis: text("diagnosis").notNull(),
    /** Prioritized fixes as JSON (`Fix[]`). */
    fixes: text("fixes").notNull(),
    /** Deduped union of cited sources as JSON (`AnalysisCitation[]`). */
    sources: text("sources").notNull(),
    /** Total API cost in USD, when reported. */
    costUsd: real("cost_usd"),
    /** Number of agentic turns taken. */
    turns: integer("turns"),
    /** Soft warnings as JSON (`string[]`), or null. */
    warnings: text("warnings"),
    /** ISO timestamp this analysis was produced. */
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("analyses_run_category_uq").on(t.runId, t.category)],
);

/**
 * App-level preferences the user sets from the Settings page — a tiny
 * key/value store, one row per setting, values as strings (JSON where a
 * setting isn't a plain scalar).
 *
 * This is for PREFERENCES only (e.g. whether the CrawlForge research server is
 * enabled). Credentials never go here: keys stay in the environment
 * (`.env`) and are only ever reported as present/absent.
 */
export const appSettings = sqliteTable("app_settings", {
  /** Setting name, e.g. `research.crawlforge.enabled`. */
  key: text("key").primaryKey(),
  /** Serialized value. */
  value: text("value").notNull(),
  /** ISO timestamp of the last write. */
  updatedAt: text("updated_at").notNull(),
});

export type BatchRow = typeof batches.$inferSelect;
export type NewBatchRow = typeof batches.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type ScheduleRow = typeof schedules.$inferSelect;
export type NewScheduleRow = typeof schedules.$inferInsert;
export type AnalysisRow = typeof analyses.$inferSelect;
export type NewAnalysisRow = typeof analyses.$inferInsert;
