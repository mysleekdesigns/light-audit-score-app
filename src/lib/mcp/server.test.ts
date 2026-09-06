/**
 * Dispatch tests for the MCP server (ROADMAP Phase G).
 *
 * The handshake, in a unit test. This is the payoff of keeping dispatch a pure
 * request → response function: the sequence a real client performs
 * (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`) is
 * asserted here in milliseconds, and the live `claude mcp get` check at the end
 * of the phase is confirmation rather than the only evidence.
 *
 * The failure-containment cases are the ones worth reading. A tool that throws
 * must never look like a transport fault: an agent that receives a JSON-RPC
 * error learns only that something broke, while an `isError` result carries a
 * sentence it can act on.
 */

import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES, type JsonRpcMessage } from "@/lib/mcp/protocol";
import { createMcpServer } from "@/lib/mcp/server";
import { McpToolError, jsonResult, type McpTool } from "@/lib/mcp/types";

function request(method: string, params?: unknown, id: number | string = 1): JsonRpcMessage {
  return { jsonrpc: "2.0", id, method, params };
}

function notification(method: string, params?: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", method, params };
}

const okTool: McpTool = {
  name: "ok_tool",
  title: "OK",
  description: "Returns what it was given.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args) => jsonResult({ echoed: args.value ?? null }),
};

const failingTool: McpTool = {
  name: "failing_tool",
  title: "Fails",
  description: "Always rejects its input.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    throw new McpToolError("Pass a url — that argument is required.");
  },
};

const explodingTool: McpTool = {
  name: "exploding_tool",
  title: "Explodes",
  description: "Throws something that is not an McpToolError.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    throw new TypeError("cannot read properties of undefined (reading 'secretPath')");
  },
};

function makeServer() {
  return createMcpServer({
    info: { name: "test-server", version: "0.0.0" },
    tools: [okTool, failingTool, explodingTool],
    instructions: "Use ok_tool.",
  });
}

describe("handshake", () => {
  it("answers initialize with capabilities, identity and instructions", async () => {
    const server = makeServer();
    const response = await server.handle(
      request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    );
    expect(response).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "test-server", version: "0.0.0" },
        instructions: "Use ok_tool.",
      },
    });
  });

  it("echoes a supported protocol version and falls back for an unknown one", async () => {
    const server = makeServer();
    const old = await server.handle(request("initialize", { protocolVersion: "2024-11-05" }));
    expect(old).toMatchObject({ result: { protocolVersion: "2024-11-05" } });

    // A client from the future must not be refused: an unrecognised date string
    // answered with our newest lets it decide, while a rejected handshake
    // produces a server that simply never appears.
    const future = await server.handle(request("initialize", { protocolVersion: "2099-01-01" }));
    expect(future).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  });

  it("stays silent on every notification, and records initialization", async () => {
    const server = makeServer();
    expect(server.isInitialized()).toBe(false);
    expect(await server.handle(notification("notifications/initialized"))).toBeNull();
    expect(server.isInitialized()).toBe(true);
    // Forward compatibility: an unknown notification is ignored, never answered.
    expect(await server.handle(notification("notifications/from/the/future"))).toBeNull();
  });

  it("answers ping with an empty result", async () => {
    const server = makeServer();
    expect(await server.handle(request("ping"))).toMatchObject({ id: 1, result: {} });
  });
});

describe("tools/list", () => {
  it("publishes every tool without its implementation", async () => {
    const server = makeServer();
    const response = await server.handle(request("tools/list"));
    const tools = (response as { result: { tools: Record<string, unknown>[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "ok_tool",
      "failing_tool",
      "exploding_tool",
    ]);
    expect(tools[0]).toMatchObject({
      title: "OK",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { readOnlyHint: true },
    });
    // The handler must not cross the wire.
    expect(tools[0]).not.toHaveProperty("handler");
  });
});

describe("tools/call", () => {
  it("returns the tool's result, with both structured and text content", async () => {
    const server = makeServer();
    const response = await server.handle(
      request("tools/call", { name: "ok_tool", arguments: { value: "hello" } }),
    );
    expect(response).toMatchObject({
      result: {
        content: [{ type: "text", text: '{"echoed":"hello"}' }],
        structuredContent: { echoed: "hello" },
      },
    });
  });

  it("treats omitted arguments as an empty object", async () => {
    // MCP allows `arguments` to be absent for a tool with no required
    // parameters; absence is input, not an error.
    const server = makeServer();
    const response = await server.handle(request("tools/call", { name: "ok_tool" }));
    expect(response).toMatchObject({ result: { structuredContent: { echoed: null } } });
  });

  it("reports a tool's own failure as an isError RESULT, not a protocol error", async () => {
    const server = makeServer();
    const response = await server.handle(request("tools/call", { name: "failing_tool" }));
    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: "Pass a url — that argument is required." }],
      },
    });
    expect(response).not.toHaveProperty("error");
  });

  it("contains an unexpected throw and does not leak its detail to the agent", async () => {
    const server = makeServer();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await server.handle(request("tools/call", { name: "exploding_tool" }));
    const text = (response as { result: { content: { text: string }[] } }).result.content[0].text;
    expect(text).toContain("exploding_tool failed unexpectedly");
    // A stack carries absolute paths and internal names; the agent's context is
    // not the place for either. It goes to stderr, where the client logs it.
    expect(text).not.toContain("secretPath");
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("strips the bidi class from a tool error before the agent sees it", async () => {
    // Phase G security review, M1. `errorResult` is the funnel every tool error
    // passes through, so this is the one place the class has to be closed.
    const server = createMcpServer({
      info: { name: "test-server", version: "0.0.0" },
      tools: [
        {
          ...failingTool,
          handler: async () => {
            throw new McpToolError("Only http and https: ftp://x.test/\u202egnp.exe");
          },
        },
      ],
    });
    const response = await server.handle(request("tools/call", { name: "failing_tool" }));
    const { text } = (response as { result: { content: { text: string }[] } }).result.content[0];
    expect(text).toBe("Only http and https: ftp://x.test/gnp.exe");
  });

  it("rejects an unknown tool as a protocol error naming what exists", async () => {
    const server = makeServer();
    const response = await server.handle(request("tools/call", { name: "no_such_tool" }));
    expect(response).toMatchObject({
      error: { code: ERROR_CODES.INVALID_PARAMS },
    });
    expect((response as { error: { message: string } }).error.message).toContain("ok_tool");
  });

  it("rejects a call with no tool name", async () => {
    const server = makeServer();
    const response = await server.handle(request("tools/call", {}));
    expect(response).toMatchObject({ result: { isError: true } });
  });

  it("rejects a non-object arguments field", async () => {
    const server = makeServer();
    const response = await server.handle(
      request("tools/call", { name: "ok_tool", arguments: "not an object" }),
    );
    expect(response).toMatchObject({ result: { isError: true } });
  });
});

describe("unsupported methods", () => {
  it("answers method-not-found for capabilities this server does not advertise", async () => {
    const server = makeServer();
    for (const method of ["resources/list", "prompts/list", "completion/complete"]) {
      expect(await server.handle(request(method))).toMatchObject({
        error: { code: ERROR_CODES.METHOD_NOT_FOUND },
      });
    }
  });
});
