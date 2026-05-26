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

import type { AuditOptions, AuditResult } from "@/lib/lighthouse/types";

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

/** Last non-empty line of a buffer, for compact error context. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

/**
 * Run one audit (`runAudit`) in an isolated child process. Resolves with the
 * full {@link AuditResult} (including `median.lhr`) on success, or rejects with a
 * descriptive `Error` on failure/timeout. The temp result file is always removed.
 */
export async function runAuditInWorker(
  url: string,
  options: AuditOptions,
): Promise<AuditResult> {
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
  const aliasHooks = resolveScript("scripts/alias-hooks.mjs");
  const outFile = path.join(
    os.tmpdir(),
    `lh-result-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  const removeOutFile = (): void => {
    void fs.rm(outFile, { force: true });
  };

  return await new Promise<AuditResult>((resolve, reject) => {
    const child = fork(workerScript, [], {
      // Mirror the Phase 1 CLI launcher: native TS + `@/` alias, quiet warnings.
      execArgv: [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--disable-warning=ExperimentalWarning",
        "--import",
        pathToFileURL(aliasHooks).href,
      ],
      env: {
        ...process.env,
        LH_AUDIT_INPUT: JSON.stringify({ url, options }),
        LH_AUDIT_OUTPUT: outFile,
      },
      // Keep IPC for the completion signal; capture stderr for error context.
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    let settled = false;
    let timedOut = false;
    let stderr = "";
    let lastMessage: { ok: boolean; message?: string } | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, WORKER_TIMEOUT_MS);

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

    child.on("exit", (code, signal) => {
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
        const tail = lastLine(stderr);
        finish(() => {
          removeOutFile();
          reject(
            new Error(
              `Audit worker exited with code ${code}${signal ? `/${signal}` : ""} for ${url}` +
                (tail ? `: ${tail}` : ""),
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
