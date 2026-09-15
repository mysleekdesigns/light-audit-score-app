#!/usr/bin/env node
/**
 * `npm start` / `pnpm start` — run LightAudit Score locally.
 *
 * The app is distributed as source: clone the repo, install, start. That means a
 * fresh checkout has no production build yet, and `next start` alone would fail
 * with a bare "could not find a production build" error. So this builds on first
 * run, then starts. Subsequent starts skip the build and come up immediately.
 *
 * It also arms the local server's gate (see `src/proxy.ts`): a per-install
 * session token is resolved here (scripts/session-token.mjs), exported to the
 * server as `LH_SESSION_TOKEN`, and printed as a `?token=` link — which is
 * opened in the browser, since the app only answers to a client that has
 * presented it once.
 *
 * Rebuild explicitly with `npm run build` after changing source (or use
 * `npm run dev` for hot reload while developing).
 *
 * Env (shell, or `.env` in the project root):
 *   PORT               port to bind (default 3000)
 *   HOST               interface to bind (default 127.0.0.1 — local only, on purpose)
 *   LH_SESSION_TOKEN   pin the session token (default: generated once, kept in
 *                      <LH_DATA_DIR>/session-token)
 *   LH_ALLOWED_HOSTS   extra Host headers to answer to, for a deliberate LAN bind
 *   LH_OPEN_BROWSER    set to 0 to skip opening the link in a browser
 *   LH_DATA_DIR        where the token file (and the SQLite DB) live (default ./data)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readDotEnv, resolveSessionToken } from "./session-token.mjs";

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
  console.log("[LightAudit Score] No production build found — building once (this takes a minute)…\n");
  await run([nextBin, "build"]);
  console.log("\n[LightAudit Score] Build complete.\n");
}

// Next loads `.env` into the server itself; this script needs a few of the
// same keys before that happens (the token, and where to keep it).
const dotEnv = readDotEnv(path.join(root, ".env"));
const setting = (key) => process.env[key]?.trim() || dotEnv[key]?.trim() || undefined;

const port = setting("PORT") ?? "3000";
// Bind loopback by default: this server runs audits and reads local files.
// Exposing it on 0.0.0.0 should be a deliberate act, not the default — and even
// then the proxy (request gate) only answers to Host headers listed in LH_ALLOWED_HOSTS.
const host = setting("HOSTNAME") ?? setting("HOST") ?? "127.0.0.1";
const dataDir = path.resolve(root, setting("LH_DATA_DIR") ?? "data");

let token;
let source;
try {
  ({ token, source } = resolveSessionToken({ env: process.env, dotEnv, dataDir }));
} catch (err) {
  console.error(`[LightAudit Score] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD_BINDS = new Set(["0.0.0.0", "::"]);
const loopback = LOOPBACK_BINDS.has(host);
// A named non-loopback bind (HOST=192.168.1.20) is implicitly an allowed Host;
// a wildcard bind is not, since the hostnames people will use are unknowable.
const allowedHosts = [setting("LH_ALLOWED_HOSTS"), !loopback && !WILDCARD_BINDS.has(host) ? host : undefined]
  .filter(Boolean)
  .join(",");

const linkHost = loopback || WILDCARD_BINDS.has(host) ? "127.0.0.1" : host;
const link = `http://${linkHost}:${port}/?token=${encodeURIComponent(token)}`;

const tokenNote =
  source === "env"
    ? "from LH_SESSION_TOKEN"
    : source === "file"
      ? `from ${path.relative(root, dataDir) || "."}/session-token`
      : `generated → ${path.relative(root, dataDir) || "."}/session-token`;

console.log(`[LightAudit Score] Starting on http://${host}:${port}  (session token ${tokenNote})`);
console.log(`[LightAudit Score] Open the app with this link — it sets your session cookie:\n\n    ${link}\n`);
if (!loopback) {
  console.log(
    `[LightAudit Score] Bound to ${host}: requests are only answered for Host headers ` +
      `${allowedHosts ? `in: ${allowedHosts}` : "on loopback — set LH_ALLOWED_HOSTS for others"}.\n`,
  );
}

const server = spawn(process.execPath, [nextBin, "start", "--port", port, "--hostname", host], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    LH_SESSION_TOKEN: token,
    ...(allowedHosts ? { LH_ALLOWED_HOSTS: allowedHosts } : {}),
  },
});

const exited = new Promise((resolve, reject) => {
  server.on("error", reject);
  server.on("exit", (code, signal) => {
    if (signal) return reject(new Error(`interrupted by ${signal}`));
    if (code !== 0) return reject(new Error(`exited with code ${code}`));
    resolve();
  });
});

/**
 * Poll until OUR server answers — recognised by the gate's marker header — or
 * it exits, or we give up. A stranger already holding the port answers too
 * (and makes `next start` die with EADDRINUSE); without the marker we keep
 * waiting rather than hand it the token link.
 */
async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return false;
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.headers.get("x-lightaudit-gate") === "1" && server.exitCode === null) {
        return true;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Open a URL in the default browser, best effort, never blocking. */
function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // Not `cmd /c start`: cmd would re-parse the URL for metacharacters.
          ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No opener available — the link is printed above.
  }
}

if (process.stdout.isTTY && setting("LH_OPEN_BROWSER") !== "0") {
  void waitForServer(`http://${linkHost}:${port}/`).then((up) => {
    if (up) openBrowser(link);
  });
}

await exited;
