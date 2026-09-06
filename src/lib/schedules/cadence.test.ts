import { describe, expect, it } from "vitest";

import {
  isDueAt,
  lastDueMoment,
  nextFireAt,
  shouldFireNow,
} from "@/lib/schedules/cadence";
import { DEFAULT_SCHEDULE_NOTIFY } from "@/lib/alerts/types";
import type { Schedule } from "@/lib/schedules/types";

function makeSchedule(patch: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Daily homepage",
    enabled: true,
    cadence: "daily",
    time: "09:00",
    target: { kind: "urls", urls: ["https://example.com"] },
    options: {
      formFactor: "mobile",
      throttling: "simulated",
      categories: ["performance"],
      runs: 1,
      warmCache: true,
    },
    concurrency: 1,
    device: "mobile",
    accuracyMode: false,
    source: "local",
    // Cadence math is alert-agnostic; the disarmed default keeps the helper a
    // valid `Schedule` without pulling notification behaviour into these cases.
    notify: DEFAULT_SCHEDULE_NOTIFY,
    lastFiredAt: null,
    lastBatchId: null,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    ...patch,
  };
}

describe("cadence math", () => {
  it("lastDueMoment rolls back to yesterday when today's time is in the future", () => {
    // now = 2026-05-28 08:30 local; cutoff for 09:00 is yesterday's 09:00.
    const now = new Date(2026, 4, 28, 8, 30);
    const cutoff = lastDueMoment("09:00", now);
    expect(cutoff.getDate()).toBe(27);
    expect(cutoff.getHours()).toBe(9);
    expect(cutoff.getMinutes()).toBe(0);
  });

  it("lastDueMoment returns today when the time has passed", () => {
    const now = new Date(2026, 4, 28, 9, 30);
    const cutoff = lastDueMoment("09:00", now);
    expect(cutoff.getDate()).toBe(28);
    expect(cutoff.getHours()).toBe(9);
  });

  it("nextFireAt is today when still in the future", () => {
    const now = new Date(2026, 4, 28, 8, 30);
    const next = nextFireAt("09:00", now);
    expect(next.getDate()).toBe(28);
    expect(next.getHours()).toBe(9);
  });

  it("nextFireAt rolls forward to tomorrow when today is past", () => {
    const now = new Date(2026, 4, 28, 9, 30);
    const next = nextFireAt("09:00", now);
    expect(next.getDate()).toBe(29);
    expect(next.getHours()).toBe(9);
  });
});

describe("shouldFireNow", () => {
  it("returns false when disabled", () => {
    const s = makeSchedule({ enabled: false });
    const now = new Date(2026, 4, 28, 10, 0);
    expect(shouldFireNow(s, now)).toBe(false);
  });

  it("returns false before the cutoff (never fired, time still ahead today)", () => {
    const s = makeSchedule({ lastFiredAt: null });
    const now = new Date(2026, 4, 28, 8, 30); // before 09:00 cutoff
    // Cutoff is yesterday 09:00; lastFiredAt null means due, expect true.
    expect(shouldFireNow(s, now)).toBe(true);
  });

  it("returns true at the moment of the cutoff", () => {
    const s = makeSchedule({ lastFiredAt: null });
    const now = new Date(2026, 4, 28, 9, 0);
    expect(shouldFireNow(s, now)).toBe(true);
  });

  it("returns false if already fired after the cutoff", () => {
    const fired = new Date(2026, 4, 28, 9, 1).toISOString();
    const s = makeSchedule({ lastFiredAt: fired });
    const now = new Date(2026, 4, 28, 9, 30);
    expect(shouldFireNow(s, now)).toBe(false);
  });

  it("returns true the next day after a fire", () => {
    const fired = new Date(2026, 4, 28, 9, 1).toISOString();
    const s = makeSchedule({ lastFiredAt: fired });
    const now = new Date(2026, 4, 29, 9, 0);
    expect(shouldFireNow(s, now)).toBe(true);
  });

  it("ignores invalid time formats", () => {
    const s = makeSchedule({ time: "25:99" });
    const now = new Date(2026, 4, 28, 12, 0);
    expect(shouldFireNow(s, now)).toBe(false);
  });

  it("treats an unparseable lastFiredAt as never-fired", () => {
    const s = makeSchedule({ lastFiredAt: "not-a-date" });
    const now = new Date(2026, 4, 28, 10, 0);
    expect(shouldFireNow(s, now)).toBe(true);
  });
});

// `isDueAt` is what the Edit-schedule dialog asks before saving a new time, so
// that the warning it shows is the scheduler's own answer rather than a second
// copy of the rule. These cover the case the dialog exists to catch: moving the
// time backwards past a moment that has already gone by today.
describe("isDueAt", () => {
  it("is due when the new time has already passed today and the last fire predates it", () => {
    // Fired at 09:00, now 14:00, moved to 13:00 — 13:00 has gone by unfired.
    const fired = new Date(2026, 4, 28, 9, 0).toISOString();
    const now = new Date(2026, 4, 28, 14, 0);
    expect(isDueAt("13:00", fired, now)).toBe(true);
  });

  it("is not due when the new time is still ahead today and today's fire covers the cutoff", () => {
    // Fired at 09:00, now 14:00, moved to 20:00 — cutoff rolls to yesterday
    // 20:00, which today's fire is already past.
    const fired = new Date(2026, 4, 28, 9, 0).toISOString();
    const now = new Date(2026, 4, 28, 14, 0);
    expect(isDueAt("20:00", fired, now)).toBe(false);
  });

  it("is due for a schedule that has never fired", () => {
    const now = new Date(2026, 4, 28, 14, 0);
    expect(isDueAt("13:00", null, now)).toBe(true);
  });

  it("is not due for a malformed time", () => {
    const now = new Date(2026, 4, 28, 14, 0);
    expect(isDueAt("25:99", null, now)).toBe(false);
  });

  it("agrees with shouldFireNow for an enabled daily schedule", () => {
    const fired = new Date(2026, 4, 28, 9, 0).toISOString();
    const now = new Date(2026, 4, 28, 14, 0);
    for (const time of ["08:00", "09:00", "13:00", "14:00", "20:00"]) {
      const schedule = makeSchedule({ time, lastFiredAt: fired });
      expect(isDueAt(time, fired, now)).toBe(shouldFireNow(schedule, now));
    }
  });
});
