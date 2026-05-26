/**
 * Pure URL-list parsing for the "New Audit" form (PRD §6 Phase 3).
 *
 * Mirrors the server-side rule in `src/lib/api/audits-schema.ts`: a token is a
 * valid target only if it parses as an absolute URL with the `http:`/`https:`
 * protocol. The textarea is split on newlines AND commas so users can paste
 * either format (or a mix). Dependency-free and pure so it can be unit-tested
 * and reused without pulling in React or the API layer.
 */

/** Result of {@link parseUrls}: deduped valid URLs plus rejected tokens with their source line. */
export interface ParseUrlsResult {
  /** Valid http/https URLs, deduped, in first-seen order. */
  urls: string[];
  /** Rejected non-empty tokens, with the 1-based line they appeared on. */
  invalid: { line: number; value: string }[];
}

/** True when `value` parses as an absolute http/https URL (the server rule). */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Parse free-form textarea text into valid URLs and invalid tokens.
 *
 * Splits each line on commas as well as newlines, trims every token, and drops
 * empty tokens. Valid tokens (absolute http/https URLs) are collected into
 * `urls`, deduped while preserving first-seen order; everything else is recorded
 * in `invalid` with the 1-based index of the line it came from.
 */
export function parseUrls(text: string): ParseUrlsResult {
  const urls: string[] = [];
  const invalid: { line: number; value: string }[] = [];
  const seen = new Set<string>();

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const tokens = lines[i].split(",");
    for (const token of tokens) {
      const value = token.trim();
      if (value === "") continue;
      if (isHttpUrl(value)) {
        if (!seen.has(value)) {
          seen.add(value);
          urls.push(value);
        }
      } else {
        invalid.push({ line: lineNumber, value });
      }
    }
  }

  return { urls, invalid };
}
