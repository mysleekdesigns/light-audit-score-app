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

import { runAudit } from "@/lib/lighthouse/median";
import { resolveAuditOptions } from "@/lib/lighthouse/options";

/** Send an IPC message and resolve only once it has been flushed to the parent. */
function send(message: { ok: true } | { ok: false; message: string }): Promise<void> {
  return new Promise((resolve) => {
    if (process.send) process.send(message, undefined, undefined, () => resolve());
    else resolve();
  });
}

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

  // Options arrive already validated, but re-resolving is cheap and defensive.
  const options = resolveAuditOptions(parsed.options);
  const result = await runAudit(parsed.url, options);

  await fs.writeFile(outPath, JSON.stringify(result), "utf8");
  await send({ ok: true });
  process.exit(0);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await send({ ok: false, message });
  process.exit(1);
});
