/**
 * The tool contract the MCP server dispatches against (ROADMAP Phase G).
 *
 * Frozen seam, in the sense `src/lib/queue/types.ts` and `src/lib/ci/types.ts`
 * are: the four tool modules under `./tools/` implement it, `./server` consumes
 * it, and neither knows anything else about the other. Its only import is the
 * pure text pipeline next door, so a tool module can be unit-tested by calling
 * its handler directly — no pipe, no process, no client.
 *
 * **Payload discipline is part of the contract.** The plan's words are "keep the
 * tool surface small and the payloads compact — an agent pays for every token of
 * a Lighthouse report". So every tool here returns a bounded projection, never
 * an LHR: scores and metrics, a capped list of runs, a capped diff. The full
 * report stays where it already is — on disk, and in the app.
 */

import { safeText } from "@/lib/text/displaySafe";

/**
 * JSON Schema for a tool's arguments.
 *
 * Written as an object literal per tool rather than generated from zod. The
 * schema crosses the wire to the agent verbatim, so it is prose the model reads
 * as much as it is validation — and the validation itself happens in the handler
 * (see `./args`), because a client is free to send anything regardless of what
 * we published.
 */
export interface McpInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  /**
   * Always `false` here: an unexpected key is far more often a model's near-miss
   * guess at a parameter name than something to ignore silently, and a schema
   * that says so lets the client catch it before the call.
   */
  additionalProperties?: boolean;
}

/** The only content type these tools emit. */
export interface McpTextContent {
  type: "text";
  text: string;
}

/**
 * A tool call's result.
 *
 * Both halves are always populated by {@link jsonResult}: `structuredContent` is
 * what a modern client parses, and the same object serialized into `content` is
 * what every client (and every model reading a transcript) can still read. That
 * duplication is the spec's own back-compat guidance, and it costs nothing here
 * because the payloads are small by design.
 */
export interface McpToolResult {
  content: McpTextContent[];
  structuredContent?: Record<string, unknown>;
  /**
   * `true` when the tool ran and failed. Deliberately NOT a JSON-RPC error: the
   * agent should see "that URL refused the connection" as a readable result it
   * can act on, not as a transport fault that aborts its turn.
   */
  isError?: boolean;
}

/**
 * Behavioural hints published with each tool.
 *
 * Only the ones that are honest here. `readOnlyHint` is the load-bearing one:
 * three of the four tools only read what is already on disk, and an agent that
 * knows that can call them freely, while `audit_url` launches Chrome and writes
 * a run to History.
 */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /**
   * `true` for `audit_url` alone: it fetches a URL the caller chose, which is the
   * one place this server touches anything outside the local machine.
   */
  openWorldHint?: boolean;
}

/** One tool: its published description and its implementation. */
export interface McpTool {
  /** Wire name, e.g. `audit_url`. */
  name: string;
  /** Human label for a picker UI. */
  title: string;
  /** What it does, why an agent would call it, and what it costs. */
  description: string;
  inputSchema: McpInputSchema;
  annotations?: McpToolAnnotations;
  /**
   * Run the tool.
   *
   * Receives the raw `arguments` object as it arrived — validation is the
   * handler's own job (`./args`). Throw {@link McpToolError} for anything the
   * caller can fix; a handler that throws anything else is still contained by
   * the dispatcher, which reports it as a tool error rather than letting it
   * escape as an unhandled rejection.
   */
  handler(args: Record<string, unknown>): Promise<McpToolResult>;
}

/**
 * An error the caller can act on: a missing argument, an unknown run id, a URL
 * that would not load. Its message reaches the agent verbatim, so write it as
 * advice ("no runs found for that URL — audit it first"), not as a stack trace.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * Longest tool-error text handed back to the agent.
 *
 * Generous next to the protocol's own 200, because this string is the whole
 * explanation of a failed audit (a Chrome error, a DNS failure) and truncating
 * it to a phrase would cost the agent the one fact it needs. Still bounded: some
 * of these messages quote page-derived text.
 */
export const MAX_TOOL_ERROR_CHARS = 600;

/**
 * A payload as both structured content and its serialized text.
 *
 * `JSON.stringify` with no spacing on purpose — pretty-printing a scores object
 * spends tokens on whitespace in a context window the plan explicitly asks us to
 * respect.
 */
export function jsonResult(payload: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * A failed tool call, as a result the agent can read.
 *
 * Through `safeText`, not a local collapse-and-clamp — this is the funnel every
 * tool error passes through, and the Phase G security review (M1) found it was
 * the weaker of the two strips in the tree: it collapsed whitespace but let the
 * bidi class through, so a refused URL could carry an RTL override into the
 * transcript and read as `…/exe.png` while the model reasoned about `…/gnp.exe`.
 * Error text quotes caller and page input as freely as any payload does, so it
 * gets the same treatment as one.
 */
export function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: safeText(message, MAX_TOOL_ERROR_CHARS) }],
    isError: true,
  };
}
