/**
 * Round-trip tests for the `app_settings` preference store.
 *
 * Hermetic like the other DB tests: `LH_DATA_DIR` points at a temp dir and the
 * lazy client is reset between cases, so the real migrations run against a
 * throwaway SQLite file — which also proves the `app_settings` migration lands.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDbForTests } from "@/lib/db/client";
import {
  deleteAppSetting,
  getAppSetting,
  getBooleanSetting,
  setAppSetting,
  setBooleanSetting,
} from "@/lib/db/settings";

let dir: string;
let savedDataDir: string | undefined;
let savedDbPath: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.LH_DATA_DIR;
  savedDbPath = process.env.LH_DB_PATH;
  dir = mkdtempSync(path.join(tmpdir(), "lightaudit-settings-"));
  process.env.LH_DATA_DIR = dir;
  delete process.env.LH_DB_PATH;
  resetDbForTests();
});

afterEach(() => {
  resetDbForTests();
  if (savedDataDir === undefined) delete process.env.LH_DATA_DIR;
  else process.env.LH_DATA_DIR = savedDataDir;
  if (savedDbPath === undefined) delete process.env.LH_DB_PATH;
  else process.env.LH_DB_PATH = savedDbPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("app settings store", () => {
  it("reads null for a setting that was never written", () => {
    expect(getAppSetting("nothing.here")).toBeNull();
  });

  it("writes, reads back, and overwrites a value", () => {
    setAppSetting("a.b", "one");
    expect(getAppSetting("a.b")).toBe("one");

    setAppSetting("a.b", "two");
    expect(getAppSetting("a.b")).toBe("two");
  });

  it("deletes a setting so its default applies again", () => {
    setAppSetting("a.b", "one");
    deleteAppSetting("a.b");
    expect(getAppSetting("a.b")).toBeNull();

    // Nothing to remove is not an error.
    expect(() => deleteAppSetting("a.b")).not.toThrow();
  });

  it("stores booleans as true/false strings with a caller-chosen default", () => {
    expect(getBooleanSetting("flag", true)).toBe(true);
    expect(getBooleanSetting("flag", false)).toBe(false);

    setBooleanSetting("flag", true);
    expect(getAppSetting("flag")).toBe("true");
    expect(getBooleanSetting("flag", false)).toBe(true);

    setBooleanSetting("flag", false);
    expect(getBooleanSetting("flag", true)).toBe(false);
  });

  it("treats an unparseable boolean as unset", () => {
    setAppSetting("flag", "maybe");

    expect(getBooleanSetting("flag", true)).toBe(true);
  });
});
