/**
 * Options model for the Lighthouse engine (PRD §6 Phase 1).
 *
 * Validates and applies defaults to user-supplied audit configuration, producing
 * the canonical `AuditOptions` consumed by the rest of the engine. The zod schema
 * is the single source of runtime truth; a compile-time assertion below keeps it
 * locked to the `AuditOptions` contract in `./types.ts` so the two can't drift.
 */

import { z } from "zod";

import {
  type AuditOptions,
  LIGHTHOUSE_CATEGORIES,
  MAX_RUNS,
  MIN_RUNS,
} from "@/lib/lighthouse/types";

/** Mutable copy of the canonical category list for zod's enum/default. */
const CATEGORY_VALUES = [...LIGHTHOUSE_CATEGORIES] as [
  (typeof LIGHTHOUSE_CATEGORIES)[number],
  ...(typeof LIGHTHOUSE_CATEGORIES)[number][],
];

/**
 * Zod schema for raw audit options. Every field has a default, so an empty
 * object (or `undefined`, see {@link resolveAuditOptions}) yields the full set
 * of defaults. `categories` is deduped via a transform after validation.
 */
export const auditOptionsSchema = z.object({
  formFactor: z.enum(["mobile", "desktop"]).default("mobile"),
  throttling: z.enum(["simulated", "applied"]).default("simulated"),
  categories: z
    .array(z.enum(CATEGORY_VALUES))
    .min(1, "Select at least one Lighthouse category.")
    .transform((cats) => [...new Set(cats)])
    .default([...LIGHTHOUSE_CATEGORIES]),
  runs: z
    .int("runs must be an integer.")
    .min(MIN_RUNS, `runs must be at least ${MIN_RUNS}.`)
    .max(MAX_RUNS, `runs must be at most ${MAX_RUNS}.`)
    .default(3),
});

/**
 * Compile-time guard: the schema's inferred output must satisfy the canonical
 * `AuditOptions` contract. If `types.ts` and the schema diverge, this errors.
 */
type SchemaOutput = z.infer<typeof auditOptionsSchema>;
type _AssertSchemaMatchesContract = SchemaOutput extends AuditOptions
  ? AuditOptions extends SchemaOutput
    ? true
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _schemaMatchesContract: _AssertSchemaMatchesContract = true;

/** Resolved default options (mobile / simulated / all categories / 3 runs). */
export const DEFAULT_OPTIONS: AuditOptions = auditOptionsSchema.parse({});

/** Build a single, clear `Error` from a zod failure. */
function toOptionsError(error: z.ZodError): Error {
  const message = error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
  return new Error(`Invalid audit options: ${message}`);
}

/**
 * Parse a full or partial options object, applying defaults for any missing
 * field and deduping categories. `undefined`/`null` are treated as "use all
 * defaults". Throws a clear `Error` (wrapping the ZodError) on invalid input.
 */
export function resolveAuditOptions(input?: unknown): AuditOptions {
  const result = auditOptionsSchema.safeParse(input ?? {});
  if (!result.success) {
    throw toOptionsError(result.error);
  }
  return result.data;
}

/**
 * Validate audit options. Behaves identically to {@link resolveAuditOptions}:
 * unspecified fields fall back to defaults and categories are deduped. Provided
 * as a named alias for call sites that read more naturally as a "parse".
 */
export function parseAuditOptions(input: unknown): AuditOptions {
  return resolveAuditOptions(input);
}
