import { describe, expect, it } from "vitest";

import {
  AVERAGE_THRESHOLD,
  CATEGORY_LABELS,
  formatScore,
  GOOD_THRESHOLD,
  METRIC_DISPLAY_ORDER,
  METRIC_META,
  scoreBand,
  scoreColorClass,
  scoreTextClass,
} from "@/lib/scores";
import { LIGHTHOUSE_CATEGORIES, METRIC_IDS } from "@/lib/lighthouse/types";

describe("scoreBand", () => {
  it("maps the good band (90–100)", () => {
    expect(scoreBand(90)).toBe("good");
    expect(scoreBand(100)).toBe("good");
    expect(scoreBand(GOOD_THRESHOLD)).toBe("good");
  });

  it("maps the average band (50–89)", () => {
    expect(scoreBand(50)).toBe("average");
    expect(scoreBand(89)).toBe("average");
    expect(scoreBand(AVERAGE_THRESHOLD)).toBe("average");
    expect(scoreBand(GOOD_THRESHOLD - 1)).toBe("average");
  });

  it("maps the poor band (0–49)", () => {
    expect(scoreBand(0)).toBe("poor");
    expect(scoreBand(49)).toBe("poor");
    expect(scoreBand(AVERAGE_THRESHOLD - 1)).toBe("poor");
  });

  it("treats null/undefined/NaN as none", () => {
    expect(scoreBand(null)).toBe("none");
    expect(scoreBand(undefined)).toBe("none");
    expect(scoreBand(NaN)).toBe("none");
  });
});

describe("scoreTextClass / scoreColorClass", () => {
  it("returns score token classes per band", () => {
    expect(scoreTextClass("good")).toBe("text-score-good");
    expect(scoreTextClass("average")).toBe("text-score-average");
    expect(scoreTextClass("poor")).toBe("text-score-poor");
    expect(scoreTextClass("none")).toBe("text-muted-foreground");
  });

  it("derives the class from a numeric score", () => {
    expect(scoreColorClass(95)).toBe("text-score-good");
    expect(scoreColorClass(70)).toBe("text-score-average");
    expect(scoreColorClass(20)).toBe("text-score-poor");
    expect(scoreColorClass(null)).toBe("text-muted-foreground");
  });
});

describe("formatScore", () => {
  it("rounds to an integer", () => {
    expect(formatScore(99.6)).toBe("100");
    expect(formatScore(49.4)).toBe("49");
    expect(formatScore(0)).toBe("0");
  });

  it("renders an em dash when unscored", () => {
    expect(formatScore(null)).toBe("—");
    expect(formatScore(undefined)).toBe("—");
    expect(formatScore(NaN)).toBe("—");
  });
});

describe("label maps cover the full contract", () => {
  it("has a label for every Lighthouse category", () => {
    for (const cat of LIGHTHOUSE_CATEGORIES) {
      expect(CATEGORY_LABELS[cat]).toBeTruthy();
    }
  });

  it("has metric metadata for every metric id, in PRD display order", () => {
    for (const id of METRIC_IDS) {
      expect(METRIC_META[id]?.abbr).toBeTruthy();
    }
    expect([...METRIC_DISPLAY_ORDER].sort()).toEqual([...METRIC_IDS].sort());
  });
});
