/**
 * Process-isolated audit runner (PRD §6 Phase 2).
 *
 * The audit queue must run several URLs concurrently (its whole purpose), but
 * Lighthouse keeps its `lh:runner:*` performance marks in PROCESS-GLOBAL state,
 * so two concurrent in-process `lighthouse()` calls corrupt each other
 * (`The "start lh:runner:gather" performance mark has not been set`). The fix —
 * matching how Unlighthouse achieves real concurrency (PRD §3) — is to run each
 * audit job in its OWN forked Node process. `runAuditInWorker` is a drop-in
 * replacement for the engine's `runAudit(url, options)` that does exactly that.
 *
 * The child runs `scripts/audit-worker.ts` under the SAME launcher the Phase 1
 * CLI uses (`node --import ./scripts/alias-hooks.mjs …`): Node 24 native TS
 * stripping + the `@/` alias hook, NOT tsx (whose esbuild `keepNames` injects
 * `__name` wrappers that break Lighthouse — see scripts/alias-hooks.mjs / the
 * PRD Phase 1 deviation note). A welcome side effect: `lighthouse` /
 * `chrome-launcher` are imported only in the child, never in the Next server
 * bundle.
 *
 * This module imports only Node built-ins so it adds nothing to the bundle; the
 * heavy engine is loaded exclusively inside the worker.
 */

import { fork } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  extractAuditCredentials,
  stripAuditCredentials,
} from "@/lib/lighthouse/credentials";
import type { AuditOptions, AuditResult } from "@/lib/lighthouse/types";
import { filterWorkerEnv } from "@/lib/queue/workerEnv";

/**
 * Per-job wall-clock ceiling. A job is up to {@link MAX_RUNS}=5 sequential
 * Lighthouse runs (~10–30s each) plus process + Chrome startup, so we allow a
 * generous 5 minutes before declaring the worker hung and killing it.
 */
const WORKER_TIMEOUT_MS = 5 * 60_000;

/** Cap on retained child stderr (chars) surfaced in error messages. */
const MAX_STDERR = 4_000;

/**
 * Resolve a repo-relative script path against the process CWD (the project root
 * for `next dev` / `next start`, both run via npm from the repo root). Throws a
 * clear, preflight-style error (PRD §8) if the file is missing rather than
 * failing cryptically deep inside `fork`.
 *
 * `LH_ALIAS_HOOKS_PATH` and `LH_AUDIT_WORKER_SCRIPT` override the two resolved
 * paths when a caller (or a test) needs to point elsewhere.
 */
function resolveScript(relPath: string): string {
  const abs = path.resolve(process.cwd(), relPath);
  if (!existsSync(abs)) {
    throw new Error(
      `Audit worker dependency not found: ${abs}. ` +
        `The server must be started from the project root so '${relPath}' resolves.`,
    );
  }
  return abs;
}

/**
 * Resolve the alias-hooks ESM loader path.
 *
 * Priority:
 *   1. `LH_ALIAS_HOOKS_PATH` env var (an explicit override, also used by tests).
 *   2. Fallback: resolve `scripts/alias-hooks.mjs` from the CWD.
 */
function resolveAliasHooks(): string | null {
  const envPath = process.env.LH_ALIAS_HOOKS_PATH;
  if (envPath) {
    if (!existsSync(envPath)) {
      throw new Error(`LH_ALIAS_HOOKS_PATH not found: ${envPath}`);
    }
    return envPath;
  }

  // Dev fallback: resolve from CWD
  return resolveScript("scripts/alias-hooks.mjs");
}

/**
 * Whether the worker fork needs `--experimental-strip-types` to load the `.ts`
 * worker. `fork` reuses `process.execPath`, so the runtime that will execute the
 * worker is the one running THIS process — its `process.versions.node` decides.
 *
 * Node enables TypeScript type-stripping by default in v23.6.0. Below that the
 * `.ts` worker fork dies with `ERR_UNKNOWN_FILE_EXTENSION` unless the flag is
 * passed (the flag itself landed in v22.6.0). Users run this app on whatever Node
 * they have, so Node 22.6–23.5 must still work.
 *
 * Returns false for Node < 22.6 (flag unsupported — nothing we can do) and for
 * Node ≥ 23.6 (stripping is already the default).
 */
function needsExperimentalStripTypes(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > 23 || (major === 23 && minor >= 6)) return false; // default on
  return major > 22 || (major === 22 && minor >= 6); // flag available
}

/**
 * Compact but useful tail of child stderr for a crash message. The worker now
 * funnels its own failures through a structured `{ ok:false }` IPC message
 * (see scripts/audit-worker.ts), so this only fires for crashes that signal
 * nothing — and for those we want the real error, not just the last line.
 * Returns the last few non-empty lines with Node's trailing `Node.js vX` banner
 * stripped (it's the last line of every uncaught crash and says nothing), capped
 * so a runaway stack can't bloat the message.
 */
export function stderrTail(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && !/^Node\.js v\d/.test(l.trim()));
  if (lines.length === 0) return "";
  // The first non-stack-frame line is usually the real cause — e.g.
  // `Error: ENOENT: no such file or directory, open '<file>'` — and a pure tail
  // would drop it when the stack is deep. Keep that head line plus the last few
  // frames for context.
  const head = lines.find((l) => !/^\s*at\s/.test(l));
  const tail = lines.slice(-12);
  const picked = head && !tail.includes(head) ? [head, ...tail] : tail;
  const out = picked.join("\n");
  return out.length > 1_500 ? `${out.slice(0, 1_499)}…` : out;
}

/** Error thrown when a worker is killed by an {@link AbortSignal} (user cancel). */
export class WorkerAbortError extends Error {
  constructor(url: string) {
    super(`Audit cancelled for ${url}`);
    this.name = "WorkerAbortError";
  }
}

/**
 * Run one audit (`runAudit`) in an isolated child process. Resolves with the
 * full {@link AuditResult} (including `median.lhr`) on success, or rejects with a
 * descriptive `Error` on failure/timeout. The temp result file is always removed.
 *
 * Pass an {@link AbortSignal} to support user-initiated cancellation: when it
 * fires the child is SIGKILLed and the promise rejects with a
 * {@link WorkerAbortError}, which the queue treats as a cancel (not an error).
 */
export async function runAuditInWorker(
  url: string,
  options: AuditOptions,
  signal?: AbortSignal,
): Promise<AuditResult> {
  if (signal?.aborted) {
    throw new WorkerAbortError(url);
  }
  // The worker is an out-of-bundle Node script launched with `fork`, NOT an app
  // module. We resolve its real path here, but hand `fork` (below) a bare
  // `process.env` lookup the bundler can't statically trace — otherwise Turbopack
  // folds the literal into a module specifier (or a dynamic require-context over
  // the project root) and fails the build with `Can't resolve scripts/audit-worker.ts`.
  // Stashing the resolved path in an env var (which an explicit override can
  // pre-set) keeps the value opaque to static analysis while runtime behaviour is
  // unchanged. The worker only loads the heavy engine; it is never bundled.
  process.env.LH_AUDIT_WORKER_SCRIPT ??= resolveScript("scripts/audit-worker.ts");
  const workerScript = process.env.LH_AUDIT_WORKER_SCRIPT;
  const aliasHooks = resolveAliasHooks();
  const outFile = path.join(
    os.tmpdir(),
    `lh-result-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  const removeOutFile = (): void => {
    void fs.rm(outFile, { force: true });
  };

  // Build execArgv: in dev/next-start mode we need the alias-hooks loader for
  // Node native TS type-stripping + @/ alias resolution. In packaged mode the
  // worker is pre-compiled JS and needs no loader (alias baked in by esbuild).
  const execArgv: string[] = [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--disable-warning=ExperimentalWarning",
  ];
  if (aliasHooks) {
    // The worker is the `.ts` source; on Node < 23.6 type-stripping is off by
    // default and the fork would otherwise fail with
    // ERR_UNKNOWN_FILE_EXTENSION. The ExperimentalWarning it emits is
    // already silenced by the --disable-warning above.
    if (needsExperimentalStripTypes()) {
      execArgv.push("--experimental-strip-types");
    }
    execArgv.push("--import", pathToFileURL(aliasHooks).href);
  }

  // Credentials (ROADMAP Phase B) travel over IPC, NOT in the fork's
  // environment. A process's environment is readable by anything running as the
  // same user AND is inherited by every descendant — and this worker launches
  // Chrome, so an `LH_AUDIT_INPUT` carrying the site's `Authorization` value
  // would put it in the environment of the very process that renders untrusted
  // web content. The IPC channel below is already open for the completion
  // signal; a message on it is process-private and lives only as long as the
  // handler that reads it. So the env carries credential-FREE options, and the
  // values are sent separately, immediately after fork.
  const credentials = extractAuditCredentials(options);
  // The parent environment is FILTERED, not copied (`./workerEnv`). Same reason
  // as the paragraph above, applied to everything else in the environment rather
  // than only to our own credentials: whatever is here is inherited by Chrome,
  // and since ROADMAP Phase G the parent can be a coding agent whose environment
  // carries provider API keys nobody meant to hand to a browser rendering an
  // attacker's page.
  const forkEnv: NodeJS.ProcessEnv = {
    ...filterWorkerEnv(process.env),
    LH_AUDIT_INPUT: JSON.stringify({
      url,
      options: credentials ? stripAuditCredentials(options) : options,
      // Tells the worker to WAIT for the credential message rather than racing
      // ahead and auditing the page unauthenticated (which would 401 and look
      // like a broken credential instead of a broken handoff).
      awaitCredentials: credentials !== undefined,
    }),
    LH_AUDIT_OUTPUT: outFile,
  };

  return await new Promise<AuditResult>((resolve, reject) => {
    const child = fork(workerScript, [], {
      // Mirror the Phase 1 CLI launcher: native TS + `@/` alias, quiet warnings.
      // In packaged mode: no alias-hooks (compiled JS); in dev: full TS loader.
      execArgv,
      env: forkEnv,
      // Keep IPC for the completion signal; capture stderr for error context.
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    // Hand the credentials over the private channel. `child.send` before the
    // channel is ready is buffered by Node, so this cannot race the fork.
    if (credentials) {
      child.send({ type: "credentials", credentials });
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stderr = "";
    let lastMessage: { ok: boolean; message?: string } | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, WORKER_TIMEOUT_MS);

    // User-initiated cancel: kill the child; the `exit` handler resolves the
    // rejection via the `aborted` flag (mirrors the timeout path).
    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString();
    });

    child.on("message", (msg) => {
      lastMessage = msg as { ok: boolean; message?: string };
    });

    child.on("error", (err) => {
      finish(() => {
        removeOutFile();
        reject(err);
      });
    });

    child.on("exit", (code, exitSignal) => {
      if (aborted) {
        finish(() => {
          removeOutFile();
          reject(new WorkerAbortError(url));
        });
        return;
      }

      if (timedOut) {
        finish(() => {
          removeOutFile();
          reject(
            new Error(
              `Audit timed out after ${WORKER_TIMEOUT_MS / 1000}s for ${url}`,
            ),
          );
        });
        return;
      }

      if (lastMessage && lastMessage.ok === false) {
        finish(() => {
          removeOutFile();
          reject(new Error(lastMessage?.message || `Audit failed for ${url}`));
        });
        return;
      }

      if (code !== 0) {
        const detail = stderrTail(stderr);
        finish(() => {
          removeOutFile();
          reject(
            new Error(
              `Audit worker exited with code ${code}${exitSignal ? `/${exitSignal}` : ""} for ${url}` +
                (detail ? `:\n${detail}` : ""),
            ),
          );
        });
        return;
      }

      // Clean exit: the full result is in the temp file.
      void fs
        .readFile(outFile, "utf8")
        .then((raw) => {
          const result = JSON.parse(raw) as AuditResult;
          finish(() => {
            removeOutFile();
            resolve(result);
          });
        })
        .catch((err: unknown) => {
          finish(() => {
            removeOutFile();
            reject(
              new Error(
                `Could not read audit result for ${url}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
          });
        });
    });
  });
}
