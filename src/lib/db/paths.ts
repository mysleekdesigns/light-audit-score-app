/**
 * Filesystem locations for local persistence (PRD §6 Phase 4).
 *
 * All paths are resolved from functions (not module-load constants) so tests can
 * point `LH_DATA_DIR` / `LH_DB_PATH` at a temp directory before first use. In the
 * app these default to `./data/` under the process CWD (the project root for
 * `next dev`/`next start`), which `.gitignore` already excludes.
 *
 * Relocating the data dir:
 *   - LH_DATA_DIR  → set this to keep audit data outside the project directory
 *                    (e.g. ~/Library/Application Support/LightAudit on macOS)
 *   - LH_MIGRATIONS_DIR → path to drizzle/ inside app.asar (set by main process)
 *     Falls back to process.cwd()/drizzle when not set (dev / next start).
 *   Never write inside the install directory.
 */

import path from "node:path";

/** Root for all local artifacts (SQLite DB + report files). */
export function getDataDir(): string {
  return process.env.LH_DATA_DIR ?? path.join(process.cwd(), "data");
}

/** Directory holding the persisted Lighthouse report files. */
export function getReportsDir(): string {
  return path.join(getDataDir(), "reports");
}

/** Path to the SQLite database file. */
export function getDbPath(): string {
  return process.env.LH_DB_PATH ?? path.join(getDataDir(), "lighthouse.db");
}

/**
 * Folder of generated drizzle migrations applied at runtime.
 *
 * Resolution order:
 *   1. LH_MIGRATIONS_DIR env var — an explicit override pointing at the
 *      drizzle/ folder inside app.asar (accessible as a plain path even inside
 *      the ASAR because drizzle just reads SQL files, no fork/dlopen needed).
 *   2. process.cwd()/drizzle — dev / next start from the repo root.
 *
 * Tests can override via LH_MIGRATIONS_DIR pointing at a temp copy of the
 * drizzle folder, or rely on the cwd fallback when running from the repo root.
 */
export function getMigrationsDir(): string {
  return process.env.LH_MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
}

/** Filename (within {@link getReportsDir}) of a run's raw LHR JSON report. */
export function reportJsonFilename(runId: string): string {
  return `${runId}.json`;
}

/** Filename (within {@link getReportsDir}) of a run's standalone HTML report. */
export function reportHtmlFilename(runId: string): string {
  return `${runId}.html`;
}

/** Absolute path to a run's raw LHR JSON report file. */
export function reportJsonPath(runId: string): string {
  return path.join(getReportsDir(), reportJsonFilename(runId));
}

/** Absolute path to a run's standalone HTML report file. */
export function reportHtmlPath(runId: string): string {
  return path.join(getReportsDir(), reportHtmlFilename(runId));
}
