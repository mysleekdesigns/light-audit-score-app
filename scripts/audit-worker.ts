/**
 * Forked audit worker (PRD §6 Phase 2).
 *
 * Runs exactly ONE audit job — i.e. `runAudit`, which itself performs N
 * *sequential* Lighthouse runs for a single URL and takes the median — inside an
 * isolated child process. This is the crux of safe batch concurrency: Lighthouse
 * stores its `lh:runner:*` performance marks in PROCESS-GLOBAL state, so running
 * two `lighthouse()` calls concurrently in one process corrupts both (symptom:
 * `The "start lh:runner:gather" performance mark has not been set`). Fresh
 * isolated Chrome per run (Phase 1) does not help — the collision is in
 * Lighthouse's Node-side globals. Mature tools (Unlighthouse, PRD §3) reconcile
 * "many at once" with "reliable scores" by isolating each audit in its own
 * process; that is exactly what this worker provides.
 *
 * Launched by {@link file://./../src/lib/queue/runAuditWorker.ts} as:
 *   node --import ./scripts/alias-hooks.mjs scripts/audit-worker.ts
 * (Node 24 native TS type-stripping + the `@/` alias hook — NOT tsx, whose
 * esbuild `keepNames` breaks Lighthouse; see scripts/alias-hooks.mjs.)
 *
 * Protocol:
 *   - input  via env `LH_AUDIT_INPUT`  = JSON `{ url, options }`
 *   - output via env `LH_AUDIT_OUTPUT` = path to write the full AuditResult JSON
 *   - completion signalled over IPC: `{ ok: true }` | `{ ok: false, message }`,
 *     and via exit code (0 = success). The parent reads the output file on a
 *     clean exit; the IPC message carries the failure reason otherwise.
 */

import { promises as fs } from "node:fs";

import { classifyAuditError } from "@/lib/lighthouse/diagnose";
import { runAudit } from "@/lib/lighthouse/median";
import { resolveAuditOptions } from "@/lib/lighthouse/options";

/** URL under audit — captured so the catch-all handlers can classify failures. */
let currentUrl = "the requested page";
/** Single-shot guard: success and failure paths must never both signal. */
let settled = false;

/** Send an IPC message and resolve only once it has been flushed to the parent. */
function send(message: { ok: true } | { ok: false; message: string }): Promise<void> {
  return new Promise((resolve) => {
    if (process.send) process.send(message, undefined, undefined, () => resolve());
    else resolve();
  });
}

/**
 * Report a terminal failure exactly once, then exit non-zero.
 *
 * Crucially this is also the net for async errors that fire OUTSIDE `main()`'s
 * awaited chain: Lighthouse drives Chrome over a CDP websocket, and if that
 * socket errors (ECONNRESET / "socket hang up") or Chrome dies mid-run, the
 * rejection/exception escapes `main().catch` and would bare-crash the process
 * with an unreadable `exit 1` + "Node.js vX" banner (see runAuditWorker.ts).
 * Routing every terminal failure through here turns that into the SAME
 * structured `{ ok:false, message }` IPC signal the queue already understands,
 * so one flaky page degrades to a clean per-URL error instead of crashing.
 *
 * @param preclassifiedMessage when set (errors from `main()`'s chain, already
 *   funnelled through `classifyAuditError` by `runSingleAudit`), use it verbatim;
 *   otherwise classify the raw escaped error here.
 */
function reportFatal(error: unknown, preclassifiedMessage?: string): void {
  if (settled) return;
  settled = true;
  const err = error instanceof Error ? error : new Error(String(error));
  // Full stack to stderr for diagnosis — the parent surfaces this tail when no
  // IPC message arrives, so an intermittent crash self-describes next time.
  console.error(
    `[audit-worker] fatal error for ${currentUrl}:\n${err.stack ?? err.message}`,
  );
  const message = preclassifiedMessage ?? classifyAuditError(err, currentUrl);
  const exit = (): never => process.exit(1);
  // Guard against a send() that never flushes (IPC channel already torn down).
  const fallback = setTimeout(exit, 2_000);
  fallback.unref?.();
  void send({ ok: false, message }).finally(() => {
    clearTimeout(fallback);
    exit();
  });
}

// Register BEFORE main() so async engine errors are caught from the first tick.
// A registered uncaughtException handler also stops Node's default auto-crash,
// giving reportFatal time to flush the IPC message before we exit ourselves.
process.on("uncaughtException", (err) => reportFatal(err));
process.on("unhandledRejection", (reason) => reportFatal(reason));

async function main(): Promise<void> {
  const rawInput = process.env.LH_AUDIT_INPUT;
  const outPath = process.env.LH_AUDIT_OUTPUT;
  if (!rawInput || !outPath) {
    throw new Error(
      "audit worker: missing LH_AUDIT_INPUT / LH_AUDIT_OUTPUT environment",
    );
  }

  let parsed: { url: string; options: unknown };
  try {
    parsed = JSON.parse(rawInput) as { url: string; options: unknown };
  } catch (error) {
    throw new Error(`audit worker: invalid LH_AUDIT_INPUT JSON: ${String(error)}`);
  }
  if (typeof parsed.url === "string" && parsed.url.length > 0) {
    currentUrl = parsed.url;
  }

  // Options arrive already validated, but re-resolving is cheap and defensive.
  const options = resolveAuditOptions(parsed.options);
  const result = await runAudit(parsed.url, options);

  await fs.writeFile(outPath, JSON.stringify(result), "utf8");
  if (settled) return; // a late async error already reported failure
  settled = true;
  await send({ ok: true });
  process.exit(0);
}

main().catch((error) => {
  // Errors from main()'s awaited chain are already classified by runSingleAudit;
  // pass the message through verbatim via the single-shot reportFatal path.
  const message = error instanceof Error ? error.message : String(error);
  reportFatal(error, message);
});
