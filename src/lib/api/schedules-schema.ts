/**
 * Request validation for the `POST/PATCH /api/schedules` endpoints (PRD §6 Phase 14).
 *
 * The HTTP layer is responsible for turning an untrusted JSON body into a
 * validated {@link CreateScheduleInput} / {@link UpdateScheduleInput}. This
 * module owns that contract.
 *
 * Kept free of Next.js / queue-runtime imports so it stays trivially testable
 * — same shape as `audits-schema.ts`.
 */

import { z } from "zod";

import { auditOptionsSchema } from "@/lib/lighthouse/options";
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
  return { ok: true, value };
}
