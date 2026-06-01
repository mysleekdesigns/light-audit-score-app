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
  type DeviceSelection,
  type FormFactor,
  LIGHTHOUSE_CATEGORIES,
  MAX_CPU_MULTIPLIER,
  MAX_RUNS,
  MIN_CPU_MULTIPLIER,
  MIN_RUNS,
} from "@/lib/lighthouse/types";

/** Mutable copy of the canonical category list for zod's enum/default. */
const CATEGORY_VALUES = [...LIGHTHOUSE_CATEGORIES] as [
  (typeof LIGHTHOUSE_CATEGORIES)[number],
  ...(typeof LIGHTHOUSE_CATEGORIES)[number][],
];

/** Clamp an arbitrary number into the allowed CPU-multiplier band (mirrors `clampConcurrency`). */
function clampCpuMultiplier(n: number): number {
  return Math.min(MAX_CPU_MULTIPLIER, Math.max(MIN_CPU_MULTIPLIER, n));
}

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
  // Optional, NO default: when omitted it stays `undefined` and the engine
  // doesn't pass the flag, so Lighthouse uses its own 4× default. Per the PRD
  // we clamp (never reject) finite values into [MIN..MAX]_CPU_MULTIPLIER —
  // mirroring the `concurrency` clamp style.
  cpuSlowdownMultiplier: z
    .number("cpuSlowdownMultiplier must be a number.")
    .transform((n) => clampCpuMultiplier(n))
    .optional(),
  // Warm-cache mode (default true) — reuse a Chrome profile + a discarded
  // warm-up navigation so scores match the DevTools Lighthouse panel (warm /
  // repeat-visit) instead of a cold first visit. See AuditOptions.warmCache.
  warmCache: z.boolean().default(true),
  // Optional emulated page UA override (parity lever for bot-sensitive sites).
  // No default: when omitted the engine passes no flag and Lighthouse uses its
  // config-default device UA. See AuditOptions.emulatedUserAgent.
  emulatedUserAgent: z.string().optional(),
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

/**
 * Resolve a {@link DeviceSelection} into the concrete {@link FormFactor}s to
 * audit (PRD §6 Phase 12). `"both"` expands to `["mobile", "desktop"]` (in that
 * stable order); a single device returns just itself. The queue uses this to fan
 * a `"both"` URL out into two independent isolated-Chrome jobs, each running one
 * concrete form factor — the engine/worker never sees `"both"`.
 */
export function resolveFormFactors(device: DeviceSelection): FormFactor[] {
  return device === "both" ? ["mobile", "desktop"] : [device];
}
