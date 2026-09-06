/**
 * LightAudit Score as an MCP server — stdio transport (ROADMAP Phase G).
 *
 * Run it the way every other script in this repo runs, under Node's native
 * TypeScript type-stripping and the `@/` alias hook — never `tsx`, whose esbuild
 * `keepNames` injects `__name` wrappers that Lighthouse then evaluates inside
 * the page (README → Requirements):
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --import ./scripts/alias-hooks.mjs scripts/mcp-server.ts
 *
 * which is exactly what `npm run mcp` does, and what the `.mcp.json` snippet in
 * the README hands to an agent.
 *
 * **What this process is, and is not.** It is a local child process speaking
 * JSON-RPC over a pipe to whoever launched it. It opens no port, reads no
 * session token, and holds no third-party credential: the audit engine, SQLite
 * and the report files it reads are all on this machine, and the only outbound
 * request it can make is the audit itself, to a URL the caller named. The
 * transport is a pipe rather than a socket for exactly that reason — there is
 * nothing to bind, and therefore nothing to reach.
 *
 * **Two invariants this file exists to hold.**
 *
 *  1. *stdout carries frames and nothing else.* A single stray `console.log`
 *     anywhere in the import graph corrupts the stream and the client drops the
 *     connection. So this file writes only through `send()`, and every
 *     diagnostic — ours and any library's — goes to stderr, where the client
 *     keeps it as a log.
 *  2. *The agent's audits land in the SAME archive as the app's.* An MCP client
 *     launches its servers from ITS cwd, not from the project, and this repo
 *     resolves `./data`, `./drizzle` and the forked audit worker relative to the
 *     process cwd. Left alone, an agent's runs would accumulate in a second,
 *     invisible database — which would quietly destroy the one thing this phase
 *     is for: comparing today's page against months of your own baselines. So
 *     the process moves itself to the project root at startup (see `chdir`
 *     below); an explicit `LH_DATA_DIR` still wins, because that override exists
 *     for people who deliberately keep their data elsewhere.
 */

import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTools } from "@/lib/mcp/tools";
import {
  ERROR_CODES,
  encodeMessage,
  errorResponse,
  parseMessage,
  successResponse,
  type JsonRpcResponse,
} from "@/lib/mcp/protocol";
import { createMcpServer } from "@/lib/mcp/server";
import { errorResult } from "@/lib/mcp/types";

/**
 * The workflow, told to the model once at connection time.
 *
 * Deliberately short and about *sequencing*, which no single tool description
 * can express: the tools are individually obvious, and the useful thing is
 * knowing that a run id from one is the input to the next, and that the history
 * is the point.
 */
const INSTRUCTIONS = `Lighthouse audits from this machine, backed by a local audit history.

Typical loop while developing: run audit_url against your dev server, then either
check_budget (does it clear the bar?) or compare_runs against an earlier run id
from get_history (what changed, and why did the score move?).

audit_url launches headless Chrome and takes ~15-60s per run; the other three
read what is already on disk and are effectively free. Every audit is archived
alongside the ones run from the app's own UI, so history accumulates across
sessions.`;

/** The project root, derived from this file rather than from the cwd. */
const projectRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

/**
 * Anchor the process to the project.
 *
 * See invariant 2 in the module docblock. It runs here — before a transport
 * exists, so before any tool can be dispatched — and that is early enough
 * because every cwd-relative path in this repo is resolved from a FUNCTION, not
 * a module constant: `getDataDir()`, `getMigrationsDir()` (`src/lib/db/paths.ts`)
 * and the worker's `resolveScript` (`src/lib/queue/runAuditWorker.ts`) all read
 * the cwd at call time. Imports being hoisted above this line therefore changes
 * nothing; a module that resolved a path at import time would break the
 * invariant, which is worth knowing if one ever appears.
 */
process.chdir(projectRoot);

const server = createMcpServer({
  info: {
    name: "lightaudit",
    title: "LightAudit Score",
    version: "0.1.0",
  },
  tools: createTools(),
  instructions: INSTRUCTIONS,
});

/**
 * Write one frame to stdout.
 *
 * `EPIPE` is swallowed: when the client goes away mid-write there is nobody left
 * to tell, and an unhandled error event there would print a stack over the very
 * stream we are protecting.
 */
function send(response: JsonRpcResponse): void {
  try {
    process.stdout.write(encodeMessage(response));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
  }
}

/**
 * Line-delimited framing.
 *
 * `readline` handles both `\n` and `\r\n`, and buffers a partial line across
 * chunk boundaries — which matters because a `tools/call` result of a few
 * kilobytes arrives split, and hand-rolled splitting on `data` events is where
 * that goes wrong.
 */
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

/**
 * How many `tools/call` dispatches may be outstanding at once.
 *
 * Dispatch is NOT awaited (see below), which is what keeps the server
 * answerable during a minute-long audit — and also what lets a client with a
 * fast loop put unbounded work in flight. `compare_runs` holds two parsed
 * Lighthouse reports live per call, so ten concurrent calls is twenty of them;
 * the halved per-report cap it inherited from the diff route was sized for a
 * Next handler, where the framework bounds concurrency, and nothing bounds it
 * here (Phase G security review, M2).
 *
 * Four, because the useful parallelism is small: one slow `audit_url` plus a
 * couple of cheap reads is the actual workflow, and an agent that wants a fifth
 * can wait for one to land.
 */
const MAX_IN_FLIGHT_CALLS = 4;
let inFlightCalls = 0;

/**
 * Dispatch is NOT awaited here, deliberately.
 *
 * `audit_url` runs for the better part of a minute, and JSON-RPC ids exist
 * precisely so a client can have several calls outstanding. Awaiting each line
 * before reading the next would make the whole server unresponsive for the
 * duration of an audit — an agent could not even list tools while one ran. Each
 * response carries its own id, so out-of-order completion is exactly what the
 * protocol expects.
 */
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;

  const parsed = parseMessage(trimmed);
  if (!parsed.ok) {
    // A malformed *notification* has no id to answer; replying with a null-id
    // error to something that was never a request is noise the client cannot
    // route. Answering only when an id was recovered is the useful half.
    if (parsed.id !== null) send(errorResponse(parsed.id, parsed.code, parsed.message));
    else console.error(`[mcp] dropped an unparseable frame: ${parsed.message}`);
    return;
  }

  // The ceiling applies to `tools/call` alone. `initialize`, `ping` and
  // `tools/list` stay answerable no matter how much work is queued, which is the
  // whole reason dispatch is concurrent — refusing them under load would trade
  // one problem for a worse one.
  const isToolCall = parsed.message.method === "tools/call";
  if (isToolCall && inFlightCalls >= MAX_IN_FLIGHT_CALLS) {
    const { id } = parsed.message;
    // A result, not a protocol error: this is a condition the agent can act on
    // by waiting, and it should read it the same way it reads any other tool
    // outcome.
    if (id !== undefined) {
      send(
        successResponse(
          id,
          errorResult(
            `Too many calls in flight (${MAX_IN_FLIGHT_CALLS}). Wait for the current audit to finish, then retry.`,
          ),
        ),
      );
    }
    return;
  }
  if (isToolCall) inFlightCalls += 1;

  void server
    .handle(parsed.message)
    .then((response) => {
      if (response) send(response);
    })
    .catch((error: unknown) => {
      // The dispatcher contains tool failures itself, so reaching here means a
      // fault in dispatch. Answer the request (a client waiting forever is the
      // worse outcome) and keep the detail on stderr.
      console.error(
        "[mcp] dispatch failed:",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      const { id } = parsed.message;
      if (id !== undefined) {
        send(
          errorResponse(id, ERROR_CODES.INTERNAL_ERROR, "The server failed to handle that request."),
        );
      }
    })
    .finally(() => {
      // In `finally`, so a dispatch that threw still gives its slot back. A
      // counter that only decrements on success would wedge the server after
      // four faults.
      if (isToolCall) inFlightCalls -= 1;
    });
});

/**
 * stdin closing is the client hanging up: it is the normal way this process
 * ends, so exit 0 rather than treating it as a fault.
 *
 * `process.exit` rather than a natural drain, because a Chrome child from an
 * in-flight audit can keep the loop alive long after the agent that asked for it
 * has gone.
 */
lines.on("close", () => {
  process.exit(0);
});

/**
 * Last-resort containment.
 *
 * A tool that rejects outside the dispatcher's reach must not take the server
 * down mid-session — the client would see the pipe close with no explanation and
 * every pending call would hang. Log it and keep serving.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    "[mcp] unhandled rejection:",
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  );
});
