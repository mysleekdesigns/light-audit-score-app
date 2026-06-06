/**
 * Request validation for `POST /api/audits` (PRD §6 Phase 2).
 *
 * The HTTP layer is responsible for turning an untrusted JSON body into the
 * already-validated {@link CreateBatchInput} the queue consumes (urls non-empty
 * and http/https, options resolved with defaults, concurrency clamped). This
 * module owns that contract via a zod schema plus a pure {@link parseCreateBatchBody}
 * function that maps zod failures into the structured {@link ApiErrorIssue} list.
 *
 * Kept free of Next.js / queue-runtime imports so it stays trivially testable.
 */

import { z } from "zod";

import { auditOptionsSchema } from "@/lib/lighthouse/options";
import {
  clampConcurrency,
  DEFAULT_CONCURRENCY,
  type ApiErrorIssue,
  type CreateBatchInput,
} from "@/lib/queue/types";

/**
 * Maximum URLs accepted in a single batch — bounds abuse / runaway batches.
 * Kept equal to discovery's `MAX_PAGES` (`@/lib/crawl/types`) so a fully-selected
 * discovery set can always be submitted here — raise the two together.
 */
export const MAX_URLS = 10000;

/**
 * Validate a single URL string: trim it, require a parseable absolute URL, and
 * reject anything that isn't `http:`/`https:` (no `file:`, `ftp:`, `javascript:`,
 * etc.). zod v4 ships `z.url()`, but we also enforce the protocol explicitly so
 * the rules are unambiguous regardless of `z.url()`'s default allowances.
 */
const httpUrlSchema = z
  .string()
  .trim()
  .min(1, "URL must not be empty.")
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Must be a valid absolute URL.",
      });
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "URL must use the http or https protocol.",
      });
    }
  });

/**
 * Zod schema for the `POST /api/audits` body.
 *  - `urls`: 1..{@link MAX_URLS} entries, each a trimmed http/https URL.
 *  - `options`: optional; validated/defaulted by the engine's `auditOptionsSchema`.
 *  - `concurrency`: optional finite number; resolved via `clampConcurrency` and
 *    defaulted to {@link DEFAULT_CONCURRENCY} when omitted.
 */
export const createBatchBodySchema = z.object({
  urls: z
    .array(httpUrlSchema)
    .min(1, "Provide at least one URL.")
    .max(MAX_URLS, `Provide at most ${MAX_URLS} URLs.`),
  // Device selection (PRD §6 Phase 12). Optional: when omitted the effective
  // device falls back to `options.formFactor` (a back-compatible single-device
  // run). `"both"` fans each URL out into a mobile + a desktop job in the queue.
  device: z.enum(["mobile", "desktop", "both"]).optional(),
  options: auditOptionsSchema.optional().default(() => auditOptionsSchema.parse({})),
  concurrency: z
    .number("concurrency must be a number.")
    .optional()
    .transform((n) => (n === undefined ? DEFAULT_CONCURRENCY : clampConcurrency(n))),
  // Engine to run on (PSI feature). Defaults to the local forked-Chrome engine;
  // `"psi"` routes every job through Google PageSpeed Insights instead.
  source: z.enum(["local", "psi"]).optional().default("local"),
  // Accuracy mode (PRD §6 Phase 9): when true the queue forces effective
  // concurrency to 1 if Performance is in scope, for DevTools-panel parity.
  accuracyMode: z.boolean().optional().default(false),
  // Re-run lineage (PRD §6 Phase 13): the id of the batch this request re-runs.
  // Optional and free-form (a nanoid) — recorded for lineage, never executed on.
  priorBatchId: z.string().optional(),
});

/** Discriminated result of {@link parseCreateBatchBody}. */
export type ParseCreateBatchResult =
  | { ok: true; value: CreateBatchInput }
  | { ok: false; issues: ApiErrorIssue[] };

/** Map a zod error's issues into the API's structured {@link ApiErrorIssue} list. */
function toApiIssues(error: z.ZodError): ApiErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}

/**
 * Validate an already-JSON-parsed request body into a {@link CreateBatchInput}.
 *
 * Pure and synchronous — no I/O — so it can be unit-tested without Chrome or the
 * queue. Returns `{ ok: true, value }` with defaults applied and concurrency
 * clamped, or `{ ok: false, issues }` mapping each zod failure to `{ path, message }`.
 */
export function parseCreateBatchBody(raw: unknown): ParseCreateBatchResult {
  const result = createBatchBodySchema.safeParse(raw ?? {});
  if (!result.success) {
    return { ok: false, issues: toApiIssues(result.error) };
  }
  // `result.data` already satisfies CreateBatchInput (urls/options/concurrency
  // resolved); the explicit shape keeps the contract obvious to readers.
  const { urls, options, source, concurrency, accuracyMode, priorBatchId } =
    result.data;
  // Resolve the effective device (PRD §6 Phase 12): an explicit `device` wins;
  // otherwise an omitted device defaults to the options' concrete `formFactor`,
  // so older bodies (no `device`) behave as a single-device run unchanged.
  const device = result.data.device ?? result.data.options.formFactor;
  return {
    ok: true,
    value: { urls, device, options, source, concurrency, accuracyMode, priorBatchId },
  };
}
