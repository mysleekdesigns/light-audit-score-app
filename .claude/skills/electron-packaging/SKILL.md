---
name: electron-packaging
description: Packaging LightAudit's Next.js app as a signed Electron desktop app — boot sequence, electron-builder config, ASAR/asarUnpack for better-sqlite3 and the forked audit workers, Chrome/CHROME_PATH resolution, LH_DATA_DIR relocation, integrity fuses, signing/notarization, electron-updater, CI matrix. Use for SAAS_PLAN.md Phase A work and the packaging parts of Phase E.
---

# Electron packaging for LightAudit

Authoritative plan: `SAAS_PLAN.md` §4 (architecture) + Phase A checklist + Phase E Tiers 1/4.
The decision is final: Electron shell hosting the existing **Next.js standalone server**; the
app code runs as-is. SQLite stays. Tauri is rejected (Node-heavy server would need a sidecar).

## Boot sequence (main process)

1. `app.requestSingleInstanceLock()` — quit if not obtained; focus existing window on second launch.
2. Resolve data dir: set `LH_DATA_DIR = app.getPath("userData")` **before** anything imports
   `src/lib/db/paths.ts` logic. Never write inside the install dir.
3. Pick a free localhost port; generate a per-session auth token.
4. Spawn the standalone server (`.next/standalone/server.js`) with
   `HOSTNAME=127.0.0.1`, `PORT=<free>`, `LH_DATA_DIR`, the session token env, and
   `LH_AUDIT_WORKER_SCRIPT` pointing at the **unpacked** worker path.
5. `BrowserWindow` → `loadURL("http://127.0.0.1:<port>/?token=…")`. Window options:
   `contextIsolation: true`, `nodeIntegration: false`, no remote content ever.
6. Tray/resident mode: closing the window hides to tray (schedules keep firing);
   "launch at login" via `app.setLoginItemSettings`.

## The gnarly bit: forked workers + native deps inside a package

This is the Phase A risk item — prototype it before anything else.

- The queue forks `scripts/audit-worker.ts` (see `src/lib/queue/runAuditWorker.ts`) using the
  `LH_AUDIT_INPUT`/`LH_AUDIT_OUTPUT` env contract. Files inside `app.asar` cannot be
  `fork()`ed and `.node` binaries cannot load from it.
- `asarUnpack` at minimum: `**/*.node`, the worker script tree, and
  `node_modules/{lighthouse,chrome-launcher}/**` (lighthouse shells out to Chrome and reads
  asset files at runtime).
- Resolve unpacked paths by rewriting `app.asar` → `app.asar.unpacked` (or use
  `process.resourcesPath`); pass the result through `LH_AUDIT_WORKER_SCRIPT` — that env
  override exists precisely as this seam. No `process.cwd()` assumptions anywhere.
- Fork with Electron-as-Node: set `ELECTRON_RUN_AS_NODE=1` and use `process.execPath` so the
  worker gets a plain Node runtime from the Electron binary.
- `better-sqlite3` must be rebuilt against Electron's ABI per platform: `@electron/rebuild`
  (electron-builder runs it automatically when it detects native deps — verify, don't assume).
- Next standalone: `output: "standalone"` in `next.config.ts`; copy `.next/static` and
  `public/` next to the standalone server in the packaged layout (standalone output does not
  include them).

## Chrome resolution

Installed Chrome via chrome-launcher first (current behavior). Fallback: Electron's own
binary as `CHROME_PATH` so audits work out of the box. Never bundle a second Chromium.
If neither resolves, surface the existing "Chrome not found" guidance UI — not a crash.

## Integrity fuses (Phase E Tier 1)

electron-builder `electronFuses`:

```json
"electronFuses": {
  "runAsNode": false,
  "enableEmbeddedAsarIntegrityValidation": true,
  "onlyLoadAppFromAsar": true
}
```

⚠️ `runAsNode: false` conflicts with the `ELECTRON_RUN_AS_NODE` worker-fork strategy above —
if fuses are flipped, fork the worker via a bundled helper or `utilityProcess` instead;
decide once, in Phase E, with a packaged-build test proving audits still run.
Platform truth (research-verified 2026-06-11): macOS gets real protection (Electron 16+,
needs valid signing); Windows needs Electron 30+ and AppLocker is opt-in; **Linux has no ASAR
integrity** — document the gap honestly. Track Electron CVEs (cf. CVE-2025-55305: heap
snapshots bypassed integrity until patched) — stay on a current release.

## Signing, notarization, updates, CI

- macOS: Developer ID cert + hardened runtime + entitlements + `notarytool`; staple tickets.
- Windows: code-signing cert (OV minimum); sign installer and binaries.
- Linux: AppImage + deb; no signing infra — publish checksums.
- Auto-update: electron-updater against GitHub Releases (or R2); channels (latest/beta) +
  staged rollout percentages; updater verifies signatures — never disable that check.
- CI: GitHub Actions matrix (macos/windows/ubuntu) → build, sign, notarize, draft release.
  Release artifacts are built **only** in CI; lockfile-only installs (`npm ci`).

## "Is the package clean?" checklist

Run on every release candidate:
`npx asar list <app>/Contents/Resources/app.asar` + `strings` over the artifact — confirm:
no `.env*`, no `.mcp.json`, no `*.map` source maps, no API keys; worker + `.node` files
present under `app.asar.unpacked`; `LH_DATA_DIR` writes land in the OS app-data dir.
