/**
 * Unit tests for src/lib/db/paths.ts — covering the data-dir relocation seams
 * added in SAAS_PLAN.md Phase A.
 *
 * The key invariant: all functions read from env vars so the calling context
 * (dev vs packaged) can be simulated by setting/clearing those vars.
 * Tests restore env state so they don't bleed into each other.
 */

import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDataDir,
  getDbPath,
  getMigrationsDir,
  getReportsDir,
  reportHtmlFilename,
  reportHtmlPath,
  reportJsonFilename,
  reportJsonPath,
} from "@/lib/db/paths";

// Snapshot of original env values to restore after each test
let origDataDir: string | undefined;
let origDbPath: string | undefined;
let origMigrationsDir: string | undefined;

beforeEach(() => {
  origDataDir = process.env.LH_DATA_DIR;
  origDbPath = process.env.LH_DB_PATH;
  origMigrationsDir = process.env.LH_MIGRATIONS_DIR;
  // Clear all three so tests start from a known state
  delete process.env.LH_DATA_DIR;
  delete process.env.LH_DB_PATH;
  delete process.env.LH_MIGRATIONS_DIR;
});

afterEach(() => {
  // Restore original values
  if (origDataDir !== undefined) process.env.LH_DATA_DIR = origDataDir;
  else delete process.env.LH_DATA_DIR;

  if (origDbPath !== undefined) process.env.LH_DB_PATH = origDbPath;
  else delete process.env.LH_DB_PATH;

  if (origMigrationsDir !== undefined) process.env.LH_MIGRATIONS_DIR = origMigrationsDir;
  else delete process.env.LH_MIGRATIONS_DIR;
});

describe("getDataDir", () => {
  it("defaults to <cwd>/data when LH_DATA_DIR is not set", () => {
    const result = getDataDir();
    expect(result).toBe(path.join(process.cwd(), "data"));
  });

  it("uses LH_DATA_DIR when set (dev mode)", () => {
    const dir = path.join(os.tmpdir(), "lh-test-data");
    process.env.LH_DATA_DIR = dir;
    expect(getDataDir()).toBe(dir);
  });

  it("uses LH_DATA_DIR when set (data kept outside the project dir)", () => {
    const userDataDir = path.join(os.homedir(), "Library", "Application Support", "LightAudit");
    process.env.LH_DATA_DIR = userDataDir;
    expect(getDataDir()).toBe(userDataDir);
  });
});

describe("getDbPath", () => {
  it("defaults to <dataDir>/lighthouse.db when LH_DB_PATH is not set", () => {
    const result = getDbPath();
    expect(result).toBe(path.join(process.cwd(), "data", "lighthouse.db"));
  });

  it("uses LH_DB_PATH when explicitly overridden", () => {
    const customPath = path.join(os.tmpdir(), "custom.db");
    process.env.LH_DB_PATH = customPath;
    expect(getDbPath()).toBe(customPath);
  });

  it("respects LH_DATA_DIR for the default DB path", () => {
    const userData = path.join(os.tmpdir(), "lightaudit-userData");
    process.env.LH_DATA_DIR = userData;
    expect(getDbPath()).toBe(path.join(userData, "lighthouse.db"));
  });
});

describe("getReportsDir", () => {
  it("defaults to <dataDir>/reports", () => {
    expect(getReportsDir()).toBe(path.join(process.cwd(), "data", "reports"));
  });

  it("resolves under LH_DATA_DIR", () => {
    const userData = path.join(os.tmpdir(), "lightaudit-userData");
    process.env.LH_DATA_DIR = userData;
    expect(getReportsDir()).toBe(path.join(userData, "reports"));
  });
});

describe("getMigrationsDir", () => {
  it("defaults to <cwd>/drizzle when LH_MIGRATIONS_DIR is not set", () => {
    expect(getMigrationsDir()).toBe(path.join(process.cwd(), "drizzle"));
  });

  it("uses LH_MIGRATIONS_DIR when set (explicit override)", () => {
    // In packaged mode, main.js sets this to the drizzle/ folder inside app.asar.
    // We simulate it with a temp path here; the function just returns the string.
    const packaged = "/Applications/LightAudit.app/Contents/Resources/app.asar/drizzle";
    process.env.LH_MIGRATIONS_DIR = packaged;
    expect(getMigrationsDir()).toBe(packaged);
  });

  it("uses LH_MIGRATIONS_DIR when set to a temp dir (test isolation)", () => {
    const tmpMigrations = path.join(os.tmpdir(), "drizzle-test");
    process.env.LH_MIGRATIONS_DIR = tmpMigrations;
    expect(getMigrationsDir()).toBe(tmpMigrations);
  });
});

describe("report path helpers", () => {
  const RUN_ID = "test-run-123";

  it("reportJsonFilename returns <runId>.json", () => {
    expect(reportJsonFilename(RUN_ID)).toBe(`${RUN_ID}.json`);
  });

  it("reportHtmlFilename returns <runId>.html", () => {
    expect(reportHtmlFilename(RUN_ID)).toBe(`${RUN_ID}.html`);
  });

  it("reportJsonPath resolves under getReportsDir()", () => {
    process.env.LH_DATA_DIR = "/tmp/test-data";
    expect(reportJsonPath(RUN_ID)).toBe(`/tmp/test-data/reports/${RUN_ID}.json`);
  });

  it("reportHtmlPath resolves under getReportsDir()", () => {
    process.env.LH_DATA_DIR = "/tmp/test-data";
    expect(reportHtmlPath(RUN_ID)).toBe(`/tmp/test-data/reports/${RUN_ID}.html`);
  });
});
