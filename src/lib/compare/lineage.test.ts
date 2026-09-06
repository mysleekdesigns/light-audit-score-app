import { describe, expect, it } from "vitest";

import { groupRunsByUrl } from "./diff";
import {
  compareHref,
  isDiffable,
  pickRerunComparison,
  resolveCompareSelection,
  resolveRerunComparisons,
} from "./lineage";
import type { HistoryRow } from "@/lib/db/persistence";

/** Build a HistoryRow with sensible defaults, overridable per-test. */
function makeRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: "run-1",
    batchId: "batch-1",
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: "done",
    errorMessage: null,
    formFactor: "mobile",
    source: "local",
    field: null,
    runs: 3,
    options: {
      formFactor: "mobile",
      throttling: "simulated",
      categories: ["performance", "accessibility", "best-practices", "seo"],
      runs: 3,
      warmCache: true,
    },
    scores: {
      performance: 80,
      accessibility: 90,
      "best-practices": 75,
      seo: 100,
    },
    metrics: null,
    environment: null,
    hasJsonReport: true,
    hasHtmlReport: true,
    fetchTime: "2026-05-01T10:00:00.000Z",
    createdAt: "2026-05-01T10:00:05.000Z",
    ...overrides,
  };
}

describe("isDiffable", () => {
  it("accepts a completed run with a stored JSON report", () => {
    expect(isDiffable(makeRow())).toBe(true);
  });

  it("rejects a failed run", () => {
    expect(isDiffable(makeRow({ status: "error" }))).toBe(false);
  });

  it("rejects a completed run whose JSON report was never stored", () => {
    // The differ reads two stored LHRs; without one there is nothing to diff.
    expect(isDiffable(makeRow({ hasJsonReport: false }))).toBe(false);
  });
});

describe("resolveRerunComparisons", () => {
  it("pairs the same url + form factor across the two batches", () => {
    const prior = [makeRow({ id: "old", batchId: "b0" })];
    const current = [makeRow({ id: "new", batchId: "b1" })];

    expect(resolveRerunComparisons(current, prior)).toEqual([
      {
        url: "https://example.com/",
        formFactor: "mobile",
        baselineRunId: "old",
        comparisonRunId: "new",
        // 4 scored categories, all unchanged.
        pointsLost: 0,
      },
    ]);
  });

  it("never crosses form factors", () => {
    const prior = [makeRow({ id: "old-desktop", formFactor: "desktop" })];
    const current = [makeRow({ id: "new-mobile", formFactor: "mobile" })];
    expect(resolveRerunComparisons(current, prior)).toEqual([]);
  });

  it("emits one pair per device for a both-device re-run", () => {
    const prior = [
      makeRow({ id: "old-m", formFactor: "mobile" }),
      makeRow({ id: "old-d", formFactor: "desktop" }),
    ];
    const current = [
      makeRow({ id: "new-m", formFactor: "mobile" }),
      makeRow({ id: "new-d", formFactor: "desktop" }),
    ];

    const pairs = resolveRerunComparisons(current, prior);
    expect(pairs).toHaveLength(2);
    // Same points lost on both, so the deterministic tie-break applies: mobile first.
    expect(pairs.map((p) => p.formFactor)).toEqual(["mobile", "desktop"]);
    expect(pairs.map((p) => p.comparisonRunId)).toEqual(["new-m", "new-d"]);
  });

  it("ranks the page that lost the most score points first", () => {
    const prior = [
      makeRow({ id: "old-a", url: "https://a.com/", scores: { performance: 90 } }),
      makeRow({ id: "old-b", url: "https://b.com/", scores: { performance: 90 } }),
    ];
    const current = [
      makeRow({ id: "new-a", url: "https://a.com/", scores: { performance: 88 } }),
      makeRow({ id: "new-b", url: "https://b.com/", scores: { performance: 60 } }),
    ];

    const pairs = resolveRerunComparisons(current, prior);
    expect(pairs.map((p) => p.url)).toEqual(["https://b.com/", "https://a.com/"]);
    expect(pairs[0].pointsLost).toBe(30);
    expect(pairs[1].pointsLost).toBe(2);
  });

  it("sorts unrankable pairs (no shared scored category) last", () => {
    const prior = [
      makeRow({ id: "old-a", url: "https://a.com/", scores: {} }),
      makeRow({ id: "old-b", url: "https://b.com/", scores: { performance: 90 } }),
    ];
    const current = [
      makeRow({ id: "new-a", url: "https://a.com/", scores: {} }),
      // An improvement — still ranked above the pair with no evidence at all.
      makeRow({ id: "new-b", url: "https://b.com/", scores: { performance: 95 } }),
    ];

    const pairs = resolveRerunComparisons(current, prior);
    expect(pairs.map((p) => p.url)).toEqual(["https://b.com/", "https://a.com/"]);
    expect(pairs[0].pointsLost).toBe(-5);
    expect(pairs[1].pointsLost).toBeNull();
  });

  it("skips pages the prior batch never audited", () => {
    const prior = [makeRow({ id: "old", url: "https://a.com/" })];
    const current = [
      makeRow({ id: "new-a", url: "https://a.com/" }),
      makeRow({ id: "new-c", url: "https://c.com/" }),
    ];
    expect(resolveRerunComparisons(current, prior).map((p) => p.url)).toEqual([
      "https://a.com/",
    ]);
  });

  it("skips a pair whose baseline failed or has no stored report", () => {
    const prior = [
      makeRow({ id: "old-a", url: "https://a.com/", status: "error" }),
      makeRow({ id: "old-b", url: "https://b.com/", hasJsonReport: false }),
    ];
    const current = [
      makeRow({ id: "new-a", url: "https://a.com/" }),
      makeRow({ id: "new-b", url: "https://b.com/" }),
    ];
    expect(resolveRerunComparisons(current, prior)).toEqual([]);
  });

  it("returns nothing when either batch is empty", () => {
    expect(resolveRerunComparisons([], [makeRow()])).toEqual([]);
    expect(resolveRerunComparisons([makeRow()], [])).toEqual([]);
  });

  it("keeps the first run when a batch audited one url twice on one device", () => {
    const prior = [makeRow({ id: "old-1" }), makeRow({ id: "old-2" })];
    const current = [makeRow({ id: "new-1" }), makeRow({ id: "new-2" })];
    const pairs = resolveRerunComparisons(current, prior);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ baselineRunId: "old-1", comparisonRunId: "new-1" });
  });
});

describe("pickRerunComparison", () => {
  it("returns the worst-regressed pair", () => {
    const prior = [
      makeRow({ id: "old-a", url: "https://a.com/", scores: { performance: 90 } }),
      makeRow({ id: "old-b", url: "https://b.com/", scores: { performance: 90 } }),
    ];
    const current = [
      makeRow({ id: "new-a", url: "https://a.com/", scores: { performance: 89 } }),
      makeRow({ id: "new-b", url: "https://b.com/", scores: { performance: 40 } }),
    ];
    expect(pickRerunComparison(current, prior)?.comparisonRunId).toBe("new-b");
  });

  it("returns null when nothing pairs up — the caller renders no link", () => {
    expect(pickRerunComparison([makeRow({ url: "https://a.com/" })], [])).toBeNull();
  });
});

describe("compareHref", () => {
  it("encodes the url and both run ids, and asks for the card to open", () => {
    const href = compareHref({
      url: "https://example.com/a b?x=1&y=2",
      baselineRunId: "old",
      comparisonRunId: "new",
    });
    const url = new URL(href, "http://127.0.0.1");
    expect(url.pathname).toBe("/compare");
    expect(url.searchParams.get("url")).toBe("https://example.com/a b?x=1&y=2");
    expect(url.searchParams.get("baseline")).toBe("old");
    expect(url.searchParams.get("comparison")).toBe("new");
    expect(url.searchParams.get("changed")).toBe("1");
  });
});

describe("resolveCompareSelection", () => {
  /** Two urls: `a` with three runs, `b` with one. */
  function groups() {
    return groupRunsByUrl([
      makeRow({ id: "a1", url: "https://a.com/", fetchTime: "2026-05-01T00:00:00.000Z" }),
      makeRow({ id: "a2", url: "https://a.com/", fetchTime: "2026-05-02T00:00:00.000Z" }),
      makeRow({ id: "a3", url: "https://a.com/", fetchTime: "2026-05-03T00:00:00.000Z" }),
      makeRow({ id: "b1", url: "https://b.com/", fetchTime: "2026-05-01T00:00:00.000Z" }),
    ]);
  }

  it("returns null when there is nothing to select", () => {
    expect(resolveCompareSelection([], { url: "https://a.com/" })).toBeNull();
  });

  it("defaults to the most-audited url, oldest → newest, card shut", () => {
    expect(resolveCompareSelection(groups())).toEqual({
      url: "https://a.com/",
      baselineRunId: "a1",
      comparisonRunId: "a3",
      showChanged: false,
    });
  });

  it("honours a full deep link and opens the card", () => {
    expect(
      resolveCompareSelection(groups(), {
        url: "https://a.com/",
        baseline: "a1",
        comparison: "a2",
        changed: "1",
      }),
    ).toEqual({
      url: "https://a.com/",
      baselineRunId: "a1",
      comparisonRunId: "a2",
      showChanged: true,
    });
  });

  it("falls back to the default group when the url is unknown", () => {
    const selection = resolveCompareSelection(groups(), { url: "https://gone.com/" });
    expect(selection?.url).toBe("https://a.com/");
  });

  it("falls back to the group's oldest/newest when a run id is stale", () => {
    const selection = resolveCompareSelection(groups(), {
      url: "https://a.com/",
      baseline: "deleted",
      comparison: "a2",
      changed: "1",
    });
    expect(selection).toEqual({
      url: "https://a.com/",
      baselineRunId: "a1",
      comparisonRunId: "a2",
      // The link asked to open, but half of the pair it named is gone — so the
      // card stays shut rather than opening on a pair the user never chose.
      showChanged: false,
    });
  });

  it("does not open the card when both ids resolve to the same run", () => {
    const selection = resolveCompareSelection(groups(), {
      url: "https://a.com/",
      baseline: "a2",
      comparison: "a2",
      changed: "1",
    });
    expect(selection?.showChanged).toBe(false);
  });

  it("does not open the card without the changed flag", () => {
    const selection = resolveCompareSelection(groups(), {
      url: "https://a.com/",
      baseline: "a1",
      comparison: "a2",
    });
    expect(selection?.showChanged).toBe(false);
  });

  it("accepts the affirmative spellings and rejects anything else", () => {
    const base = { url: "https://a.com/", baseline: "a1", comparison: "a2" };
    for (const changed of ["1", "true", "TRUE", "yes"]) {
      expect(resolveCompareSelection(groups(), { ...base, changed })?.showChanged).toBe(true);
    }
    for (const changed of ["0", "false", "", "maybe"]) {
      expect(resolveCompareSelection(groups(), { ...base, changed })?.showChanged).toBe(false);
    }
  });

  it("takes the first value of a repeated query parameter", () => {
    const selection = resolveCompareSelection(groups(), {
      url: ["https://b.com/", "https://a.com/"],
      changed: ["1"],
    });
    expect(selection?.url).toBe("https://b.com/");
    // `b` has a single run, so baseline and comparison collapse onto it.
    expect(selection).toMatchObject({ baselineRunId: "b1", comparisonRunId: "b1" });
  });
});
