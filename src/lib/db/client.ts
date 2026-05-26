/**
 * Runtime SQLite/Drizzle client (PRD §6 Phase 4).
 *
 * Owns the single `better-sqlite3` connection + Drizzle instance. Pinned to
 * `globalThis` (like the audit queue) so Next.js dev-mode HMR reuses one
 * connection instead of opening duplicates. The connection is created lazily on
 * first {@link getDb} call so tests can set `LH_DATA_DIR`/`LH_DB_PATH` first.
 *
 * On init we ensure the data dir exists, open the DB in WAL mode with foreign
 * keys on, and apply any pending drizzle migrations from `./drizzle` — so a
 * fresh checkout (or a schema change) self-heals on first request, with no
 * manual migrate step (PRD Phase 4 Verify: restart server, history persists).
 *
 * `better-sqlite3` is in `serverExternalPackages` (next.config.ts) so it is
 * never bundled; this module is server/Node-runtime only.
 */

import { existsSync, mkdirSync } from "node:fs";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { getDataDir, getDbPath, getMigrationsDir } from "@/lib/db/paths";
import * as schema from "@/lib/db/schema";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

interface DbHandle {
  db: AppDatabase;
  sqlite: Database.Database;
  path: string;
}

const globalForDb = globalThis as typeof globalThis & {
  __lhDb?: DbHandle;
};

/** Open the connection, enable pragmas, and apply pending migrations. */
function init(): DbHandle {
  const dbPath = getDbPath();
  // `:memory:` has no parent dir; only ensure a dir for real file paths.
  if (dbPath !== ":memory:") {
    mkdirSync(getDataDir(), { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  const migrationsDir = getMigrationsDir();
  if (existsSync(migrationsDir)) {
    migrate(db, { migrationsFolder: migrationsDir });
  }

  return { db, sqlite, path: dbPath };
}

/** The shared Drizzle instance. Lazily created and cached on `globalThis`. */
export function getDb(): AppDatabase {
  return (globalForDb.__lhDb ??= init()).db;
}

/**
 * Close and forget the cached connection. Tests call this between cases (after
 * pointing `LH_DATA_DIR`/`LH_DB_PATH` at a temp dir) so each gets a fresh DB.
 */
export function resetDbForTests(): void {
  if (globalForDb.__lhDb) {
    globalForDb.__lhDb.sqlite.close();
    globalForDb.__lhDb = undefined;
  }
}
