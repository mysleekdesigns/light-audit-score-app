/**
 * App-level preference store — the `app_settings` key/value table.
 *
 * Holds the handful of things the user toggles from the Settings page (today:
 * whether the CrawlForge research server is enabled, and which AI provider +
 * model the user picked). It is deliberately NOT a home for credentials: keys live in the environment (`.env`) and are only ever
 * reported as present or absent, never written to SQLite.
 *
 * Reads follow the log-and-swallow discipline of the other DB modules — a
 * preference that can't be read degrades to its default, never to a crash in
 * the analysis engine. Writes throw, so a route can answer honestly when the
 * toggle did not stick.
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { appSettings } from "@/lib/db/schema";

/** Read one setting's raw string value, or `null` when unset (or unreadable). */
export function getAppSetting(key: string): string | null {
  try {
    const row = getDb()
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get();
    return row?.value ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[settings] read "${key}" failed: ${message}`);
    return null;
  }
}

/** Write (upsert) one setting. Throws on a DB failure so callers can report it. */
export function setAppSetting(key: string, value: string): void {
  const updatedAt = new Date().toISOString();
  getDb()
    .insert(appSettings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt },
    })
    .run();
}

/** Remove one setting so its default applies again. Throws on a DB failure. */
export function deleteAppSetting(key: string): void {
  getDb().delete(appSettings).where(eq(appSettings.key, key)).run();
}

/** Read a boolean setting stored as `"true"` / `"false"`, with a default. */
export function getBooleanSetting(key: string, fallback: boolean): boolean {
  const raw = getAppSetting(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/** Store a boolean setting as `"true"` / `"false"`. */
export function setBooleanSetting(key: string, value: boolean): void {
  setAppSetting(key, value ? "true" : "false");
}
