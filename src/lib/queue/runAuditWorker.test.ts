/**
 * Tests for the process-isolated audit runner's failure handling.
 *
 * Two regressions are covered here, both motivated by a real crash where an
 * audited site made the forked worker exit 1 and the recorded
 * error was the useless `"...: Node.js v22.15.1"` (the last line Node prints on
 * an uncaught crash — the real cause was thrown away):
 *
 *   - `stderrTail` (Bug A): when a worker crashes WITHOUT signalling over IPC,
 *     the parent must surface the meaningful stderr tail, not just the version
 *     banner. Pure-function unit tests plus an end-to-end fork.
 *   - the structured-failure contract (Bug B): a worker that reports a failure
 *     over IPC (`{ ok:false, message }`) — which `scripts/audit-worker.ts` now
 *     does for EVERY terminal failure, including async errors that escape
 *     `main()` — must reject with that exact message, regardless of exit code.
 *
 * We drive `runAuditInWorker` against tiny CJS fixture workers (no Chrome, no
 * Lighthouse) via the `LH_AUDIT_WORKER_SCRIPT` seam, so the parent's contract is
 * exercised deterministically.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runAuditInWorker,
  stderrTail,
  WorkerAbortError,
} from "@/lib/queue/runAuditWorker";
import type { AuditOptions } from "@/lib/lighthouse/types";

const OPTIONS = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance"],
  runs: 1,
  warmCache: true,
} as unknown as AuditOptions;

describe("stderrTail", () => {
  it("strips Node's trailing version banner", () => {
    const stderr = [
      "/app/worker.js:10",
      "    throw new Error('kaboom');",
      "    ^",
      "Error: kaboom",
      "    at Object.<anonymous> (/app/worker.js:10:11)",
      "Node.js v22.15.1",
    ].join("\n");
    const tail = stderrTail(stderr);
    expect(tail).toContain("Error: kaboom");
    expect(tail).not.toMatch(/Node\.js v/);
  });

  it("returns the last non-empty lines (more than one)", () => {
    const tail = stderrTail("line a\n\nline b\nNode.js v20.0.0\n");
    expect(tail).toContain("line a");
    expect(tail).toContain("line b");
  });

  it("caps a runaway stack", () => {
    const tail = stderrTail("x".repeat(5_000));
    expect(tail.length).toBeLessThanOrEqual(1_501); // 1500 + leading ellipsis
  });

  it("is empty when there is nothing but the banner", () => {
    expect(stderrTail("Node.js v22.15.1\n")).toBe("");
  });

  it("keeps the error head line even behind a deep stack (the ENOENT path)", () => {
    const deepStack = [
      "Error: ENOENT: no such file or directory, open '/app/lighthouse/core/audits/x.js'",
      ...Array.from({ length: 30 }, (_, i) => `    at frame${i} (/app/x.js:${i}:1)`),
      "Node.js v22.15.1",
    ].join("\n");
    const tail = stderrTail(deepStack);
    expect(tail).toContain("ENOENT");
    expect(tail).toContain("core/audits/x.js"); // the actual missing file
    expect(tail).not.toMatch(/Node\.js v/);
  });
});

describe("runAuditInWorker failure surfacing (forked fixtures)", () => {
  let dir: string;
  const fixtures: Record<string, string> = {};

  /**
   * The fork launcher (dev mode) prepends `--import scripts/alias-hooks.mjs`;
   * harmless for a plain CJS fixture that imports nothing.
   */
  const writeFixture = (name: string, body: string): string => {
    const file = path.join(dir, name);
    writeFileSync(file, body, "utf8");
    return file;
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lh-worker-test-"));

    // Reports a structured failure over IPC then exits non-zero — exactly what
    // scripts/audit-worker.ts's reportFatal does for an escaped async error.
    fixtures.ipcFail = writeFixture(
      "ipc-fail.cjs",
      [
        "process.send({ ok: false, message: 'Could not reach the page — the connection was reset.' }, () => {",
        "  process.exit(1);",
        "});",
      ].join("\n"),
    );

    // Crashes with a real stack and NO IPC message (a pre-handler / hard crash).
    // The last stderr line is the version banner, mimicking the original bug.
    fixtures.bareCrash = writeFixture(
      "bare-crash.cjs",
      [
        "console.error('SomeEngineError: protocol target closed');",
        "console.error('    at CdpSession (/x/cdp.js:1:1)');",
        "console.error('Node.js v22.15.1');",
        "process.exit(1);",
      ].join("\n"),
    );

    // Clean success: write the result file the parent reads, signal ok, exit 0.
    fixtures.success = writeFixture(
      "success.cjs",
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.LH_AUDIT_OUTPUT, JSON.stringify({ requestedUrl: 'ok' }));",
        "process.send({ ok: true }, () => process.exit(0));",
      ].join("\n"),
    );

    // A `.ts` worker carrying real type syntax: must be forkable in dev mode.
    // Before the --experimental-strip-types gate in runAuditWorker this threw
    // ERR_UNKNOWN_FILE_EXTENSION on Node < 23.6, which users may well be on.
    // Regression guard for
    // that fix — passes on both flagged (22.6–23.5) and default-on (≥23.6) Node.
    fixtures.tsSuccess = writeFixture(
      "success.ts",
      [
        "const out: string = process.env.LH_AUDIT_OUTPUT as string;",
        "require('node:fs').writeFileSync(out, JSON.stringify({ requestedUrl: 'ts-ok' }));",
        "process.send({ ok: true }, () => process.exit(0));",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.LH_AUDIT_WORKER_SCRIPT;
  });

  const runWith = (script: string, url = "https://example.com/") => {
    process.env.LH_AUDIT_WORKER_SCRIPT = script;
    return runAuditInWorker(url, OPTIONS);
  };

  it("rejects with the worker's IPC message for a structured failure", async () => {
    await expect(runWith(fixtures.ipcFail)).rejects.toThrow(
      /connection was reset/,
    );
  });

  it("surfaces the real stderr — not just the version banner — on a bare crash", async () => {
    const err = await runWith(fixtures.bareCrash).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("exited with code 1");
    expect(message).toContain("protocol target closed"); // the real cause
    expect(message).not.toMatch(/: Node\.js v[\d.]+$/); // not the bare banner
  });

  it("still resolves the result on a clean success", async () => {
    const result = (await runWith(fixtures.success)) as { requestedUrl?: string };
    expect(result.requestedUrl).toBe("ok");
  });

  it("forks a .ts worker with type syntax (strip-types guard)", async () => {
    const result = (await runWith(fixtures.tsSuccess)) as { requestedUrl?: string };
    expect(result.requestedUrl).toBe("ts-ok");
  });

  it("exports WorkerAbortError for the queue's cancel path", () => {
    expect(new WorkerAbortError("https://example.com/")).toBeInstanceOf(Error);
  });
});

describe("credential handoff (ROADMAP Phase B)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lh-cred-test-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.LH_AUDIT_WORKER_SCRIPT;
  });

  /**
   * A fixture worker that reports back exactly what it was handed: the raw
   * `LH_AUDIT_INPUT` the parent put in its ENVIRONMENT, and the credentials it
   * received over IPC. That lets one real fork prove both halves of the M2 fix
   * — the env is clean, and the handoff still works.
   */
  const echoWorker = (): string => {
    const file = path.join(dir, "echo-credentials.cjs");
    writeFileSync(
      file,
      [
        "const fs = require('node:fs');",
        "const input = process.env.LH_AUDIT_INPUT;",
        "const finish = (credentials) => {",
        "  fs.writeFileSync(process.env.LH_AUDIT_OUTPUT, JSON.stringify({",
        "    envInput: input,",
        "    envKeys: Object.keys(process.env).filter((k) => k.startsWith('LH_AUDIT')),",
        "    credentials: credentials ?? null,",
        "  }));",
        "  process.send({ ok: true }, () => process.exit(0));",
        "};",
        "if (JSON.parse(input).awaitCredentials) {",
        "  process.on('message', (m) => { if (m && m.type === 'credentials') finish(m.credentials); });",
        "} else { finish(null); }",
      ].join("\n"),
      "utf8",
    );
    return file;
  };

  const CREDENTIALED = {
    ...OPTIONS,
    basicAuth: { username: "staging", password: "hunter2-secret" },
    cookies: { session: "cookie-secret" },
    extraHeaders: { "X-Preview-Token": "header-secret" },
  } as unknown as AuditOptions;

  it("keeps every credential value OUT of the fork's environment", async () => {
    process.env.LH_AUDIT_WORKER_SCRIPT = echoWorker();
    const result = (await runAuditInWorker(
      "https://staging.example.com/",
      CREDENTIALED,
    )) as unknown as { envInput: string; envKeys: string[] };

    // The environment is inherited by every descendant, Chrome included.
    for (const secret of ["hunter2-secret", "cookie-secret", "header-secret"]) {
      expect(result.envInput).not.toContain(secret);
    }
    // Only the two documented variables — no new credential-bearing one.
    expect(result.envKeys.sort()).toEqual([
      "LH_AUDIT_INPUT",
      "LH_AUDIT_OUTPUT",
      "LH_AUDIT_WORKER_SCRIPT",
    ]);
    // The names are stripped too, not just the values.
    expect(result.envInput).not.toContain("X-Preview-Token");
    expect(JSON.parse(result.envInput).awaitCredentials).toBe(true);
  });

  it("delivers the credentials over IPC instead", async () => {
    process.env.LH_AUDIT_WORKER_SCRIPT = echoWorker();
    const result = (await runAuditInWorker(
      "https://staging.example.com/",
      CREDENTIALED,
    )) as unknown as { credentials: Record<string, unknown> };

    expect(result.credentials).toEqual({
      basicAuth: { username: "staging", password: "hunter2-secret" },
      cookies: { session: "cookie-secret" },
      extraHeaders: { "X-Preview-Token": "header-secret" },
    });
  });

  it("sends no credential message, and no flag, for an unauthenticated job", async () => {
    process.env.LH_AUDIT_WORKER_SCRIPT = echoWorker();
    const result = (await runAuditInWorker(
      "https://example.com/",
      OPTIONS,
    )) as unknown as { credentials: unknown; envInput: string };

    expect(result.credentials).toBeNull();
    expect(JSON.parse(result.envInput).awaitCredentials).toBe(false);
  });
});
