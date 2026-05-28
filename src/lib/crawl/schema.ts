/**
 * Request validation for `POST /api/discover` (PRD §6 Phase 5).
 *
 * Mirrors `@/lib/api/audits-schema`: turn an untrusted JSON body into the
 * already-resolved {@link DiscoverInput} the engine consumes (seed `url` a
 * trimmed absolute http/https URL, toggles defaulted, depth/pages clamped into
 * their bounds). The HTTP layer owns this contract via a zod schema plus a pure
 * {@link parseDiscoverBody} that maps zod failures into structured
 * {@link ApiErrorIssue}s.
 *
 * Kept free of Next.js / engine-runtime (cheerio, fast-xml-parser, fetch)
 * imports so it stays trivially unit-testable. A compile-time assertion locks
 * the schema's inferred output to {@link DiscoverInput} so the two can't drift
 * (same pattern as `@/lib/lighthouse/options`).
 */

import { z } from "zod";

import type { ApiErrorIssue } from "@/lib/queue/types";

import {
  clampDepth,
  clampPages,
  DEFAULT_DEPTH,
  DEFAULT_PAGES,
  DEFAULT_USE_CRAWL,
  DEFAULT_USE_SITEMAP,
  MAX_EXCLUDE_PATH_LENGTH,
  MAX_EXCLUDE_PATHS,
  type DiscoverInput,
} from "./types";

/**
 * Validate the seed URL: trim, require a parseable absolute URL, and reject
 * anything that isn't `http:`/`https:`. Identical protocol rule to
 * `audits-schema` so discovery and audit accept exactly the same URLs.
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

/**
 * Zod schema for the `POST /api/discover` body.
 *  - `url`: required, a trimmed http/https seed URL.
 *  - `useSitemap` / `useCrawl`: optional booleans, defaulted per the contract.
 *  - `maxDepth` / `maxPages`: optional finite numbers, resolved via
 *    `clampDepth` / `clampPages` and defaulted when omitted.
 *  - `excludePaths`: optional `string[]`, defaulted to `[]`. Reject more than
 *    `MAX_EXCLUDE_PATHS` entries; per entry, reject empty/whitespace-only and
 *    anything longer than `MAX_EXCLUDE_PATH_LENGTH` chars. On success each entry
 *    is normalized to its trimmed form. An invalid entry rejects the whole
 *    request (→ structured 400), so the engine only ever sees clean patterns.
 */
const excludePathSchema = z
  .string("Each exclude path must be a string.")
  .superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed === "") {
      ctx.addIssue({
        code: "custom",
        message: "Exclude path must not be empty.",
      });
      return;
    }
    if (trimmed.length > MAX_EXCLUDE_PATH_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message: `Exclude path must be at most ${MAX_EXCLUDE_PATH_LENGTH} characters.`,
      });
    }
  })
  .transform((value) => value.trim());

export const discoverBodySchema = z.object({
  url: httpUrlSchema,
  useSitemap: z.boolean().optional().default(DEFAULT_USE_SITEMAP),
  useCrawl: z.boolean().optional().default(DEFAULT_USE_CRAWL),
  maxDepth: z
    .number("maxDepth must be a number.")
    .optional()
    .transform((n) => (n === undefined ? DEFAULT_DEPTH : clampDepth(n))),
  maxPages: z
    .number("maxPages must be a number.")
    .optional()
    .transform((n) => (n === undefined ? DEFAULT_PAGES : clampPages(n))),
  excludePaths: z
    .array(excludePathSchema)
    .max(MAX_EXCLUDE_PATHS, `At most ${MAX_EXCLUDE_PATHS} exclude paths allowed.`)
    .optional()
    .default([]),
});

/**
 * Compile-time guard: the schema's inferred output must satisfy the canonical
 * {@link DiscoverInput} contract (and vice-versa). If `types.ts` and the schema
 * diverge, this errors at build time.
 */
type SchemaOutput = z.infer<typeof discoverBodySchema>;
type _AssertSchemaMatchesContract = SchemaOutput extends DiscoverInput
  ? DiscoverInput extends SchemaOutput
    ? true
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _schemaMatchesContract: _AssertSchemaMatchesContract = true;

/** Discriminated result of {@link parseDiscoverBody}. */
export type ParseDiscoverResult =
  | { ok: true; value: DiscoverInput }
  | { ok: false; issues: ApiErrorIssue[] };

/** Map a zod error's issues into the API's structured {@link ApiErrorIssue} list. */
function toApiIssues(error: z.ZodError): ApiErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}

/**
 * Validate an already-JSON-parsed request body into a {@link DiscoverInput}.
 *
 * Pure and synchronous — no I/O — so it can be unit-tested without network.
 * Returns `{ ok: true, value }` with toggles defaulted + bounds clamped, or
 * `{ ok: false, issues }` mapping each zod failure to `{ path, message }`.
 */
export function parseDiscoverBody(raw: unknown): ParseDiscoverResult {
  const result = discoverBodySchema.safeParse(raw ?? {});
  if (!result.success) {
    return { ok: false, issues: toApiIssues(result.error) };
  }
  const { url, useSitemap, useCrawl, maxDepth, maxPages, excludePaths } =
    result.data;
  return {
    ok: true,
    value: { url, useSitemap, useCrawl, maxDepth, maxPages, excludePaths },
  };
}
