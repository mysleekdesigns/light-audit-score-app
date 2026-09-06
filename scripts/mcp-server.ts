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
 * and the report files it reads are all on this machine. The transport is a pipe
 * rather than a socket for exactly that reason — there is nothing to bind, and
 * therefore nothing to reach.
 *
 * The one thing it does reach out to is the audit itself — **to a URL the AGENT
 * chose**, which is the honest phrasing and the difference from the CLI, where a
 * person types it (Phase G security re-review, M1). There is no host policy, so
 * loopback and private addresses are in range; what comes back is bounded to
 * scores, a final URL and audit ids, never a response body, so the exposure is
 * what an audit sends rather than what it returns. Two consequences are handled
 * below: `.env` is read for three data-location keys and nothing else, so no
 * ambient credential is available for a model to aim, and the forked worker gets
 * a filtered environment (`src/lib/queue/workerEnv.ts`) so the launching agent's
 * provider keys never reach the browser rendering the page.
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

import { readDotEnv } from "./dot-env.mjs";

import { createTools } from "@/lib/mcp/tools";
import {
  ERROR_CODES,
  encodeMessage,
  errorResponse,
  parseMessage,
  successResponse,
  type JsonRpcResponse,
} from "@/lib/mcp/protocol";
import { cancelActiveBatches } from "@/lib/mcp/activeBatches";
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

/**
 * The data-location variables from `.env`, and ONLY those.
 *
 * `chdir` alone was not enough, and the gap arrived by the documented route
 * (Phase G security re-review, M4). `next start` loads `.env` — Next does it
 * automatically — so a user who follows `.env.example` and sets `LH_DATA_DIR`
 * has an app writing there and, without this, an agent writing to `./data`
 * inside the checkout. Two archives, which is the one outcome this server is
 * built to prevent, produced by doing exactly what the docs say.
 *
 * **Three keys, not the whole file.** This process forks a worker that launches
 * Chrome against pages the model chose, and a fork inherits its parent's
 * environment; loading a `.env` full of provider keys into it would push every
 * one of them into the environment of the process rendering untrusted web
 * content. So the audit credentials in `.env` stay unread, and an agent's audits
 * are unauthenticated unless the variables are exported in the environment the
 * agent itself was launched from. That is the safer default anyway: the model
 * picks the URL, and an ambient credential it can aim is a credential it can
 * aim at a staging host on its own initiative. The README says so.
 *
 * A real environment variable always wins — `??=` only fills what is absent —
 * because an explicit export is a deliberate act and a file is a default.
 */
const DOT_ENV_KEYS = ["LH_DATA_DIR", "LH_DB_PATH", "LH_MIGRATIONS_DIR"] as const;
// Cast because `dot-env.mjs` is plain JavaScript with no declaration file; the
// shape is asserted here rather than inferred, and every read below is guarded.
const dotEnv = readDotEnv(path.join(projectRoot, ".env")) as Record<
  string,
  string | undefined
>;
for (const key of DOT_ENV_KEYS) {
  const value = dotEnv[key];
  if (typeof value === "string" && value !== "") process.env[key] ??= value;
}

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
 * Swallow `EPIPE` on stdout.
 *
 * The `try/catch` in `send` cannot do this on macOS, which is where this repo is
 * developed (Phase G security re-review, L3): Node's pipes are asynchronous on
 * macOS and synchronous on Linux and Windows, so a client that hangs up mid-write
 * delivers `EPIPE` as an `'error'` EVENT, long after `write()` returned. Unhandled,
 * that is an uncaught exception with a stack — precisely the outcome the catch
 * was written to prevent, on the one platform where the catch never fires.
 *
 * Both guards are kept: this one for the async platforms, the catch for the
 * synchronous ones.
 */
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") return;
  console.error("[mcp] stdout error:", error.message);
});

/**
 * Write one frame to stdout.
 *
 * `EPIPE` is swallowed: when the client goes away mid-write there is nobody left
 * to tell, and an unhandled error there would print a stack over the very stream
 * we are protecting. See the `'error'` handler above for the other half of this.
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

/** Longest single frame accepted from stdin. @see the ceiling check below. */
const MAX_FRAME_CHARS = 1_000_000;
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

  // A frame ceiling, because `readline` has none (Phase G security re-review,
  // L6): it buffers a line of any length in full before emitting it, and
  // `JSON.parse` would then double it. Every legitimate frame here is a handful
  // of small arguments — the payloads that are large travel the other way — so a
  // megabyte is generous by three orders of magnitude and still bounds the read.
  if (trimmed.length > MAX_FRAME_CHARS) {
    console.error(`[mcp] dropped a frame of ${trimmed.length} characters`);
    return;
  }

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
 * has gone. But exiting on its own would ORPHAN that child (Phase G security
 * re-review, L4): the worker has no disconnect handler and its kill-on-timeout
 * timer lives in this process, so a client restarting the server mid-audit —
 * which MCP clients do routinely — would leave a headless Chrome running until
 * its audit finished, with nothing left to read the result. Cancelling first
 * goes through the queue, which kills the worker children and leaves the runs
 * that DID finish in History; the same path Ctrl-C takes in the CLI.
 */
lines.on("close", () => {
  try {
    const cancelled = cancelActiveBatches();
    if (cancelled > 0) console.error(`[mcp] cancelled ${cancelled} in-flight audit(s)`);
  } catch (error) {
    // Never let cleanup keep the process alive: a failure here is a log line,
    // not a reason to hang on a pipe that is already closed.
    console.error(
      "[mcp] cancel on shutdown failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
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
