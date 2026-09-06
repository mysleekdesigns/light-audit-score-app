import { describe, expect, it } from "vitest";

import { alertKindLabel, alertSummary, formatDelta } from "@/lib/alerts/format";
import type { AlertKind, ScheduleAlert } from "@/lib/alerts/types";

function alert(patch: Partial<ScheduleAlert> = {}): ScheduleAlert {
  return {
    kind: "crossed_below",
    url: "https://a.example",
    formFactor: "mobile",
    category: "performance",
    previous: 94,
    current: 71,
    delta: -23,
    threshold: 90,
    ...patch,
  };
}

describe("alertKindLabel", () => {
  it("names every kind", () => {
    expect(alertKindLabel("crossed_below")).toBe("Crossed below");
    expect(alertKindLabel("recovered_above")).toBe("Recovered");
    expect(alertKindLabel("dropped_by")).toBe("Dropped");
  });

  it("is total over AlertKind", () => {
    const kinds: AlertKind[] = ["crossed_below", "recovered_above", "dropped_by"];
    for (const kind of kinds) {
      expect(alertKindLabel(kind)).toMatch(/\S/);
    }
  });
});

describe("formatDelta", () => {
  it("signs a rise and keeps a fall's own minus", () => {
    expect(formatDelta(-23)).toBe("-23");
    expect(formatDelta(8)).toBe("+8");
  });

  it("rounds and handles zero without inventing a sign", () => {
    expect(formatDelta(0)).toBe("0");
    expect(formatDelta(-2.4)).toBe("-2");
    expect(formatDelta(2.6)).toBe("+3");
  });

  it("degrades a non-finite delta to 0 rather than printing NaN", () => {
    expect(formatDelta(Number.NaN)).toBe("0");
    expect(formatDelta(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatDelta(undefined as unknown as number)).toBe("0");
  });

  it("uses plain ASCII signs so the string survives any transport", () => {
    expect(formatDelta(-5)).not.toMatch(/[^\x20-\x7e]/);
    expect(formatDelta(5)).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe("alertSummary", () => {
  it("reads category, both scores and the signed delta", () => {
    expect(alertSummary(alert())).toBe("Performance 94 → 71 (-23)");
  });

  it("uses the human category label", () => {
    expect(alertSummary(alert({ category: "best-practices", previous: 92, current: 80, delta: -12 }))).toBe(
      "Best Practices 92 → 80 (-12)",
    );
    expect(alertSummary(alert({ category: "seo", previous: 70, current: 90, delta: 20 }))).toBe(
      "SEO 70 → 90 (+20)",
    );
    expect(
      alertSummary(alert({ category: "agentic-browsing", previous: 67, current: 50, delta: -17 })),
    ).toBe("Agentic Browsing 67 → 50 (-17)");
  });

  it("carries neither the URL nor the form factor — the caller owns those axes", () => {
    const summary = alertSummary(alert({ url: "https://a.example", formFactor: "desktop" }));
    expect(summary).not.toContain("a.example");
    expect(summary).not.toContain("desktop");
  });

  it("falls back to the raw category key if a label is ever missing", () => {
    const summary = alertSummary(
      alert({ category: "future-category" as ScheduleAlert["category"] }),
    );
    expect(summary).toBe("future-category 94 → 71 (-23)");
  });
});
