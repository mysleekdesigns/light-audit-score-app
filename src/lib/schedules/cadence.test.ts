import { describe, expect, it } from "vitest";

import {
  lastDueMoment,
  nextFireAt,
  shouldFireNow,
} from "@/lib/schedules/cadence";
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
