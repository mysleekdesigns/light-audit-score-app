/**
 * Wire-format tests for the hand-written JSON-RPC layer (ROADMAP Phase G).
 *
 * These matter more than their size suggests. The protocol is not vendored from
 * an SDK, so nothing else in the repo would notice if a frame stopped being
 * spec-shaped — and the failure mode is not a red test, it is an MCP client that
 * silently never lists a tool. So the cases below are the handshake's actual
 * contract: what counts as a request, what must never be answered, and what a
 * malformed frame is allowed to cost.
 */

import { describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  JSONRPC_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  clampErrorMessage,
  encodeMessage,
  errorResponse,
  isRequest,
  parseMessage,
  successResponse,
} from "@/lib/mcp/protocol";

describe("parseMessage", () => {
  it("parses a request and keeps its id", () => {
    const result = parseMessage('{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.method).toBe("tools/list");
    expect(isRequest(result.message)).toBe(true);
    expect(result.message.id).toBe(7);
  });

  it("parses a notification as a message with NO id", () => {
    // The distinction the whole handshake turns on: answering
    // `notifications/initialized` is a classic way to wedge a client.
    const result = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isRequest(result.message)).toBe(false);
    expect("id" in result.message).toBe(false);
  });

  it("does not mistake an explicit null id for a notification", () => {
    // `id: null` is legal JSON-RPC and MCP forbids it for requests. We treat it
    // as a request anyway and echo the null back, because the alternative —
    // silence — leaves a client waiting forever with nothing to log.
    const result = parseMessage('{"jsonrpc":"2.0","id":null,"method":"ping"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isRequest(result.message)).toBe(true);
    expect(result.message.id).toBeNull();
  });

  it("rejects invalid JSON, arrays, non-objects and a wrong version", () => {
    expect(parseMessage("not json")).toMatchObject({
      ok: false,
      code: ERROR_CODES.PARSE_ERROR,
    });
    expect(parseMessage('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).toMatchObject({
      ok: false,
      code: ERROR_CODES.INVALID_REQUEST,
    });
    expect(parseMessage('"a string"')).toMatchObject({
      ok: false,
      code: ERROR_CODES.INVALID_REQUEST,
    });
    expect(parseMessage('{"jsonrpc":"1.0","id":1,"method":"ping"}')).toMatchObject({
      ok: false,
      code: ERROR_CODES.INVALID_REQUEST,
    });
  });

  it("rejects a missing or empty method", () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1}')).toMatchObject({ ok: false });
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"method":""}')).toMatchObject({
      ok: false,
    });
  });

  it("recovers the id from a frame it is rejecting", () => {
    // Worth the effort: with the right id the client settles its pending
    // promise; with `null` it waits for a reply that never comes.
    const result = parseMessage('{"jsonrpc":"1.0","id":"abc","method":"ping"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.id).toBe("abc");
  });

  it("treats an unusable id as absent rather than echoing it back", () => {
    const result = parseMessage('{"jsonrpc":"1.0","id":{"nested":true},"method":"ping"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.id).toBeNull();
  });
});

describe("encodeMessage", () => {
  it("emits exactly one line, newline-terminated", () => {
    const frame = encodeMessage(successResponse(1, { tools: [] }));
    expect(frame.endsWith("\n")).toBe(true);
    expect(frame.trimEnd().includes("\n")).toBe(false);
  });

  it("escapes embedded newlines rather than emitting them", () => {
    // The stdio transport's one hard rule. It holds structurally because
    // JSON.stringify escapes control characters — this test exists so that
    // property is not quietly lost to a future "optimisation".
    const frame = encodeMessage(
      successResponse(1, { text: "line one\nline two\r\nthree" }),
    );
    expect(frame.split("\n")).toHaveLength(2);
    const parsed: unknown = JSON.parse(frame);
    expect(parsed).toMatchObject({ result: { text: "line one\nline two\r\nthree" } });
  });
});

describe("errorResponse", () => {
  it("clamps a message that quotes caller text", () => {
    const response = errorResponse(1, ERROR_CODES.METHOD_NOT_FOUND, "x".repeat(5_000));
    expect(response.error.message.length).toBeLessThanOrEqual(200);
    expect(response.jsonrpc).toBe(JSONRPC_VERSION);
  });

  it("collapses whitespace so a crafted method name cannot forge log lines", () => {
    expect(clampErrorMessage("a\nb\tc  d")).toBe("a b c d");
  });

  it("strips the bidi class from an error, not just the control class", () => {
    // Phase G security review, M1: the error path used to strip C0/C1 only, so a
    // refused `…/gnp.exe` reached the transcript reading as `…/exe.png`.
    expect(clampErrorMessage("Not a URL: ftp://x.test/\u202egnp.exe")).toBe(
      "Not a URL: ftp://x.test/gnp.exe",
    );
    expect(clampErrorMessage("a\u200bb\u2069")).toBe("ab");
  });
});

describe("protocol versions", () => {
  it("advertises the newest supported revision first", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(LATEST_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2024-11-05");
  });
});
