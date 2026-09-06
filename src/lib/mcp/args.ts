/**
 * Argument readers shared by every MCP tool (ROADMAP Phase G).
 *
 * A published `inputSchema` is documentation, not enforcement: the client is
 * free to send anything, and the model on the other end of it guesses parameter
 * names for a living. So each handler validates what it actually received — and
 * does it through *these* readers rather than its own, so four tools cannot end
 * up with four dialects of "that argument is wrong".
 *
 * Every rejection message is written to be *read by a model mid-turn*: it names
 * the argument, says what was expected, and is phrased so the obvious next move
 * is a corrected call rather than an apology to the user. That is why the type
 * name is spelled out ("must be a string") instead of dumping the value: the
 * value can be arbitrary caller text, and echoing it into a transcript is how a
 * tool result starts forging conversation.
 *
 * Dependency-free by the same rule as `./protocol` — no zod, no Node built-ins.
 */

import { McpToolError } from "@/lib/mcp/types";

/** Longest caller-supplied string any tool accepts, before its own tighter cap. */
export const MAX_ARG_CHARS = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `arguments` object of a `tools/call`, or an empty one.
 *
 * MCP allows `arguments` to be omitted entirely for a tool with no required
 * parameters, so absence is normal input, not an error. A non-object *present*
 * is an error — that is a client bug, and silently treating it as `{}` would
 * turn it into a confusing "missing url" complaint about a call that did pass
 * one.
 */
export function toolArguments(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) return {};
  const args = params.arguments;
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) {
    throw new McpToolError('The "arguments" field must be a JSON object.');
  }
  return args;
}

/**
 * Reject keys the tool does not accept.
 *
 * The schemas say `additionalProperties: false`, and this is what makes that
 * true at the door. It is a real kindness to the caller: a model that sends
 * `page_url` instead of `url` gets told the name it invented and the names that
 * exist, in one round trip, instead of a puzzling "url is required" for a call
 * that plainly contains a URL.
 */
export function rejectUnknownArgs(
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new McpToolError(
    `Unknown argument(s): ${unknown.map(quoteKey).join(", ")}. ` +
      `This tool accepts: ${allowed.map((key) => `"${key}"`).join(", ")}.`,
  );
}

/**
 * A key name, quoted for a message.
 *
 * The key comes from the caller, so it is clamped and stripped like any other
 * echo — an argument name is untrusted text that happens to look like an
 * identifier.
 */
function quoteKey(key: string): string {
  const cleaned = [...key]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const clamped = cleaned.length > 40 ? `${cleaned.slice(0, 39)}…` : cleaned;
  return `"${clamped}"`;
}

/** Read a required string. */
export function requireString(
  args: Record<string, unknown>,
  key: string,
  maxChars = MAX_ARG_CHARS,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpToolError(`"${key}" is required and must be a non-empty string.`);
  }
  if (value.length > maxChars) {
    throw new McpToolError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

/** Read an optional string; `undefined` when absent. */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
  maxChars = MAX_ARG_CHARS,
): string | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  return requireString(args, key, maxChars);
}

/**
 * Read an optional bounded integer.
 *
 * Out of range is a rejection, not a clamp. The queue clamps concurrency because
 * nobody typed it on purpose; here the caller stated a number, and silently
 * auditing 3 times when it asked for 50 would make the result it reads back a
 * quiet lie.
 */
export function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number },
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new McpToolError(`"${key}" must be an integer.`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new McpToolError(
      `"${key}" must be between ${bounds.min} and ${bounds.max}.`,
    );
  }
  return value;
}

/** Read an optional value from a fixed set. */
export function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new McpToolError(
      `"${key}" must be one of: ${values.map((v) => `"${v}"`).join(", ")}.`,
    );
  }
  return value as T;
}

/** Read an optional array of values from a fixed set (deduped, order kept). */
export function optionalEnumArray<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new McpToolError(`"${key}" must be a non-empty array.`);
  }
  const out: T[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(values as readonly string[]).includes(entry)) {
      throw new McpToolError(
        `"${key}" accepts only: ${values.map((v) => `"${v}"`).join(", ")}.`,
      );
    }
    if (!out.includes(entry as T)) out.push(entry as T);
  }
  return out;
}

/**
 * Read an optional object of `{ key: number }` pairs.
 *
 * Only the shape is checked here. WHICH keys are valid and what the numbers may
 * be is `resolveBudgets`' answer, not this file's — the budget rules (unknown
 * category is a hard error, 0–100, canonical ordering) already exist and are
 * tested, and a second copy of them here is exactly the fork Phase G forbids.
 */
export function optionalNumberRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, number> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new McpToolError(`"${key}" must be an object of category → number.`);
  }
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new McpToolError(
        `"${key}" values must be numbers (${quoteKey(name)} was not).`,
      );
    }
    out[name] = entry;
  }
  return out;
}

/** Read an optional boolean. */
export function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new McpToolError(`"${key}" must be true or false.`);
  }
  return value;
}
