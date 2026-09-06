import { describe, expect, it } from "vitest";

import { compareBatches, type AlertRunScore } from "@/lib/alerts/compare";
import {
  DEFAULT_SCHEDULE_NOTIFY,
  type ScheduleAlert,
  type ScheduleNotify,
} from "@/lib/alerts/types";
import { DEFAULT_THRESHOLDS } from "@/lib/settings/defaults";
import {
  LIGHTHOUSE_CATEGORIES,
  type CategoryScores,
  type FormFactor,
} from "@/lib/lighthouse/types";

const A = "https://a.example";
const B = "https://b.example";

function run(
  url: string,
  formFactor: FormFactor,
  scores: CategoryScores,
): AlertRunScore {
  return { url, formFactor, scores };
}

/** Armed schedule, all categories, all bars at 90, `dropped_by` at 5. */
function notify(patch: Partial<ScheduleNotify> = {}): ScheduleNotify {
  return {
    ...DEFAULT_SCHEDULE_NOTIFY,
    enabled: true,
    categories: [...LIGHTHOUSE_CATEGORIES],
    minDelta: 5,
    thresholds: { ...DEFAULT_THRESHOLDS },
    ...patch,
  };
}

/** Compact view of an alert for order/identity assertions. */
function shape(alert: ScheduleAlert) {
  return {
    kind: alert.kind,
    url: alert.url,
    formFactor: alert.formFactor,
    category: alert.category,
    previous: alert.previous,
    current: alert.current,
    delta: alert.delta,
    threshold: alert.threshold,
  };
}

describe("compareBatches — quiet by default", () => {
  it("emits nothing when nothing changed", () => {
    const scores: CategoryScores = {
      performance: 94,
      accessibility: 100,
      "best-practices": 92,
      seo: 91,
      "agentic-browsing": 67,
    };
    const alerts = compareBatches(
      [run(A, "mobile", scores)],
      [run(A, "mobile", { ...scores })],
      notify(),
    );
    expect(alerts).toEqual([]);
  });

  it("emits nothing for a small wobble under minDelta on the same side of the bar", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 40 })],
      [run(A, "mobile", { performance: 37 })],
      notify({ minDelta: 5 }),
    );
    expect(alerts).toEqual([]);
  });

  it("never alerts on a rise that does not clear a bar", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 41 })],
      [run(A, "mobile", { performance: 63 })],
      notify(),
    );
    expect(alerts).toEqual([]);
  });

  it("returns [] when notify is disabled, however bad the regression", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 98 })],
      [run(A, "mobile", { performance: 3 })],
      notify({ enabled: false }),
    );
    expect(alerts).toEqual([]);
  });

  it("returns [] for empty inputs", () => {
    expect(compareBatches([], [], notify())).toEqual([]);
    expect(compareBatches([], [run(A, "mobile", { seo: 10 })], notify())).toEqual([]);
  });
});

describe("compareBatches — the three kinds", () => {
  it("reports crossed_below with the bar that was crossed", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 94 })],
      [run(A, "mobile", { performance: 71 })],
      notify(),
    );
    expect(alerts.map(shape)).toEqual([
      {
        kind: "crossed_below",
        url: A,
        formFactor: "mobile",
        category: "performance",
        previous: 94,
        current: 71,
        delta: -23,
        threshold: 90,
      },
    ]);
  });

  it("treats a score landing exactly on the bar as still passing", () => {
    // 90 → 90 is not a crossing, and 91 → 90 is neither a crossing nor a drop.
    expect(
      compareBatches(
        [run(A, "mobile", { seo: 91 })],
        [run(A, "mobile", { seo: 90 })],
        notify(),
      ),
    ).toEqual([]);
    // 90 → 89 is: it was at the bar, now it is under it.
    const crossed = compareBatches(
      [run(A, "mobile", { seo: 90 })],
      [run(A, "mobile", { seo: 89 })],
      notify(),
    );
    expect(crossed).toHaveLength(1);
    expect(crossed[0].kind).toBe("crossed_below");
  });

  it("reports recovered_above with a positive delta", () => {
    const alerts = compareBatches(
      [run(A, "desktop", { accessibility: 82 })],
      [run(A, "desktop", { accessibility: 90 })],
      notify(),
    );
    expect(alerts.map(shape)).toEqual([
      {
        kind: "recovered_above",
        url: A,
        formFactor: "desktop",
        category: "accessibility",
        previous: 82,
        current: 90,
        delta: 8,
        threshold: 90,
      },
    ]);
  });

  it("reports dropped_by with a null threshold when no bar was crossed", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 98 })],
      [run(A, "mobile", { performance: 91 })],
      notify({ minDelta: 5 }),
    );
    expect(alerts.map(shape)).toEqual([
      {
        kind: "dropped_by",
        url: A,
        formFactor: "mobile",
        category: "performance",
        previous: 98,
        current: 91,
        delta: -7,
        threshold: null,
      },
    ]);
  });

  it("reports a crossing once, never also as a drop", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95 })],
      [run(A, "mobile", { performance: 20 })],
      notify({ minDelta: 5 }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("crossed_below");
    expect(alerts[0].threshold).toBe(90);
  });
});

describe("compareBatches — minDelta boundary", () => {
  it("fires at exactly minDelta and stays silent one point short", () => {
    const at = compareBatches(
      [run(A, "mobile", { performance: 50 })],
      [run(A, "mobile", { performance: 45 })],
      notify({ minDelta: 5 }),
    );
    expect(at).toHaveLength(1);
    expect(at[0].kind).toBe("dropped_by");
    expect(at[0].delta).toBe(-5);

    const under = compareBatches(
      [run(A, "mobile", { performance: 50 })],
      [run(A, "mobile", { performance: 46 })],
      notify({ minDelta: 5 }),
    );
    expect(under).toEqual([]);
  });

  it("does not alert on an unchanged score even if minDelta is garbage", () => {
    // A 0 / negative / non-numeric minDelta must never make `prev - cur >= d`
    // true for a steady site.
    for (const minDelta of [0, -10, Number.NaN, "5" as unknown as number]) {
      const alerts = compareBatches(
        [run(A, "mobile", { performance: 44 })],
        [run(A, "mobile", { performance: 44 })],
        notify({ minDelta }),
      );
      expect(alerts).toEqual([]);
    }
  });
});

describe("compareBatches — pairing", () => {
  it("ignores a URL present in only one fire", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95 })],
      [run(B, "mobile", { performance: 10 })],
      notify(),
    );
    expect(alerts).toEqual([]);
  });

  it("keeps mobile and desktop separate", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95 })],
      [run(A, "desktop", { performance: 10 })],
      notify(),
    );
    expect(alerts).toEqual([]);
  });

  it("compares each device independently when both are present", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { seo: 95 }), run(A, "desktop", { seo: 95 })],
      [run(A, "mobile", { seo: 60 }), run(A, "desktop", { seo: 95 })],
      notify(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].formFactor).toBe("mobile");
  });

  it("uses the first occurrence when a fire repeats a pair", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { seo: 95 }), run(A, "mobile", { seo: 10 })],
      [run(A, "mobile", { seo: 95 }), run(A, "mobile", { seo: 10 })],
      notify(),
    );
    expect(alerts).toEqual([]);
  });
});

describe("compareBatches — missing scores are silence, not zero", () => {
  it("ignores a category that is null on the newest side", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95 })],
      [run(A, "mobile", { performance: null })],
      notify(),
    );
    expect(alerts).toEqual([]);
  });

  it("ignores a category that is null on the previous side", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: null })],
      [run(A, "mobile", { performance: 12 })],
      notify(),
    );
    expect(alerts).toEqual([]);
  });

  it("ignores a category absent from one run entirely", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95, seo: 95 })],
      [run(A, "mobile", { performance: 30 })],
      notify(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].category).toBe("performance");
  });

  it("ignores a NaN score rather than reading it as a regression", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95 })],
      [run(A, "mobile", { performance: Number.NaN })],
      notify(),
    );
    expect(alerts).toEqual([]);
  });
});

describe("compareBatches — category selection", () => {
  it("only considers the categories the schedule watches", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95, seo: 95 })],
      [run(A, "mobile", { performance: 10, seo: 10 })],
      notify({ categories: ["seo"] }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].category).toBe("seo");
  });

  it("returns [] when no watched category is a real category", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95 })],
      [run(A, "mobile", { performance: 10 })],
      notify({ categories: [] }),
    );
    expect(alerts).toEqual([]);
  });

  it("is insensitive to the order categories were configured in", () => {
    const scoresBefore: CategoryScores = { performance: 95, seo: 95 };
    const scoresAfter: CategoryScores = { performance: 40, seo: 40 };
    const forwards = compareBatches(
      [run(A, "mobile", scoresBefore)],
      [run(A, "mobile", scoresAfter)],
      notify({ categories: ["performance", "seo"] }),
    );
    const backwards = compareBatches(
      [run(A, "mobile", scoresBefore)],
      [run(A, "mobile", scoresAfter)],
      notify({ categories: ["seo", "performance"] }),
    );
    expect(backwards).toEqual(forwards);
    expect(forwards.map((a) => a.category)).toEqual(["performance", "seo"]);
  });

  it("still reports drops when a category's bar is missing from the config", () => {
    const alerts = compareBatches(
      [run(A, "mobile", { performance: 95 })],
      [run(A, "mobile", { performance: 60 })],
      notify({
        categories: ["performance"],
        thresholds: {
          ...DEFAULT_THRESHOLDS,
          performance: undefined as unknown as number,
        },
      }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("dropped_by");
    expect(alerts[0].threshold).toBeNull();
  });
});

describe("compareBatches — ordering", () => {
  it("sorts by severity, then biggest drop, then url, formFactor, category", () => {
    const previous = [
      run(A, "mobile", {
        performance: 95,
        accessibility: 80,
        "best-practices": 70,
        seo: 95,
      }),
      run(B, "mobile", { seo: 95 }),
    ];
    const current = [
      run(A, "mobile", {
        performance: 85, // crossed_below, -10
        accessibility: 60, // dropped_by, -20 (both sides under the bar)
        "best-practices": 95, // recovered_above, +25
        seo: 85, // crossed_below, -10
      }),
      run(B, "mobile", { seo: 70 }), // crossed_below, -25
    ];

    const alerts = compareBatches(previous, current, notify({ minDelta: 5 }));
    expect(alerts.map((a) => [a.kind, a.url, a.category, a.delta])).toEqual([
      ["crossed_below", B, "seo", -25],
      ["crossed_below", A, "performance", -10],
      ["crossed_below", A, "seo", -10],
      ["dropped_by", A, "accessibility", -20],
      ["recovered_above", A, "best-practices", 25],
    ]);
  });

  it("breaks a full tie on url then form factor", () => {
    const previous = [
      run(B, "mobile", { seo: 95 }),
      run(A, "mobile", { seo: 95 }),
      run(A, "desktop", { seo: 95 }),
    ];
    const current = [
      run(B, "mobile", { seo: 80 }),
      run(A, "mobile", { seo: 80 }),
      run(A, "desktop", { seo: 80 }),
    ];
    const alerts = compareBatches(previous, current, notify());
    expect(alerts.map((a) => [a.url, a.formFactor])).toEqual([
      [A, "desktop"],
      [A, "mobile"],
      [B, "mobile"],
    ]);
  });

  it("is stable regardless of the order the runs arrive in", () => {
    const previous = [
      run(A, "mobile", { performance: 95, seo: 95 }),
      run(B, "mobile", { performance: 95 }),
    ];
    const current = [
      run(A, "mobile", { performance: 60, seo: 40 }),
      run(B, "mobile", { performance: 20 }),
    ];
    const forwards = compareBatches(previous, current, notify());
    const reversed = compareBatches(
      [...previous].reverse(),
      [...current].reverse(),
      notify(),
    );
    expect(reversed).toEqual(forwards);
  });
});
