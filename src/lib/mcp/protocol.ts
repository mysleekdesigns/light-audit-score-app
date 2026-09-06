/**
 * JSON-RPC 2.0 framing for the stdio MCP server (ROADMAP Phase G).
 *
 * **Why this is hand-written rather than `@modelcontextprotocol/sdk`.** The SDK
 * exists to serve every transport MCP defines, so it depends on `express`,
 * `hono`, `cors`, `jose` and `eventsource` — an HTTP server and an OAuth stack —
 * to expose four local tools over a pipe. Phase G's security clause is "must not
 * open a port"; the strongest way to keep that promise is for nothing in the
 * import graph to be *able* to. What is actually needed here is line-delimited
 * JSON-RPC, which is small enough to own, and owning it makes the guarantee
 * auditable by reading one directory instead of a lockfile.
 *
 * The same argument the repo already made for `src/lib/http/localGate.ts`
 * applies, and so does its discipline: this module imports no Node built-in and
 * no dependency — only the pure text pipeline next door — so it is exhaustively
 * unit-testable and cannot acquire an I/O side effect by accident. (`./text` is
 * itself import-free for exactly this reason: the Phase G security review, M1,
 * found the error path here stripping controls but not the bidi class, and a
 * shared sanitiser the wire format cannot import is one that gets re-implemented
 * weakly.) Transport (stdin/stdout) lives in
 * `scripts/mcp-server.ts`; dispatch lives in `./server`; this file is only the
 * wire format.
 *
 * Spec: JSON-RPC 2.0, and MCP's stdio transport — messages are UTF-8, delimited
 * by newlines, and **must not contain embedded newlines**.
 */

import { safeText } from "@/lib/text/displaySafe";

/** The only JSON-RPC version MCP speaks. */
export const JSONRPC_VERSION = "2.0";

/**
 * MCP protocol revisions this server can speak, newest first.
 *
 * Negotiation (see `initialize` in `./server`) echoes the client's requested
 * version when it appears here, and otherwise answers with the newest we
 * support — which is what the spec asks for, and what lets an older client keep
 * working instead of failing a handshake over a date string.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** The revision advertised when the client asks for one we don't know. */
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * A JSON-RPC id. `null` is legal on the wire but MCP forbids it for requests;
 * we accept it defensively and only ever echo it back.
 */
export type JsonRpcId = string | number | null;

/** A request (has an `id`) or a notification (does not). */
export interface JsonRpcMessage {
  jsonrpc: typeof JSONRPC_VERSION;
  /** Absent for notifications — the one bit that decides whether we reply. */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A successful response. */
export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

/** An error response. */
export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/**
 * Standard JSON-RPC error codes.
 *
 * `INVALID_PARAMS` is the one with a judgement call attached: a tool that runs
 * and fails reports that as a *tool* result (`isError: true`), not as a protocol
 * error, so the agent can read the reason and adapt. A protocol error means the
 * call could not be dispatched at all — an unknown tool, a malformed frame.
 */
export const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Longest untrusted text echoed into an error body. */
const MAX_ERROR_MESSAGE = 200;

/**
 * Clean and clamp a message that may quote caller-supplied text.
 *
 * Same reasoning as the CI reporters: a client controls the method name and the
 * params, and an unbounded echo turns one bad frame into an unbounded write on a
 * pipe the agent is paying to read. The bidi/invisible strip matters here for
 * the same reason it matters in a payload — an error is still an echo, and this
 * one lands in a transcript a person may read (Phase G security review, M1).
 */
export function clampErrorMessage(value: string): string {
  return safeText(value, MAX_ERROR_MESSAGE);
}

/** A frame that could not be turned into a dispatchable message. */
export interface ParseFailure {
  ok: false;
  /** The id to answer with, when one could still be recovered from the frame. */
  id: JsonRpcId;
  code: number;
  message: string;
}

export type ParseResult = { ok: true; message: JsonRpcMessage } | ParseFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recover an id from a frame we are about to reject.
 *
 * Worth the effort: a response with the right id lets the client settle its
 * pending promise, while a `null` id leaves it waiting for a reply that will
 * never come. Only the two legal id types are accepted — anything else is
 * treated as absent rather than echoed back as-is.
 */
function recoverId(value: unknown): JsonRpcId {
  if (!isRecord(value)) return null;
  const { id } = value;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

/**
 * Parse one line of the stdio stream into a message.
 *
 * Blank lines are not an error — a client that writes `\r\n` or pads its frames
 * is well within the transport — so they yield a `PARSE_ERROR` only when they
 * carry non-whitespace that is not JSON. The caller skips empty lines before
 * reaching here (see `scripts/mcp-server.ts`); this stays total anyway.
 *
 * Batches (a top-level JSON array) are rejected deliberately: MCP's 2025-06-18
 * revision removed them, and accepting one would mean a second, barely-exercised
 * code path through dispatch for a shape no supported client sends.
 */
export function parseMessage(line: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      ok: false,
      id: null,
      code: ERROR_CODES.PARSE_ERROR,
      message: "Invalid JSON was received by the server.",
    };
  }

  if (Array.isArray(parsed)) {
    return {
      ok: false,
      id: null,
      code: ERROR_CODES.INVALID_REQUEST,
      message: "Batched requests are not supported.",
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      id: null,
      code: ERROR_CODES.INVALID_REQUEST,
      message: "A message must be a JSON object.",
    };
  }

  const id = recoverId(parsed);
  if (parsed.jsonrpc !== JSONRPC_VERSION) {
    return {
      ok: false,
      id,
      code: ERROR_CODES.INVALID_REQUEST,
      message: `Unsupported jsonrpc version; expected "${JSONRPC_VERSION}".`,
    };
  }
  if (typeof parsed.method !== "string" || parsed.method === "") {
    return {
      ok: false,
      id,
      code: ERROR_CODES.INVALID_REQUEST,
      message: "A message must carry a non-empty method.",
    };
  }

  const message: JsonRpcMessage = {
    jsonrpc: JSONRPC_VERSION,
    method: parsed.method,
    params: parsed.params,
  };
  // Present only when the frame actually had one: `isRequest` reads this key's
  // presence, so writing `id: undefined` here would make every notification look
  // like a request awaiting a reply.
  if ("id" in parsed && parsed.id !== undefined) message.id = id;
  return { ok: true, message };
}

/**
 * Whether a message expects a response.
 *
 * A notification carries no id and MUST NOT be answered — replying to
 * `notifications/initialized` is the classic way to wedge a handshake.
 */
export function isRequest(
  message: JsonRpcMessage,
): message is JsonRpcMessage & { id: JsonRpcId } {
  return "id" in message && message.id !== undefined;
}

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  const error: JsonRpcFailure["error"] = { code, message: clampErrorMessage(message) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

/**
 * Serialize a response as one transport frame.
 *
 * `JSON.stringify` escapes every control character, so the "no embedded
 * newlines" rule holds structurally — there is no sanitisation step to forget.
 * The trailing `\n` is the delimiter itself and belongs to the frame, not to the
 * writer.
 */
export function encodeMessage(message: JsonRpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}
