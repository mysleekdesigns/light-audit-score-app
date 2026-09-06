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

import {
  DEFAULT_SCHEDULE_NOTIFY,
  MAX_ALERT_DELTA,
  type ScheduleNotify,
} from "@/lib/alerts/types";
import { listScheduleAlerts, recordAlerts } from "@/lib/db/alerts";
import { getDb, resetDbForTests } from "@/lib/db/client";
import {
  createSchedule,
  deleteSchedule,
  getAlertsEvaluatedBatchId,
  getSchedule,
  listSchedules,
  markAlertsEvaluated,
  updateSchedule,
} from "@/lib/db/schedules";
import { schedules } from "@/lib/db/schema";
import type { AuditOptions } from "@/lib/lighthouse/types";
import { DEFAULT_THRESHOLDS } from "@/lib/settings/defaults";
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

/**
 * Regression-alert preferences on the schedule row (ROADMAP Phase C).
 *
 * Two invariants, and the second is a real bug this phase had to fix: the
 * `notify` column self-heals (a row written before migration 0008 reads back
 * disarmed rather than crashing or, worse, armed), and deleting a schedule that
 * has ever alerted actually works — `foreign_keys = ON` and the new FK is
 * `ON DELETE no action`, so without clearing the children first the delete raises
 * a constraint error that this module's never-throwing discipline would turn
 * into a silent "no such schedule".
 */
describe("schedules — notify round-trip", () => {
  const ARMED: ScheduleNotify = {
    enabled: true,
    categories: ["performance", "seo"],
    minDelta: 12,
    thresholds: { ...DEFAULT_THRESHOLDS, performance: 75 },
  };

  it("defaults to the disarmed factory config when notify is omitted", () => {
    const created = createSchedule(makeInput(OPTIONS))!;
    expect(created.notify).toEqual(DEFAULT_SCHEDULE_NOTIFY);
    expect(created.notify.enabled).toBe(false);
    expect(getSchedule(created.id)!.notify).toEqual(DEFAULT_SCHEDULE_NOTIFY);
  });

  it("persists an armed config so create → read is a fixed point", () => {
    const created = createSchedule({ ...makeInput(OPTIONS), notify: ARMED })!;
    expect(created.notify).toEqual(ARMED);
    expect(getSchedule(created.id)!.notify).toEqual(ARMED);
  });

  it("reads a legacy row (notify IS NULL) back as the disarmed default", () => {
    const created = createSchedule({ ...makeInput(OPTIONS), notify: ARMED })!;
    // Exactly what every row written before migration 0008 looks like.
    getDb()
      .update(schedules)
      .set({ notify: null })
      .where(eq(schedules.id, created.id))
      .run();

    const read = getSchedule(created.id)!;
    expect(read.notify).toEqual(DEFAULT_SCHEDULE_NOTIFY);
    // The self-healing clause that matters: upgrading the app never arms a
    // schedule the user did not arm.
    expect(read.notify.enabled).toBe(false);
    // And the row is still listable, not dropped.
    expect(listSchedules().map((s) => s.id)).toContain(created.id);
  });

  it("repairs an unparseable or malformed stored blob instead of dropping the row", () => {
    const created = createSchedule({ ...makeInput(OPTIONS), notify: ARMED })!;
    getDb()
      .update(schedules)
      .set({ notify: "{not json" })
      .where(eq(schedules.id, created.id))
      .run();
    expect(getSchedule(created.id)!.notify).toEqual(DEFAULT_SCHEDULE_NOTIFY);

    getDb()
      .update(schedules)
      .set({
        notify: JSON.stringify({
          enabled: "yes",
          categories: ["performance", "not-a-category"],
          minDelta: 9999,
          thresholds: { performance: 250 },
        }),
      })
      .where(eq(schedules.id, created.id))
      .run();
    expect(getSchedule(created.id)!.notify).toEqual({
      // Only an explicit `true` arms a schedule.
      enabled: false,
      categories: ["performance"],
      minDelta: MAX_ALERT_DELTA,
      thresholds: { ...DEFAULT_THRESHOLDS, performance: 100 },
    });
  });

  it("updateSchedule keeps the stored config when the patch omits notify", () => {
    const created = createSchedule({ ...makeInput(OPTIONS), notify: ARMED })!;
    const updated = updateSchedule(created.id, { enabled: false })!;
    expect(updated.notify).toEqual(ARMED);
    expect(getSchedule(created.id)!.notify).toEqual(ARMED);
  });

  it("updateSchedule replaces the config when the patch carries one", () => {
    const created = createSchedule({ ...makeInput(OPTIONS), notify: ARMED })!;
    const updated = updateSchedule(created.id, {
      notify: { ...ARMED, enabled: false, minDelta: 3 },
    })!;
    expect(updated.notify).toMatchObject({ enabled: false, minDelta: 3 });
    expect(getSchedule(created.id)!.notify).toEqual(updated.notify);
  });

  it("stores nothing credential-shaped alongside the preferences", () => {
    const created = createSchedule({ ...makeInput(OPTIONS), notify: ARMED })!;
    const [row] = getDb()
      .select({ notify: schedules.notify })
      .from(schedules)
      .where(eq(schedules.id, created.id))
      .all();
    expect(Object.keys(JSON.parse(row.notify!)).sort()).toEqual([
      "categories",
      "enabled",
      "minDelta",
      "thresholds",
    ]);
  });
});

describe("schedules — alert bookkeeping", () => {
  it("markAlertsEvaluated round-trips, and is not exposed on the public Schedule", () => {
    const created = createSchedule(makeInput(OPTIONS))!;
    expect(getAlertsEvaluatedBatchId(created.id)).toBeUndefined();

    markAlertsEvaluated(created.id, "batch-1");
    expect(getAlertsEvaluatedBatchId(created.id)).toBe("batch-1");
    markAlertsEvaluated(created.id, "batch-2");
    expect(getAlertsEvaluatedBatchId(created.id)).toBe("batch-2");

    // The marker is scheduler bookkeeping; the browser-facing type never sees it.
    expect("alertsEvaluatedBatchId" in getSchedule(created.id)!).toBe(false);
    expect(getAlertsEvaluatedBatchId("does-not-exist")).toBeUndefined();
  });

  it("deleteSchedule removes a schedule that has alerted, and its alerts with it", () => {
    const created = createSchedule(makeInput(OPTIONS))!;
    recordAlerts(
      created.id,
      "b2",
      "b1",
      [
        {
          kind: "crossed_below",
          url: "https://staging.test/",
          formFactor: "mobile",
          category: "performance",
          previous: 95,
          current: 70,
          delta: -25,
          threshold: 90,
        },
      ],
      false,
    );
    expect(listScheduleAlerts(created.id)).toHaveLength(1);

    // Without clearing the children first this is a FK constraint error, which
    // the module swallows into `false` → the route answers 404 for a schedule
    // that plainly exists.
    expect(deleteSchedule(created.id)).toBe(true);
    expect(getSchedule(created.id)).toBeUndefined();
    expect(listScheduleAlerts(created.id)).toEqual([]);
  });
});
