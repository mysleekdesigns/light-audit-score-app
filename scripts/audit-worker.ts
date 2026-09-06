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
 *   - input  via env `LH_AUDIT_INPUT`  = JSON
 *     `{ url, options, awaitCredentials }` — credential-FREE (see below)
 *   - audit credentials, when the job has any, arrive as ONE IPC message
 *     `{ type: "credentials", credentials }`. They are deliberately kept out of
 *     the environment: a process environment is readable by anything running as
 *     the same user and is inherited by every descendant, and this process
 *     launches Chrome — so an env-borne credential would end up in the
 *     environment of the process rendering untrusted web content
 *   - output via env `LH_AUDIT_OUTPUT` = path to write the full AuditResult JSON,
 *     with every audit-credential VALUE redacted first (see `main()`) — this is
 *     the boundary at which a credential stops existing outside this process
 *   - completion signalled over IPC: `{ ok: true }` | `{ ok: false, message }`,
 *     and via exit code (0 = success). The parent reads the output file on a
 *     clean exit; the IPC message carries the failure reason otherwise.
 */

import { promises as fs } from "node:fs";

import {
  type AuditCredentials,
  redactAuditOptions,
  withAuditCredentials,
} from "@/lib/lighthouse/credentials";
import { classifyAuditError } from "@/lib/lighthouse/diagnose";
import { runAudit } from "@/lib/lighthouse/median";
import {
  auditCredentialsSchema,
  resolveAuditOptions,
} from "@/lib/lighthouse/options";
import { resolveEngineCredentials } from "@/lib/lighthouse/runAudit";

/**
 * How long to wait for the parent's credential message before giving up. The
 * parent sends it immediately after `fork` (Node buffers the send until the
 * channel is ready), so arrival is near-instant; this only bounds a parent that
 * died or a channel that never opened, and failing loudly beats auditing a
 * protected page unauthenticated and reporting the resulting 401 as if the
 * user's credential were wrong.
 */
const CREDENTIALS_TIMEOUT_MS = 30_000;

/**
 * Resolve with the credentials the parent sends over IPC.
 *
 * The listener is registered synchronously by the caller's first `await`, and
 * Node queues IPC messages that arrive before a handler exists, so there is no
 * race with the parent's immediate `send`.
 */
function receiveCredentials(): Promise<AuditCredentials> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off("message", onMessage);
      reject(
        new Error(
          "audit worker: timed out waiting for the credentials message from the parent",
        ),
      );
    }, CREDENTIALS_TIMEOUT_MS);
    timer.unref?.();

    function onMessage(message: unknown): void {
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { type?: unknown }).type !== "credentials"
      ) {
        return;
      }
      clearTimeout(timer);
      process.off("message", onMessage);
      // Re-validate on receipt. The parent already validated at the API, but
      // this worker's whole discipline is to re-resolve what it is handed
      // (`resolveAuditOptions` does the same for options a line below), and the
      // credential half must not be the one input that skips it — these values
      // become request headers.
      const parsedCredentials = auditCredentialsSchema.safeParse(
        (message as { credentials: unknown }).credentials,
      );
      if (!parsedCredentials.success) {
        reject(
          new Error("audit worker: the credentials message failed validation"),
        );
        return;
      }
      resolve(parsedCredentials.data);
    }

    process.on("message", onMessage);
  });
}

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

  let parsed: { url: string; options: unknown; awaitCredentials?: boolean };
  try {
    parsed = JSON.parse(rawInput) as {
      url: string;
      options: unknown;
      awaitCredentials?: boolean;
    };
  } catch (error) {
    throw new Error(`audit worker: invalid LH_AUDIT_INPUT JSON: ${String(error)}`);
  }
  if (typeof parsed.url === "string" && parsed.url.length > 0) {
    currentUrl = parsed.url;
  }

  // Options arrive already validated, but re-resolving is cheap and defensive.
  // They arrive credential-FREE; the values come over IPC (see the header) and
  // are re-attached here, so from this line on `options` is what the engine
  // audits with.
  const options = parsed.awaitCredentials
    ? withAuditCredentials(
        resolveAuditOptions(parsed.options),
        await receiveCredentials(),
      )
    : resolveAuditOptions(parsed.options);
  const result = await runAudit(parsed.url, options);

  // Redact before the result leaves this process (ROADMAP Phase B). The result's
  // `options` are the ones the engine just audited with, per-batch credentials
  // and all; the file we write here is read by the parent and flows on into
  // SQLite, SSE events and the API. Replacing every credential VALUE with
  // `[redacted]` at this one boundary — while keeping the header/cookie NAMES,
  // which are provenance, not secrets — means a credential's lifetime ends with
  // the process that used it, and nothing downstream has to remember to redact.
  // The median LHR was already scrubbed per run by `runSingleAudit`.
  //
  // We record WHICH credentials the run actually used, not just the ones that
  // arrived over HTTP. Host-scoped `.env` credentials never appear on `options`
  // — they are resolved inside the engine — but `resolveEngineCredentials` is
  // deterministic, so re-deriving it here yields exactly what `runSingleAudit`
  // sent. Folding that in before redacting is what stops an env-authenticated
  // run from being recorded (and rendered) as "Auth: None" while it plainly did
  // authenticate. Only the NAMES survive the redaction, so this adds provenance
  // without adding a secret.
  const applied = resolveEngineCredentials(options, process.env, parsed.url);
  const redacted = {
    ...result,
    options: redactAuditOptions(withAuditCredentials(result.options, applied)),
  };

  await fs.writeFile(outPath, JSON.stringify(redacted), "utf8");
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
