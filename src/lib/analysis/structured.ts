/**
 * Structured-output handling shared by every analysis driver.
 *
 * The prompt asks the model to stream a markdown diagnosis and then emit its
 * fixes as one JSON object wrapped in the {@link FIXES_OPEN}/{@link FIXES_CLOSE}
 * sentinels. This module owns the whole recovery ladder for that block:
 *
 *   1. split the sentinel block out of the final text;
 *   2. zod-validate the envelope and each entry (tolerant: bad entries are
 *      dropped, loose fields are coerced, so one sloppy fix never loses the rest);
 *   3. on failure a driver may run ONE repair pass ({@link buildRepairPrompt});
 *   4. still bad → the caller degrades to a prose-only diagnosis.
 *
 * Nothing here throws and nothing here does I/O — a malformed model response is
 * a degraded result, never a crashed stream.
 */

import { z } from "zod";

import { asString, isRecord } from "@/lib/lighthouse/parseLhr";
import {
  FIXES_CLOSE,
  FIXES_OPEN,
  type AnalysisCitation,
  type Fix,
  type FixPriority,
} from "@/lib/analysis/types";

/** Why a fixes block could not be turned into {@link Fix}[]. */
export type FixesParseError =
  | "missing_block"
  | "invalid_json"
  | "invalid_shape"
  | "no_valid_fixes";

/** Outcome of parsing one fixes block. */
export interface FixesParseResult {
  fixes: Fix[];
  /** `null` on success; a machine-readable reason otherwise. */
  error: FixesParseError | null;
}

/** Options controlling how strictly a block is read. */
export interface ParseFixesOptions {
  /**
   * Keep `citations`. False on ungrounded (data-only) providers, where the model
   * had no fetch tool: any URL it produced would be invented, and a fix must
   * never carry a citation the model did not actually open.
   */
  allowCitations?: boolean;
}

/** Envelope shape: `{ "fixes": [...] }`. Entries stay unknown for lenient coercion. */
const envelopeSchema = z.object({ fixes: z.array(z.unknown()) });

/**
 * The only hard requirement on one entry: an object with a non-empty title.
 * Everything else is optional and coerced below, mirroring how tolerant the
 * original single-driver parser was.
 */
const fixShapeSchema = z.object({ title: z.string().trim().min(1) });

const citationSchema = z.object({
  url: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
});

/** Split a final response into the markdown diagnosis and the raw fixes block. */
export function splitDiagnosisAndFixes(text: string): {
  diagnosis: string;
  fixesJson: string | null;
} {
  const open = text.indexOf(FIXES_OPEN);
  if (open === -1) return { diagnosis: text.trim(), fixesJson: null };
  const diagnosis = text.slice(0, open).trim();
  const after = text.slice(open + FIXES_OPEN.length);
  const close = after.indexOf(FIXES_CLOSE);
  const fixesJson = (close === -1 ? after : after.slice(0, close)).trim();
  return { diagnosis, fixesJson };
}

/** Coerce one raw priority value into a {@link FixPriority} (default "medium"). */
function coercePriority(value: unknown): FixPriority {
  return value === "high" || value === "low" ? value : "medium";
}

/** Coerce a raw citations array into {@link AnalysisCitation}[], dropping bad entries. */
function coerceCitations(value: unknown): AnalysisCitation[] {
  if (!Array.isArray(value)) return [];
  const out: AnalysisCitation[] = [];
  for (const entry of value) {
    const parsed = citationSchema.safeParse(entry);
    if (!parsed.success) continue;
    out.push({ url: parsed.data.url, title: parsed.data.title });
  }
  return out;
}

/**
 * Strip the wrapping a weaker model tends to add around the block: markdown code
 * fences, a stray closing sentinel, and any prose after the final `}`.
 */
function unwrapJson(raw: string): string {
  let text = raw.trim();
  const closeAt = text.indexOf(FIXES_CLOSE);
  if (closeAt !== -1) text = text.slice(0, closeAt);
  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // Trailing commentary after the object is common; keep the outermost braces.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) text = text.slice(first, last + 1);
  return text.trim();
}

/**
 * Parse a fixes block into validated {@link Fix}[]. Never throws: an unusable
 * block returns `[]` plus a {@link FixesParseError} the caller can act on
 * (repair once, then degrade to prose-only).
 */
export function parseFixes(
  fixesJson: string | null,
  options: ParseFixesOptions = {},
): FixesParseResult {
  const allowCitations = options.allowCitations !== false;
  if (!fixesJson || !fixesJson.trim()) return { fixes: [], error: "missing_block" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(fixesJson));
  } catch {
    return { fixes: [], error: "invalid_json" };
  }

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) return { fixes: [], error: "invalid_shape" };

  const fixes: Fix[] = [];
  for (const raw of envelope.data.fixes) {
    const shape = fixShapeSchema.safeParse(raw);
    if (!shape.success || !isRecord(raw)) continue;
    const steps = Array.isArray(raw.steps)
      ? raw.steps.filter((s): s is string => typeof s === "string")
      : [];
    fixes.push({
      title: shape.data.title,
      why: asString(raw.why) ?? "",
      steps,
      priority: coercePriority(raw.priority),
      citations: allowCitations ? coerceCitations(raw.citations) : [],
    });
  }

  // An EMPTY array is a valid answer — a category scoring 100 genuinely has
  // nothing to fix — so only report a failure when entries were present and
  // none of them survived validation. Otherwise a correct response would draw a
  // pointless repair call and a "could not be parsed" warning that isn't true.
  if (fixes.length === 0 && envelope.data.fixes.length > 0) {
    return { fixes: [], error: "no_valid_fixes" };
  }
  return { fixes, error: null };
}

/** Deduped union of every citation across all fixes, preserving first-seen order. */
export function collectSources(fixes: Fix[]): AnalysisCitation[] {
  const seen = new Set<string>();
  const sources: AnalysisCitation[] = [];
  for (const fix of fixes) {
    for (const citation of fix.citations) {
      if (seen.has(citation.url)) continue;
      seen.add(citation.url);
      sources.push(citation);
    }
  }
  return sources;
}

/** How much of a broken block to hand back to the model for repair. */
const MAX_REPAIR_CHARS = 12_000;

/** System prompt for the repair pass — reformat only, never re-reason. */
export const FIXES_REPAIR_SYSTEM_PROMPT = `You convert malformed JSON into valid JSON. You will be given text that was supposed to be a single JSON object. Return the corrected JSON object and NOTHING else: no explanation, no markdown code fences, no sentinels. Preserve the original content faithfully — never invent fields, entries, or URLs. If a required field is missing, use a sensible value taken from the text you were given.`;

/**
 * The repair turn for a block that failed validation. Deliberately narrow: the
 * model is asked to reformat what it already wrote, not to redo the analysis, so
 * one cheap extra call rescues most small-model JSON slips.
 */
export function buildRepairPrompt(raw: string, allowCitations = true): string {
  const truncated = raw.slice(0, MAX_REPAIR_CHARS);
  const citations = allowCitations
    ? `      "citations": [ { "url": "https://…", "title": "Source title" } ]`
    : `      "citations": []`;
  return [
    "The text below was supposed to be a single JSON object with this shape:",
    "",
    "{",
    '  "fixes": [',
    "    {",
    '      "title": "string",',
    '      "why": "string",',
    '      "steps": ["string"],',
    '      "priority": "high" | "medium" | "low",',
    citations,
    "    }",
    "  ]",
    "}",
    "",
    "Return that object, corrected and valid (double-quoted keys and strings, no",
    "trailing commas, no comments, no code fences). Output only the JSON object.",
    "",
    "--- TEXT TO REPAIR ---",
    truncated,
  ].join("\n");
}
