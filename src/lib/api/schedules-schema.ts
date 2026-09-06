/**
 * Request validation for the `POST/PATCH /api/schedules` endpoints (PRD §6 Phase 14).
 *
 * The HTTP layer is responsible for turning an untrusted JSON body into a
 * validated {@link CreateScheduleInput} / {@link UpdateScheduleInput}. This
 * module owns that contract.
 *
 * Kept free of Next.js / queue-runtime imports so it stays trivially testable
 * — same shape as `audits-schema.ts`.
 *
 * ## The alert config is preference only (ROADMAP Phase C)
 *
 * `notify` accepts an armed flag, watched categories, a minimum drop and the
 * per-category pass bars — and **nothing credential-shaped**: no webhook URL, no
 * token, no destination of any kind. The webhook is read from
 * `process.env.LH_ALERT_WEBHOOK_URL`, Settings is read-only status plus `.env`
 * guidance, and a route that accepted a URL here would be a write path into
 * SQLite for a value anyone holding it can post with
 * (`.claude/rules/security.md`). Two layers keep that true: zod strips unknown
 * keys at parse, and `sanitizeNotify` rebuilds the object from a four-field
 * whitelist, so an extra field cannot reach the DB even if this schema is later
 * loosened.
 */

import { z } from "zod";

import {
  MAX_ALERT_DELTA,
  MIN_ALERT_DELTA,
  sanitizeNotify,
} from "@/lib/alerts/types";
import { auditOptionsSchema } from "@/lib/lighthouse/options";
import {
  LIGHTHOUSE_CATEGORIES,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import {
  MAX_EXCLUDE_PATHS,
  MAX_EXCLUDE_PATH_LENGTH,
  MAX_PAGES,
  MAX_DEPTH,
} from "@/lib/crawl/types";
import {
  clampConcurrency,
  DEFAULT_CONCURRENCY,
  type ApiErrorIssue,
} from "@/lib/queue/types";
import { MAX_SCHEDULE_URLS, isValidTime } from "@/lib/schedules/types";
import type {
  CreateScheduleInput,
  UpdateScheduleInput,
} from "@/lib/schedules/types";

const httpUrlSchema = z
  .string()
  .trim()
  .min(1, "URL must not be empty.")
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Must be a valid absolute URL." });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "URL must use the http or https protocol.",
      });
    }
  });

const timeSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (!isValidTime(value)) {
      ctx.addIssue({ code: "custom", message: "time must be HH:MM (24h)." });
    }
  });

const urlsTargetSchema = z.object({
  kind: z.literal("urls"),
  urls: z
    .array(httpUrlSchema)
    .min(1, "Provide at least one URL.")
    .max(MAX_SCHEDULE_URLS, `Provide at most ${MAX_SCHEDULE_URLS} URLs.`),
});

const crawlTargetSchema = z.object({
  kind: z.literal("crawl"),
  spec: z.object({
    url: httpUrlSchema,
    useSitemap: z.boolean(),
    useCrawl: z.boolean(),
    maxDepth: z.number().int().min(0).max(MAX_DEPTH),
    maxPages: z.number().int().min(1).max(MAX_PAGES),
    excludePaths: z
      .array(z.string().trim().min(1).max(MAX_EXCLUDE_PATH_LENGTH))
      .max(MAX_EXCLUDE_PATHS)
      .default([]),
  }),
});

const targetSchema = z.discriminatedUnion("kind", [
  urlsTargetSchema,
  crawlTargetSchema,
]);

/** `LIGHTHOUSE_CATEGORIES` as the non-empty tuple `z.enum` wants. */
const CATEGORY_VALUES = [...LIGHTHOUSE_CATEGORIES] as [
  LighthouseCategory,
  ...LighthouseCategory[],
];

/**
 * Regression-alert preferences. Every field optional — the Edit-schedule dialog
 * sends only what the user touched, and `sanitizeNotify` fills the rest from the
 * disarmed factory default. Bounds are validated here so a nonsense value is a
 * 400 the dialog can point at, rather than a silent clamp the user never sees.
 */
const notifySchema = z.object({
  enabled: z.boolean().optional(),
  categories: z.array(z.enum(CATEGORY_VALUES)).optional(),
  minDelta: z
    .int("notify.minDelta must be an integer.")
    .min(MIN_ALERT_DELTA, `notify.minDelta must be at least ${MIN_ALERT_DELTA}.`)
    .max(MAX_ALERT_DELTA, `notify.minDelta must be at most ${MAX_ALERT_DELTA}.`)
    .optional(),
  // Keyed loosely (not by the category enum) so a partial map is legal and a
  // blob written before a category existed still parses; `sanitizeThresholds`
  // inside `sanitizeNotify` rebuilds the full record and fills the gaps.
  thresholds: z
    .record(
      z.string(),
      z
        .int("notify.thresholds values must be integers.")
        .min(0, "notify.thresholds values must be at least 0.")
        .max(100, "notify.thresholds values must be at most 100."),
    )
    .optional(),
});

/**
 * Zod schema for `POST /api/schedules`. Required: `target`, `time`. Defaults
 * applied for everything else (mirroring `auditOptionsSchema`).
 */
export const createScheduleBodySchema = z.object({
  name: z.string().trim().max(120).optional().default(""),
  enabled: z.boolean().optional().default(true),
  cadence: z.literal("daily").optional().default("daily"),
  time: timeSchema,
  target: targetSchema,
  options: auditOptionsSchema
    .optional()
    .default(() => auditOptionsSchema.parse({})),
  concurrency: z
    .number("concurrency must be a number.")
    .optional()
    .transform((n) => (n === undefined ? DEFAULT_CONCURRENCY : clampConcurrency(n))),
  device: z.enum(["mobile", "desktop", "both"]).optional(),
  accuracyMode: z.boolean().optional().default(false),
  // Engine each fired batch runs on (PSI feature). Defaults to the local engine.
  source: z.enum(["local", "psi"]).optional().default("local"),
  // Regression alerts (ROADMAP Phase C). Omitted → the disarmed default.
  notify: notifySchema.optional(),
});

/** Partial-update schema — every field optional. */
export const updateScheduleBodySchema = createScheduleBodySchema.partial();

export type ParseCreateScheduleResult =
  | { ok: true; value: CreateScheduleInput }
  | { ok: false; issues: ApiErrorIssue[] };

export type ParseUpdateScheduleResult =
  | { ok: true; value: UpdateScheduleInput }
  | { ok: false; issues: ApiErrorIssue[] };

function toApiIssues(error: z.ZodError): ApiErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}

export function parseCreateScheduleBody(raw: unknown): ParseCreateScheduleResult {
  const result = createScheduleBodySchema.safeParse(raw ?? {});
  if (!result.success) return { ok: false, issues: toApiIssues(result.error) };
  const data = result.data;
  const device = data.device ?? data.options.formFactor;
  return {
    ok: true,
    value: {
      name: data.name,
      enabled: data.enabled,
      cadence: data.cadence,
      time: data.time,
      target: data.target,
      options: data.options,
      concurrency: data.concurrency,
      device,
      accuracyMode: data.accuracyMode,
      source: data.source,
      // Sanitize at the API seam as well as in the DB layer, so the value the
      // route echoes back is identical to the one a later read returns.
      notify: sanitizeNotify(data.notify),
    },
  };
}

export function parseUpdateScheduleBody(raw: unknown): ParseUpdateScheduleResult {
  const result = updateScheduleBodySchema.safeParse(raw ?? {});
  if (!result.success) return { ok: false, issues: toApiIssues(result.error) };
  const data = result.data;
  const value: UpdateScheduleInput = {};
  if (data.name !== undefined) value.name = data.name;
  if (data.enabled !== undefined) value.enabled = data.enabled;
  if (data.cadence !== undefined) value.cadence = data.cadence;
  if (data.time !== undefined) value.time = data.time;
  if (data.target !== undefined) value.target = data.target;
  if (data.options !== undefined) value.options = data.options;
  if (data.concurrency !== undefined) value.concurrency = data.concurrency;
  if (data.device !== undefined) value.device = data.device;
  else if (data.options !== undefined) value.device = data.options.formFactor;
  if (data.accuracyMode !== undefined) value.accuracyMode = data.accuracyMode;
  if (data.source !== undefined) value.source = data.source;
  // Only when the patch actually carries it: an update that omits `notify` must
  // leave the schedule's current arming alone, not reset it to the default.
  if (data.notify !== undefined) value.notify = sanitizeNotify(data.notify);
  return { ok: true, value };
}
