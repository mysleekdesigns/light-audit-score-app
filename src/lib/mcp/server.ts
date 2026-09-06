/**
 * Method dispatch for the stdio MCP server (ROADMAP Phase G).
 *
 * Pure request → response: hand it a parsed {@link JsonRpcMessage} and it
 * answers, or answers `null` for a notification. It never touches stdin, stdout
 * or a clock, which is what lets the whole handshake be unit-tested without
 * spawning a process — the same shape as `src/lib/http/localGate.ts`, where the
 * gate's decisions are a pure function and the server merely applies them.
 *
 * The method surface is deliberately the minimum a tools-only server needs:
 * `initialize`, `tools/list`, `tools/call`, `ping`, and the notifications a
 * client sends during the handshake. `resources/*` and `prompts/*` are absent
 * because their capabilities are not advertised, and answering "method not
 * found" is the correct, spec-conformant reply to a client that asks anyway.
 */

import {
  ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  errorResponse,
  isRequest,
  successResponse,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "@/lib/mcp/protocol";
import { toolArguments } from "@/lib/mcp/args";
import {
  McpToolError,
  errorResult,
  type McpTool,
  type McpToolResult,
} from "@/lib/mcp/types";

/** Identity this server reports at `initialize`. */
export interface McpServerInfo {
  name: string;
  title?: string;
  version: string;
}

export interface McpServerOptions {
  info: McpServerInfo;
  tools: readonly McpTool[];
  /**
   * Prose shown to the model once, at connection time. Worth spending: it is
   * where the *workflow* lives (audit, then check a budget or diff against a
   * stored run), which no single tool description can express on its own.
   */
  instructions?: string;
}

export interface McpServerHandle {
  /** Answer one message; `null` means "this was a notification, stay silent". */
  handle(message: JsonRpcMessage): Promise<JsonRpcResponse | null>;
  /** Whether the client has completed the handshake (for diagnostics/tests). */
  isInitialized(): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pick the protocol revision to answer with.
 *
 * Echo the client's when we know it; otherwise answer with our newest and let
 * the client decide whether it can live with that. Refusing the handshake over
 * an unrecognised date string would be the one failure mode that produces no
 * usable error anywhere — the server would simply never appear.
 */
function negotiateVersion(params: unknown): string {
  if (isRecord(params) && typeof params.protocolVersion === "string") {
    if (SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)) {
      return params.protocolVersion;
    }
  }
  return LATEST_PROTOCOL_VERSION;
}

/** The public half of a tool — everything except its implementation. */
function describeTool(tool: McpTool): Record<string, unknown> {
  const described: Record<string, unknown> = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
  if (tool.annotations) described.annotations = tool.annotations;
  return described;
}

/**
 * Create a dispatcher over a fixed tool set.
 *
 * The tool list is fixed at construction because it is: this server exposes four
 * tools that exist at build time, so there is no registration lifecycle, no
 * `notifications/tools/list_changed`, and no state a client could get out of
 * sync with.
 */
export function createMcpServer(options: McpServerOptions): McpServerHandle {
  const { info, tools, instructions } = options;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let initialized = false;

  /**
   * Run a tool call, containing every way it can fail.
   *
   * Three outcomes, and the distinction is the whole point:
   *  - a *dispatch* failure (unknown tool) is a JSON-RPC error — the call never
   *    happened, and there is no result for the model to reason about;
   *  - a {@link McpToolError} is a tool result with `isError`, because the model
   *    can fix a bad argument or a stale run id and try again;
   *  - anything else thrown is ALSO a tool result, with a deliberately generic
   *    message: an unexpected throw carries a stack and absolute paths, and the
   *    agent's context is not the place for either. The detail goes to stderr,
   *    where the client's logs keep it.
   */
  async function callTool(params: unknown): Promise<McpToolResult | "unknown_tool"> {
    const name = isRecord(params) ? params.name : undefined;
    if (typeof name !== "string") {
      return errorResult('A tools/call must name a tool in its "name" field.');
    }
    const tool = byName.get(name);
    if (!tool) return "unknown_tool";

    try {
      return await tool.handler(toolArguments(params));
    } catch (error) {
      if (error instanceof McpToolError) return errorResult(error.message);
      // Logged, not returned: see above.
      console.error(
        `[mcp] ${tool.name} threw:`,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      return errorResult(
        `${tool.name} failed unexpectedly. See the server's stderr log for details.`,
      );
    }
  }

  return {
    isInitialized: () => initialized,

    async handle(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
      const { method } = message;

      // Notifications first: they carry no id and MUST NOT be answered, whatever
      // they are. An unknown notification is silently ignored by design — the
      // spec's forward-compatibility rule, and the reason a newer client can
      // talk to this server without wedging on an unexpected reply.
      if (!isRequest(message)) {
        if (method === "notifications/initialized") initialized = true;
        return null;
      }

      const id = message.id;

      switch (method) {
        case "initialize":
          return successResponse(id, {
            protocolVersion: negotiateVersion(message.params),
            // Only what is implemented. `listChanged` is absent rather than
            // `false` for the same reason: the tool set is static, so there is
            // no notification to promise.
            capabilities: { tools: {} },
            serverInfo: info,
            ...(instructions ? { instructions } : {}),
          });

        case "ping":
          // The spec's liveness check: an empty result is the whole contract.
          return successResponse(id, {});

        case "tools/list":
          return successResponse(id, { tools: tools.map(describeTool) });

        case "tools/call": {
          const result = await callTool(message.params);
          if (result === "unknown_tool") {
            return errorResponse(
              id,
              ERROR_CODES.INVALID_PARAMS,
              `Unknown tool. This server exposes: ${[...byName.keys()].join(", ")}.`,
            );
          }
          return successResponse(id, result);
        }

        default:
          return errorResponse(
            id,
            ERROR_CODES.METHOD_NOT_FOUND,
            `Method not supported: ${method}`,
          );
      }
    },
  };
}
