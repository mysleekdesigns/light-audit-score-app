/**
 * Schedule persistence tests — credential discipline (ROADMAP Phase B).
 *
 * Hermetic like the other DB tests: `LH_DATA_DIR`/`LH_DB_PATH` point at a fresh
 * temp dir and `resetDbForTests()` re-inits the lazy client, so the real
 * migrations run against a throwaway SQLite file.
 *
 * A schedule fires days later with no batch in memory, so unlike a run it does
 * not even keep credential NAMES: `createSchedule`/`updateSchedule` strip the
 * fields outright, and the {@link Schedule} they return matches what a later
 * read gives back. The long-lived route is `.env` (`LH_AUDIT_BASIC_AUTH` and
 * friends), read inside the forked worker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb, resetDbForTests } from "@/lib/db/client";
import {
  createSchedule,
  getSchedule,
  updateSchedule,
} from "@/lib/db/schedules";
import { schedules } from "@/lib/db/schema";
import type { AuditOptions } from "@/lib/lighthouse/types";
import type { CreateScheduleInput } from "@/lib/schedules/types";

let dir: string;
let savedDataDir: string | undefined;
let savedDbPath: string | undefined;

const SECRET_HEADER_VALUE = "preview-token-do-not-persist";
const SECRET_COOKIE_VALUE = "session-value-do-not-persist";
const SECRET_PASSWORD = "basic-auth-password-do-not-persist";
const SECRETS = [SECRET_HEADER_VALUE, SECRET_COOKIE_VALUE, SECRET_PASSWORD];

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "seo"],
  runs: 3,
  warmCache: true,
};

const CREDENTIALED_OPTIONS: AuditOptions = {
  ...OPTIONS,
  extraHeaders: { "X-Preview-Token": SECRET_HEADER_VALUE },
  cookies: { session: SECRET_COOKIE_VALUE },
  basicAuth: { username: "staging", password: SECRET_PASSWORD },
};

function makeInput(options: AuditOptions): CreateScheduleInput {
  return {
    name: "Nightly staging",
    enabled: true,
    cadence: "daily",
    time: "09:00",
    target: { kind: "urls", urls: ["https://staging.test/"] },
    options,
    concurrency: 3,
    device: "mobile",
    accuracyMode: false,
    source: "local",
  };
}

/** The `schedules.options` column exactly as stored (no parsing). */
function rawOptions(id: string): string {
  const [row] = getDb()
    .select({ options: schedules.options })
    .from(schedules)
    .where(eq(schedules.id, id))
    .all();
  return row.options;
}

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
}

beforeEach(() => {
  savedDataDir = process.env.LH_DATA_DIR;
  savedDbPath = process.env.LH_DB_PATH;
  dir = mkdtempSync(path.join(tmpdir(), "lightaudit-schedules-"));
  process.env.LH_DATA_DIR = dir;
  process.env.LH_DB_PATH = path.join(dir, "test.db");
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

describe("schedules — credential stripping", () => {
  it("createSchedule persists no credential fields at all", () => {
    const created = createSchedule(makeInput(CREDENTIALED_OPTIONS))!;
    expect(created).not.toBeNull();

    const stored = rawOptions(created.id);
    expectNoSecrets(stored);
    // Not even the names: a schedule that cannot supply a credential must not
    // claim it will use one.
    expect(stored).not.toContain("X-Preview-Token");
    expect(stored).not.toContain("extraHeaders");
    expect(stored).not.toContain("cookies");
    expect(stored).not.toContain("basicAuth");
    // The rest of the options are untouched.
    expect(JSON.parse(stored)).toEqual(OPTIONS);

    // The returned object matches what a later read gives back.
    expect(created.options).toEqual(OPTIONS);
    expect(getSchedule(created.id)!.options).toEqual(OPTIONS);
  });

  it("updateSchedule cannot introduce credentials on an existing schedule", () => {
    const created = createSchedule(makeInput(OPTIONS))!;

    const updated = updateSchedule(created.id, {
      options: CREDENTIALED_OPTIONS,
    })!;
    expect(updated).not.toBeNull();

    const stored = rawOptions(created.id);
    expectNoSecrets(stored);
    expect(JSON.parse(stored)).toEqual(OPTIONS);
    expect(updated.options).toEqual(OPTIONS);
    expect(getSchedule(created.id)!.options).toEqual(OPTIONS);
  });

  it("leaves a credential-free schedule's options untouched through an unrelated patch", () => {
    const created = createSchedule(makeInput(OPTIONS))!;

    const updated = updateSchedule(created.id, { enabled: false })!;
    expect(updated.enabled).toBe(false);
    expect(updated.options).toEqual(OPTIONS);
    expect(JSON.parse(rawOptions(created.id))).toEqual(OPTIONS);
  });
});
