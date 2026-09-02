#!/usr/bin/env node
/**
 * `npm start` / `pnpm start` — run LightAudit Score locally.
 *
 * The app is distributed as source: clone the repo, install, start. That means a
 * fresh checkout has no production build yet, and `next start` alone would fail
 * with a bare "could not find a production build" error. So this builds on first
 * run, then starts. Subsequent starts skip the build and come up immediately.
 *
 * Rebuild explicitly with `npm run build` after changing source (or use
 * `npm run dev` for hot reload while developing).
 *
 * Env:
 *   PORT   port to bind (default 3000)
 *   HOST   interface to bind (default 127.0.0.1 — local only, on purpose)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A finished `next build` leaves BUILD_ID behind; its absence means we must build. */
function hasProductionBuild() {
  return existsSync(path.join(root, ".next", "BUILD_ID"));
}

/** Run a package script through the same package manager that invoked us. */
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`interrupted by ${signal}`));
      if (code !== 0) return reject(new Error(`exited with code ${code}`));
      resolve();
    });
  });
}

/** Resolve a binary installed by our own dependencies (no global install needed). */
function localBin(name) {
  const bin = path.join(root, "node_modules", ".bin", name);
  if (!existsSync(bin)) {
    throw new Error(
      `Could not find ${name} in node_modules/.bin.\n` +
        `Run 'npm install' (or 'pnpm install') in ${root} first.`,
    );
  }
  return bin;
}

const nextBin = localBin("next");

if (!hasProductionBuild()) {
  console.log("[LightAudit] No production build found — building once (this takes a minute)…\n");
  await run([nextBin, "build"]);
  console.log("\n[LightAudit] Build complete.\n");
}

const port = process.env.PORT ?? "3000";
// Bind loopback by default: this server runs audits and reads local files, and
// has no authentication unless LH_SESSION_TOKEN is set. Exposing it on 0.0.0.0
// should be a deliberate act, not the default.
const host = process.env.HOSTNAME ?? process.env.HOST ?? "127.0.0.1";

console.log(`[LightAudit] Starting on http://${host}:${port}\n`);
await run([nextBin, "start", "--port", port, "--hostname", host]);
