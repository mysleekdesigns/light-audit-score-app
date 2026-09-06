/**
 * Unit tests for `alerts-data.ts` — the Archive alert strip's grouping,
 * band mapping, age formatting and card-readout derivation. Pure + synchronous;
 * no React, no DOM, no network.
 *
 * The load-bearing cases are the two that encode a *judgement* rather than a
 * mapping: `recovered_above` must wear the good band even when the recovered
 * score sits in the average band (a recovery rendered amber reads as a
 * warning), and `describeAlertsStatus` must stay silent about a disarmed
 * schedule's stored categories and delta — they are persisted but inert, and
 * printing them would imply the schedule is watching something.
 */

import { describe, expect, it } from "vitest";

import {
  alertBand,
  describeAlertsStatus,
  formatAlertAge,
  groupAlertsBySchedule,
  notifyEquals,
} from "@/components/archive/alerts-data";
import {
  DEFAULT_SCHEDULE_NOTIFY,
  type ScheduleAlertRecord,
  type ScheduleNotify,
} from "@/lib/alerts/types";
import { LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";

function alertRow(patch: Partial<ScheduleAlertRecord> = {}): ScheduleAlertRecord {
  return {
    id: "a1",
    scheduleId: "s1",
    batchId: "b2",
    priorBatchId: "b1",
    delivered: false,
    createdAt: "2026-09-05T12:00:00.000Z",
    kind: "crossed_below",
    url: "https://example.com/",
    formFactor: "mobile",
    category: "performance",
    previous: 92,
    current: 71,
    delta: -21,
    threshold: 90,
    ...patch,
  };
}

function notify(patch: Partial<ScheduleNotify> = {}): ScheduleNotify {
  return { ...DEFAULT_SCHEDULE_NOTIFY, ...patch };
}

describe("groupAlertsBySchedule", () => {
  it("buckets rows by scheduleId and keeps the reader's order within a bucket", () => {
    const grouped = groupAlertsBySchedule([
      alertRow({ id: "1", scheduleId: "s1" }),
      alertRow({ id: "2", scheduleId: "s2" }),
      alertRow({ id: "3", scheduleId: "s1" }),
    ]);

    expect([...grouped.keys()]).toEqual(["s1", "s2"]);
    expect(grouped.get("s1")?.map((a) => a.id)).toEqual(["1", "3"]);
    expect(grouped.get("s2")?.map((a) => a.id)).toEqual(["2"]);
  });

  it("returns an empty map for no rows, so a card asks for a missing key safely", () => {
    const grouped = groupAlertsBySchedule([]);
    expect(grouped.size).toBe(0);
    expect(grouped.get("s1")).toBeUndefined();
  });
});

describe("alertBand", () => {
  it("maps each kind onto an existing score-band token", () => {
    expect(alertBand("crossed_below")).toBe("poor");
    expect(alertBand("dropped_by")).toBe("average");
    expect(alertBand("recovered_above")).toBe("good");
  });

  it("keeps a recovery green even when the recovered score is not in the good band", () => {
    // Bar at 50, recovered to 63 — an average-band score, but a good outcome.
    expect(alertBand("recovered_above")).toBe("good");
  });
});

describe("formatAlertAge", () => {
  const now = new Date("2026-09-05T12:00:00.000Z");

  it("returns the hydration-safe placeholder before the clock exists", () => {
    expect(formatAlertAge("2026-09-05T11:00:00.000Z", null)).toBe("…");
  });

  it("steps through minutes, hours and days", () => {
    expect(formatAlertAge("2026-09-05T11:59:30.000Z", now)).toBe("just now");
    expect(formatAlertAge("2026-09-05T11:48:00.000Z", now)).toBe("12m ago");
    expect(formatAlertAge("2026-09-05T11:00:00.000Z", now)).toBe("1h ago");
    expect(formatAlertAge("2026-09-05T07:00:00.000Z", now)).toBe("5h ago");
    expect(formatAlertAge("2026-09-02T12:00:00.000Z", now)).toBe("3d ago");
  });

  it("reads a future timestamp as 'just now' rather than a negative age", () => {
    expect(formatAlertAge("2026-09-05T12:30:00.000Z", now)).toBe("just now");
  });

  it("degrades to an em dash for an unparseable timestamp", () => {
    expect(formatAlertAge("not-a-date", now)).toBe("—");
  });
});

describe("notifyEquals", () => {
  it("is true for two distinct objects holding the same values", () => {
    expect(notifyEquals(notify(), notify())).toBe(true);
  });

  it("notices each field the dialog can change", () => {
    expect(notifyEquals(notify(), notify({ enabled: true }))).toBe(false);
    expect(notifyEquals(notify(), notify({ minDelta: 9 }))).toBe(false);
    expect(notifyEquals(notify(), notify({ categories: ["seo"] }))).toBe(false);
    expect(
      notifyEquals(
        notify(),
        notify({
          thresholds: { ...DEFAULT_SCHEDULE_NOTIFY.thresholds, seo: 75 },
        }),
      ),
    ).toBe(false);
  });

  it("notices a category set of the same size but different members", () => {
    expect(
      notifyEquals(
        notify({ categories: ["performance", "seo"] }),
        notify({ categories: ["performance", "accessibility"] }),
      ),
    ).toBe(false);
  });
});

describe("describeAlertsStatus", () => {
  it("says nothing about a disarmed schedule's stored config", () => {
    const status = describeAlertsStatus(
      notify({ enabled: false, categories: ["performance"], minDelta: 3 }),
    );
    expect(status).toEqual({ armed: false, value: "Disarmed" });
  });

  it("counts the watched categories against all five and names the delta", () => {
    const status = describeAlertsStatus(
      notify({ enabled: true, categories: ["performance", "seo"], minDelta: 7 }),
    );
    expect(status.armed).toBe(true);
    expect(status.value).toBe("Armed");
    expect(status.detail).toBe("2/5 categories · ≥7pt");
  });

  it("reports the full set when every category is watched", () => {
    const status = describeAlertsStatus(
      notify({ enabled: true, categories: [...LIGHTHOUSE_CATEGORIES], minDelta: 5 }),
    );
    expect(status.detail).toBe("5/5 categories · ≥5pt");
  });
});
