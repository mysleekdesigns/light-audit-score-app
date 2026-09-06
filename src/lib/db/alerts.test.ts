/**
 * Regression-alert persistence tests (ROADMAP Phase C).
 *
 * Hermetic like the other DB tests: `LH_DATA_DIR`/`LH_DB_PATH` point at a fresh
 * temp dir and `resetDbForTests()` re-inits the lazy client, so the real
 * migrations (including 0008) run against a throwaway SQLite file.
 *
 * Batches and runs are inserted directly rather than driven through the queue —
 * this module's contract is "given these rows, produce this comparison input",
 * and writing the rows as literals is what makes the null-vs-zero and
 * status-filtering cases legible.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ScheduleAlert } from "@/lib/alerts/types";
import {
  deleteScheduleAlerts,
  listRecentAlerts,
  listScheduleAlerts,
  previousCompletedBatchId,
  readBatchRunScores,
  recordAlerts,
} from "@/lib/db/alerts";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createSchedule } from "@/lib/db/schedules";
import { batches, runs, scheduleAlerts } from "@/lib/db/schema";
import { DEFAULT_OPTIONS } from "@/lib/lighthouse/options";
import type { BatchStatus } from "@/lib/queue/types";
import type { CreateScheduleInput } from "@/lib/schedules/types";

let dir: string;
let savedDataDir: string | undefined;
let savedDbPath: string | undefined;

function makeScheduleInput(
  overrides: Partial<CreateScheduleInput> = {},
): CreateScheduleInput {
  return {
    name: "Nightly",
    enabled: true,
    cadence: "daily",
    time: "09:00",
    target: { kind: "urls", urls: ["https://example.test/"] },
    options: DEFAULT_OPTIONS,
    concurrency: 1,
    device: "mobile",
    accuracyMode: false,
    source: "local",
    ...overrides,
  };
}

/** Insert a `batches` row directly (the queue is not involved in these tests). */
function insertBatch(
  id: string,
  scheduleId: string | null,
  status: BatchStatus,
  createdAt: string,
): void {
  getDb()
    .insert(batches)
    .values({
      id,
      status,
      source: "local",
      options: JSON.stringify(DEFAULT_OPTIONS),
      concurrency: 1,
      total: 1,
      priorBatchId: null,
      scheduleId,
      createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
    })
    .run();
}

/** Insert a `runs` row directly, with only the columns these tests care about. */
function insertRun(
  batchId: string,
  idx: number,
  patch: {
    url: string;
    status?: "done" | "error";
    formFactor?: "mobile" | "desktop";
    performance?: number | null;
    accessibility?: number | null;
    bestPractices?: number | null;
    seo?: number | null;
    agenticBrowsing?: number | null;
  },
): void {
  getDb()
    .insert(runs)
    .values({
      id: `${batchId}-run-${idx}`,
      batchId,
      idx,
      url: patch.url,
      finalUrl: patch.url,
      status: patch.status ?? "done",
      source: "local",
      errorMessage: null,
      formFactor: patch.formFactor ?? "mobile",
      throttling: "simulated",
      runs: 1,
      lighthouseVersion: "13.3.0",
      scorePerformance: patch.performance ?? null,
      scoreAccessibility: patch.accessibility ?? null,
      scoreBestPractices: patch.bestPractices ?? null,
      scoreSeo: patch.seo ?? null,
      scoreAgenticBrowsing: patch.agenticBrowsing ?? null,
      options: JSON.stringify(DEFAULT_OPTIONS),
      metrics: null,
      field: null,
      benchmarkIndex: null,
      hostUserAgent: null,
      throttlingMethod: null,
      cpuSlowdownMultiplier: null,
      reportJson: null,
      reportHtml: null,
      fetchTime: null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

function makeAlert(overrides: Partial<ScheduleAlert> = {}): ScheduleAlert {
  return {
    kind: "crossed_below",
    url: "https://example.test/",
    formFactor: "mobile",
    category: "performance",
    previous: 95,
    current: 70,
    delta: -25,
    threshold: 90,
    ...overrides,
  };
}

beforeEach(() => {
  savedDataDir = process.env.LH_DATA_DIR;
  savedDbPath = process.env.LH_DB_PATH;
  dir = mkdtempSync(path.join(tmpdir(), "lightaudit-alerts-"));
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

describe("readBatchRunScores", () => {
  it("projects done runs to (url, formFactor, scores) in batch order", () => {
    insertBatch("b1", "s1", "completed", "2026-09-01T09:00:00.000Z");
    insertRun("b1", 0, {
      url: "https://example.test/",
      performance: 91,
      accessibility: 88,
      bestPractices: 100,
      seo: 92,
      agenticBrowsing: 67,
    });
    insertRun("b1", 1, {
      url: "https://example.test/about",
      formFactor: "desktop",
      performance: 99,
    });

    expect(readBatchRunScores("b1")).toEqual([
      {
        url: "https://example.test/",
        formFactor: "mobile",
        scores: {
          performance: 91,
          accessibility: 88,
          "best-practices": 100,
          seo: 92,
          "agentic-browsing": 67,
        },
      },
      {
        url: "https://example.test/about",
        formFactor: "desktop",
        scores: {
          performance: 99,
          accessibility: null,
          "best-practices": null,
          seo: null,
          "agentic-browsing": null,
        },
      },
    ]);
  });

  it("never coalesces an unscored category to 0", () => {
    insertBatch("b1", "s1", "completed", "2026-09-01T09:00:00.000Z");
    insertRun("b1", 0, { url: "https://example.test/", performance: 0 });

    const [row] = readBatchRunScores("b1");
    // A real 0 survives as 0; the categories that were never scored stay null.
    expect(row.scores.performance).toBe(0);
    expect(row.scores.seo).toBeNull();
    expect(row.scores["agentic-browsing"]).toBeNull();
  });

  it("excludes failed runs — an errored page has no score, it did not drop to 0", () => {
    insertBatch("b1", "s1", "completed_with_errors", "2026-09-01T09:00:00.000Z");
    insertRun("b1", 0, { url: "https://example.test/ok", performance: 80 });
    insertRun("b1", 1, { url: "https://example.test/bad", status: "error" });

    expect(readBatchRunScores("b1").map((r) => r.url)).toEqual([
      "https://example.test/ok",
    ]);
  });

  it("returns [] for an unknown batch", () => {
    expect(readBatchRunScores("nope")).toEqual([]);
  });
});

describe("previousCompletedBatchId", () => {
  it("returns the schedule's most recent completed batch before the reference", () => {
    insertBatch("b1", "s1", "completed", "2026-09-01T09:00:00.000Z");
    insertBatch("b2", "s1", "completed_with_errors", "2026-09-02T09:00:00.000Z");
    insertBatch("b3", "s1", "completed", "2026-09-03T09:00:00.000Z");

    expect(previousCompletedBatchId("s1", "b3")).toBe("b2");
    expect(previousCompletedBatchId("s1", "b2")).toBe("b1");
  });

  it("skips cancelled, queued and running batches", () => {
    insertBatch("b1", "s1", "completed", "2026-09-01T09:00:00.000Z");
    // A paused batch holds a partial URL set — comparing against it would report
    // every unaudited page as a change.
    insertBatch("b2", "s1", "cancelled", "2026-09-02T09:00:00.000Z");
    insertBatch("b3", "s1", "running", "2026-09-03T09:00:00.000Z");
    insertBatch("b4", "s1", "queued", "2026-09-04T09:00:00.000Z");
    insertBatch("b5", "s1", "completed", "2026-09-05T09:00:00.000Z");

    expect(previousCompletedBatchId("s1", "b5")).toBe("b1");
  });

  it("never crosses schedules, and ignores ad-hoc batches", () => {
    insertBatch("other", "s2", "completed", "2026-09-01T09:00:00.000Z");
    insertBatch("adhoc", null, "completed", "2026-09-01T12:00:00.000Z");
    insertBatch("mine", "s1", "completed", "2026-09-02T09:00:00.000Z");

    expect(previousCompletedBatchId("s1", "mine")).toBeUndefined();
  });

  it("returns undefined on a first fire and for an unknown reference batch", () => {
    insertBatch("b1", "s1", "completed", "2026-09-01T09:00:00.000Z");
    expect(previousCompletedBatchId("s1", "b1")).toBeUndefined();
    // Unknown reference: no position in the timeline, so never fall back to
    // "the newest other batch".
    expect(previousCompletedBatchId("s1", "does-not-exist")).toBeUndefined();
  });
});

describe("recordAlerts / listScheduleAlerts", () => {
  it("round-trips every field of an alert and stamps the provenance", () => {
    const schedule = createSchedule(makeScheduleInput())!;
    const alert = makeAlert({ kind: "dropped_by", threshold: null, delta: -7 });

    const records = recordAlerts(schedule.id, "b2", "b1", [alert], true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ...alert,
      scheduleId: schedule.id,
      batchId: "b2",
      priorBatchId: "b1",
      delivered: true,
    });
    expect(typeof records[0].id).toBe("string");

    // What a later read gives back is what the write returned.
    expect(listScheduleAlerts(schedule.id)).toEqual(records);
  });

  it("records a delivery failure as delivered:false rather than dropping the row", () => {
    const schedule = createSchedule(makeScheduleInput())!;
    recordAlerts(schedule.id, "b2", "b1", [makeAlert()], false);

    const [record] = listScheduleAlerts(schedule.id);
    expect(record.delivered).toBe(false);
  });

  it("writes one row per alert and returns [] for an empty set", () => {
    const schedule = createSchedule(makeScheduleInput())!;
    const alerts = [
      makeAlert({ category: "performance" }),
      makeAlert({ category: "seo", kind: "recovered_above" }),
      makeAlert({ category: "accessibility", formFactor: "desktop" }),
    ];
    expect(recordAlerts(schedule.id, "b2", "b1", alerts, true)).toHaveLength(3);
    expect(listScheduleAlerts(schedule.id)).toHaveLength(3);

    expect(recordAlerts(schedule.id, "b3", "b2", [], true)).toEqual([]);
    expect(listScheduleAlerts(schedule.id)).toHaveLength(3);
  });

  it("lists newest first and honours the limit", () => {
    const schedule = createSchedule(makeScheduleInput())!;
    recordAlerts(schedule.id, "b2", "b1", [makeAlert({ current: 10 })], true);
    // Force a distinct timestamp: rows of one comparison share a createdAt.
    getDb()
      .update(scheduleAlerts)
      .set({ createdAt: "2026-09-01T09:00:00.000Z" })
      .where(eq(scheduleAlerts.batchId, "b2"))
      .run();
    recordAlerts(schedule.id, "b3", "b2", [makeAlert({ current: 20 })], true);

    const listed = listScheduleAlerts(schedule.id);
    expect(listed.map((a) => a.batchId)).toEqual(["b3", "b2"]);
    expect(listScheduleAlerts(schedule.id, 1).map((a) => a.batchId)).toEqual(["b3"]);
    expect(listScheduleAlerts(schedule.id, 0)).toEqual([]);
  });

  it("drops a row whose free-text kind or category this build can't name", () => {
    const schedule = createSchedule(makeScheduleInput())!;
    recordAlerts(schedule.id, "b2", "b1", [makeAlert(), makeAlert({ category: "seo" })], true);

    // Simulate a row written by a newer build (or hand-edited): the column is
    // plain TEXT, so nothing stops a value this build has never heard of.
    getDb()
      .update(scheduleAlerts)
      .set({ kind: "vanished_entirely" })
      .where(eq(scheduleAlerts.category, "seo"))
      .run();

    const listed = listScheduleAlerts(schedule.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].category).toBe("performance");

    // Same for an unknown category — dropped, never thrown.
    getDb()
      .update(scheduleAlerts)
      .set({ category: "quantum-readiness" })
      .where(eq(scheduleAlerts.category, "performance"))
      .run();
    expect(listScheduleAlerts(schedule.id)).toEqual([]);
  });

  it("returns [] for a schedule that has never alerted", () => {
    const schedule = createSchedule(makeScheduleInput())!;
    expect(listScheduleAlerts(schedule.id)).toEqual([]);
  });
});

describe("listRecentAlerts", () => {
  it("merges every schedule's most recent alerts, newest first", () => {
    const a = createSchedule(makeScheduleInput({ name: "A" }))!;
    const b = createSchedule(makeScheduleInput({ name: "B" }))!;

    recordAlerts(a.id, "a2", "a1", [makeAlert()], true);
    getDb()
      .update(scheduleAlerts)
      .set({ createdAt: "2026-09-01T09:00:00.000Z" })
      .where(eq(scheduleAlerts.scheduleId, a.id))
      .run();
    recordAlerts(b.id, "b2", "b1", [makeAlert()], true);

    const recent = listRecentAlerts();
    expect(recent.map((r) => r.scheduleId)).toEqual([b.id, a.id]);
  });

  it("caps per schedule, so a chatty schedule can't crowd out a quiet one", () => {
    const a = createSchedule(makeScheduleInput({ name: "A" }))!;
    const b = createSchedule(makeScheduleInput({ name: "B" }))!;
    recordAlerts(
      a.id,
      "a2",
      "a1",
      [makeAlert(), makeAlert({ category: "seo" }), makeAlert({ category: "accessibility" })],
      true,
    );
    recordAlerts(b.id, "b2", "b1", [makeAlert()], true);

    const recent = listRecentAlerts(1);
    expect(recent).toHaveLength(2);
    expect(new Set(recent.map((r) => r.scheduleId))).toEqual(new Set([a.id, b.id]));
    expect(listRecentAlerts(0)).toEqual([]);
  });

  it("returns [] when nothing has ever alerted", () => {
    expect(listRecentAlerts()).toEqual([]);
  });
});

describe("deleteScheduleAlerts", () => {
  it("removes only the named schedule's rows and reports the count", () => {
    const a = createSchedule(makeScheduleInput({ name: "A" }))!;
    const b = createSchedule(makeScheduleInput({ name: "B" }))!;
    recordAlerts(a.id, "a2", "a1", [makeAlert(), makeAlert({ category: "seo" })], true);
    recordAlerts(b.id, "b2", "b1", [makeAlert()], true);

    expect(deleteScheduleAlerts(a.id)).toBe(2);
    expect(listScheduleAlerts(a.id)).toEqual([]);
    expect(listScheduleAlerts(b.id)).toHaveLength(1);
    // Idempotent: a second delete removes nothing and does not throw.
    expect(deleteScheduleAlerts(a.id)).toBe(0);
  });
});


describe("previousCompletedBatchId scoping (security review L4)", () => {
  it("ignores a reference batch belonging to a different schedule", () => {
    // Both callers pass the schedule's own batch today. Without the scheduleId
    // predicate, a caller that didn't would anchor this schedule's timeline to
    // someone else's fire and compare against the wrong baseline.
    insertBatch("mine-old", "sch-a", "completed", "2026-01-01T00:00:00.000Z");
    insertBatch("mine-new", "sch-a", "completed", "2026-01-03T00:00:00.000Z");
    insertBatch("theirs", "sch-b", "completed", "2026-01-02T00:00:00.000Z");

    // Sanity: the in-schedule lookup still resolves.
    expect(previousCompletedBatchId("sch-a", "mine-new")).toBe("mine-old");
    // A foreign reference resolves to nothing rather than to "mine-old".
    expect(previousCompletedBatchId("sch-a", "theirs")).toBeUndefined();
  });
});
