import { describe, expect, it } from "vitest";

import type {
  AuditDelta,
  OpportunityDelta,
  ResourceDelta,
  ResourceDiff,
  RunDiff,
} from "@/lib/reports/diff-types";

import {
  analysisCategories,
  auditNumericNote,
  auditPresenceNote,
  auditRowValues,
  auditsEmptyReason,
  AUDIT_FILTERS,
  AUDIT_FILTER_LABELS,
  capLabel,
  countByStatus,
  deltaTone,
  DELTA_MARKS,
  diffFinalHost,
  filterAuditDeltas,
  formatAuditScore,
  formatNumericDelta,
  formatNumericValue,
  formatScorePoints,
  formatSignedBytes,
  formatSignedInt,
  formatSignedMs,
  growthTone,
  isIdenticalDiff,
  isInformationalAudit,
  opportunitiesEmptyReason,
  opportunityRowValues,
  resourceChangeValue,
  resourceCountNote,
  resourceLabel,
  resourceRows,
  resourcesEmptyReason,
  summarizeRunDiff,
  worstRegressedCategory,
} from "./what-changed-view";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function makeAudit(overrides: Partial<AuditDelta> = {}): AuditDelta {
  return {
    id: "unused-javascript",
    title: "Reduce unused JavaScript",
    description: "Remove unused JavaScript.",
    categories: ["performance"],
    weight: 5,
    baselineScore: 0.9,
    comparisonScore: 0.4,
    scoreDelta: -0.5,
    baselineNumericValue: null,
    comparisonNumericValue: null,
    numericDelta: null,
    numericUnit: "",
    baselineDisplayValue: "",
    comparisonDisplayValue: "",
    scoreDisplayMode: "numeric",
    status: "regressed",
    basis: "score",
    ...overrides,
  };
}

function makeOpportunity(overrides: Partial<OpportunityDelta> = {}): OpportunityDelta {
  return {
    id: "render-blocking-resources",
    title: "Eliminate render-blocking resources",
    description: "Resources are blocking the first paint.",
    baselineSavingsMs: 200,
    comparisonSavingsMs: 900,
    savingsDeltaMs: 700,
    baselineDisplayValue: "",
    comparisonDisplayValue: "",
    baselineScore: 0.9,
    comparisonScore: 0.3,
    status: "regressed",
    ...overrides,
  };
}

function makeResource(overrides: Partial<ResourceDelta> = {}): ResourceDelta {
  return {
    url: "https://example.com/app.js",
    path: "/app.js",
    host: "example.com",
    resourceType: "Script",
    thirdParty: false,
    baselineCount: 1,
    comparisonCount: 1,
    baselineTransferSize: 1000,
    comparisonTransferSize: 2000,
    transferDelta: 1000,
    status: "regressed",
    ...overrides,
  };
}

function makeResources(overrides: Partial<ResourceDiff> = {}): ResourceDiff {
  return {
    added: [],
    removed: [],
    changed: [],
    unchangedCount: 0,
    baselineRequestCount: 0,
    comparisonRequestCount: 0,
    requestCountDelta: 0,
    baselineTransferSize: 0,
    comparisonTransferSize: 0,
    transferSizeDelta: 0,
    baselineThirdPartyCount: 0,
    comparisonThirdPartyCount: 0,
    unavailable: false,
    ...overrides,
  };
}

function makeDiff(overrides: Partial<RunDiff> = {}): RunDiff {
  const resources = overrides.resources ?? makeResources();
  return {
    baseline: {
      runId: "old",
      finalUrl: "https://example.com/",
      fetchTime: "2026-05-01T00:00:00.000Z",
      lighthouseVersion: "13.0.0",
      scores: { performance: 90, accessibility: 95 },
    },
    comparison: {
      runId: "new",
      finalUrl: "https://example.com/",
      fetchTime: "2026-05-02T00:00:00.000Z",
      lighthouseVersion: "13.0.0",
      scores: { performance: 70, accessibility: 95 },
    },
    audits: [],
    opportunities: [],
    unchangedAuditCount: 0,
    urlMismatch: false,
    ...overrides,
    resources,
    totals: {
      audits: overrides.audits?.length ?? 0,
      opportunities: overrides.opportunities?.length ?? 0,
      resourcesAdded: resources.added.length,
      resourcesRemoved: resources.removed.length,
      resourcesChanged: resources.changed.length,
      ...overrides.totals,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Marks and tone                                                              */
/* -------------------------------------------------------------------------- */

describe("DELTA_MARKS", () => {
  it("gives every status a text abbreviation, so colour is never the only signal", () => {
    for (const status of ["regressed", "improved", "unchanged", "added", "removed"] as const) {
      expect(DELTA_MARKS[status].abbr).toMatch(/^[A-Z]+$/);
      expect(DELTA_MARKS[status].label.length).toBeGreaterThan(0);
    }
  });
});

describe("deltaTone", () => {
  it("tints only the two statuses the differ actually judged", () => {
    expect(deltaTone("regressed")).toBe("worse");
    expect(deltaTone("improved")).toBe("better");
  });

  it("leaves added / removed / unchanged neutral", () => {
    // The contract refuses to sign presence changes; the UI must not either.
    expect(deltaTone("added")).toBe("neutral");
    expect(deltaTone("removed")).toBe("neutral");
    expect(deltaTone("unchanged")).toBe("neutral");
  });
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

describe("formatSignedInt", () => {
  it("signs, rounds and marks a real zero", () => {
    expect(formatSignedInt(8)).toBe("+8");
    expect(formatSignedInt(-8.4)).toBe("-8");
    expect(formatSignedInt(0)).toBe("±0");
  });

  it("prints an em dash for a missing or non-finite value", () => {
    expect(formatSignedInt(null)).toBe("—");
    expect(formatSignedInt(undefined)).toBe("—");
    expect(formatSignedInt(Number.NaN)).toBe("—");
    expect(formatSignedInt(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatSignedBytes", () => {
  it("signs a transfer change in the same units the size column uses", () => {
    expect(formatSignedBytes(348160)).toBe("+340.0 KB");
    expect(formatSignedBytes(-2048)).toBe("-2.0 KB");
    expect(formatSignedBytes(0)).toBe("±0");
    expect(formatSignedBytes(null)).toBe("—");
  });
});

describe("formatSignedMs", () => {
  it("signs a duration change and switches units above a second", () => {
    expect(formatSignedMs(340)).toBe("+340 ms");
    expect(formatSignedMs(-1240)).toBe("-1.24 s");
    expect(formatSignedMs(0)).toBe("±0");
    expect(formatSignedMs(null)).toBe("—");
  });
});

describe("formatAuditScore / formatScorePoints", () => {
  it("puts a 0–1 audit score on the app's 0–100 scale", () => {
    expect(formatAuditScore(0.9)).toBe("90");
    expect(formatAuditScore(0)).toBe("0");
  });

  it("treats a missing score as silence, not zero", () => {
    expect(formatAuditScore(null)).toBe("—");
  });

  it("converts a 0–1 score delta into signed score points", () => {
    expect(formatScorePoints(-0.5)).toBe("-50");
    expect(formatScorePoints(0.08)).toBe("+8");
    expect(formatScorePoints(0)).toBe("±0");
    expect(formatScorePoints(null)).toBe("—");
  });
});

describe("formatNumericValue / formatNumericDelta", () => {
  it("renders each of Lighthouse's units in its own terms", () => {
    expect(formatNumericValue(2048, "byte")).toBe("2.0 KB");
    expect(formatNumericValue(1500, "millisecond")).toBe("1.50 s");
    expect(formatNumericValue(1.5, "second")).toBe("1.50 s");
    expect(formatNumericValue(12, "element")).toBe("12");
    expect(formatNumericValue(null, "byte")).toBe("—");
  });

  it("signs a delta in the same unit", () => {
    expect(formatNumericDelta(348160, "byte")).toBe("+340.0 KB");
    expect(formatNumericDelta(-500, "millisecond")).toBe("-500 ms");
    expect(formatNumericDelta(3, "element")).toBe("+3");
    expect(formatNumericDelta(0, "byte")).toBe("±0");
    expect(formatNumericDelta(null, "byte")).toBe("—");
  });

  it("never emits a signed zero for sub-unit dust", () => {
    expect(formatNumericDelta(0.0001, "element")).toBe("±0");
  });
});

describe("growthTone", () => {
  it("treats growth as the bad direction and shrinkage as the good one", () => {
    expect(growthTone(1)).toBe("warn");
    expect(growthTone(-1)).toBe("good");
  });

  it("stays neutral for no movement or a non-finite value", () => {
    expect(growthTone(0)).toBe("default");
    expect(growthTone(Number.NaN)).toBe("default");
  });
});

describe("capLabel", () => {
  it("says how much of the total is on screen, and only when the cap bit", () => {
    expect(capLabel(40, 112)).toBe("40 of 112");
    expect(capLabel(12, 12)).toBe("12");
    expect(capLabel(0, 0)).toBe("0");
  });
});

/* -------------------------------------------------------------------------- */
/* Audit rows                                                                  */
/* -------------------------------------------------------------------------- */

describe("auditRowValues", () => {
  it("shows scores whenever either side has one", () => {
    expect(auditRowValues(makeAudit())).toEqual({
      baseline: "90",
      comparison: "40",
      change: "-50",
      basis: "score",
    });
  });

  it("keeps a one-sided audit one-sided rather than diffing against an implied 0", () => {
    const added = makeAudit({
      baselineScore: null,
      comparisonScore: 0.5,
      scoreDelta: null,
      status: "added",
    });
    expect(auditRowValues(added)).toMatchObject({
      baseline: "—",
      comparison: "50",
      change: "—",
    });
  });

  it("falls back to Lighthouse's rendered value for a scoreless audit", () => {
    const informative = makeAudit({
      id: "total-byte-weight",
      baselineScore: null,
      comparisonScore: null,
      scoreDelta: null,
      baselineNumericValue: 1_000_000,
      comparisonNumericValue: 1_400_000,
      numericDelta: 400_000,
      numericUnit: "byte",
      baselineDisplayValue: "Total size was 977 KiB",
      comparisonDisplayValue: "Total size was 1,367 KiB",
      basis: "numeric",
      status: "regressed",
    });
    expect(auditRowValues(informative)).toEqual({
      baseline: "Total size was 977 KiB",
      comparison: "Total size was 1,367 KiB",
      change: "+390.6 KB",
      basis: "numeric",
    });
  });

  it("formats the raw numeric value when Lighthouse rendered none", () => {
    const scoreless = makeAudit({
      baselineScore: null,
      comparisonScore: null,
      scoreDelta: null,
      baselineNumericValue: 2048,
      comparisonNumericValue: null,
      numericDelta: null,
      numericUnit: "byte",
      basis: "numeric",
      status: "removed",
    });
    expect(auditRowValues(scoreless)).toMatchObject({
      baseline: "2.0 KB",
      comparison: "—",
      change: "—",
    });
  });
});

describe("auditNumericNote", () => {
  it("adds the measurement behind a scored regression", () => {
    const audit = makeAudit({ numericDelta: 348160, numericUnit: "byte" });
    expect(auditNumericNote(audit)).toBe("+340.0 KB");
  });

  it("says nothing when the measurement did not move", () => {
    expect(auditNumericNote(makeAudit({ numericDelta: 0, numericUnit: "byte" }))).toBeNull();
    expect(auditNumericNote(makeAudit({ numericDelta: null }))).toBeNull();
  });

  it("says nothing for a scoreless audit, whose columns already show it", () => {
    const scoreless = makeAudit({
      baselineScore: null,
      comparisonScore: null,
      numericDelta: 500,
      numericUnit: "millisecond",
    });
    expect(auditNumericNote(scoreless)).toBeNull();
  });
});

describe("auditPresenceNote", () => {
  it("says which side a presence-only audit was on, and nothing more", () => {
    expect(auditPresenceNote({ basis: "presence", status: "added" })).toBe(
      "present only in the comparison run",
    );
    expect(auditPresenceNote({ basis: "presence", status: "removed" })).toBe(
      "present only in the baseline run",
    );
  });

  it("says nothing for an audit that actually moved", () => {
    expect(auditPresenceNote({ basis: "score", status: "regressed" })).toBeNull();
    expect(auditPresenceNote({ basis: "numeric", status: "improved" })).toBeNull();
    // Defensive: a presence basis with a movement status is not a presence row.
    expect(auditPresenceNote({ basis: "presence", status: "unchanged" })).toBeNull();
  });
});

describe("isInformationalAudit", () => {
  it("marks a zero-weight audit as unable to move a score", () => {
    expect(isInformationalAudit({ weight: 0 })).toBe(true);
    expect(isInformationalAudit({ weight: 5 })).toBe(false);
  });
});

describe("filterAuditDeltas", () => {
  const audits = [
    makeAudit({ id: "a", status: "regressed" }),
    makeAudit({ id: "b", status: "improved" }),
    makeAudit({ id: "c", status: "added" }),
    makeAudit({ id: "d", status: "removed" }),
    makeAudit({ id: "e", status: "regressed" }),
  ];

  it("passes everything through on `all`, preserving the differ's ranking", () => {
    expect(filterAuditDeltas(audits, "all").map((a) => a.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("narrows to one status without reordering", () => {
    expect(filterAuditDeltas(audits, "regressed").map((a) => a.id)).toEqual(["a", "e"]);
    expect(filterAuditDeltas(audits, "added").map((a) => a.id)).toEqual(["c"]);
    expect(filterAuditDeltas(audits, "removed").map((a) => a.id)).toEqual(["d"]);
  });

  it("does not mutate its input", () => {
    const copy = [...audits];
    filterAuditDeltas(audits, "improved");
    expect(audits).toEqual(copy);
  });

  it("offers every filter the chips render, regressions before presence", () => {
    expect(AUDIT_FILTERS).toEqual(["all", "regressed", "improved", "added", "removed"]);
  });

  it("words the presence filters as presence, not as news", () => {
    // An added/removed audit is routine run-to-run variation, not a finding.
    expect(AUDIT_FILTER_LABELS.added).toBe("Appeared");
    expect(AUDIT_FILTER_LABELS.removed).toBe("Disappeared");
  });
});

describe("countByStatus", () => {
  it("zero-fills every status so a tally never has holes", () => {
    expect(countByStatus([makeAudit({ status: "regressed" })])).toEqual({
      regressed: 1,
      improved: 0,
      unchanged: 0,
      added: 0,
      removed: 0,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Opportunity rows                                                            */
/* -------------------------------------------------------------------------- */

describe("opportunityRowValues", () => {
  it("prefers Lighthouse's rendered savings", () => {
    const opportunity = makeOpportunity({
      baselineDisplayValue: "Potential savings of 0.2 s",
      comparisonDisplayValue: "Potential savings of 0.9 s",
    });
    expect(opportunityRowValues(opportunity)).toEqual({
      baseline: "Potential savings of 0.2 s",
      comparison: "Potential savings of 0.9 s",
      change: "+700 ms",
    });
  });

  it("formats the raw savings when there is no rendered value", () => {
    expect(opportunityRowValues(makeOpportunity())).toEqual({
      baseline: "200 ms",
      comparison: "900 ms",
      change: "+700 ms",
    });
  });

  it("leaves an unquantified side blank rather than calling it zero", () => {
    const opportunity = makeOpportunity({
      baselineSavingsMs: null,
      savingsDeltaMs: null,
    });
    expect(opportunityRowValues(opportunity)).toMatchObject({
      baseline: "—",
      change: "—",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Resource rows                                                               */
/* -------------------------------------------------------------------------- */

describe("resourceRows", () => {
  it("leads with the churn-immune group: what grew, then arrived, then went away", () => {
    // `added`/`removed` are dominated by analytics beacons whose query strings
    // change every run, so a `changed` row — the identical URL, a different
    // size — is the only third of this table that survives that churn.
    const rows = resourceRows(
      makeResources({
        added: [makeResource({ url: "a", status: "added" })],
        changed: [makeResource({ url: "c", status: "regressed" })],
        removed: [makeResource({ url: "r", status: "removed" })],
      }),
    );
    expect(rows.map((r) => r.url)).toEqual(["c", "a", "r"]);
  });
});

describe("resourceChangeValue", () => {
  it("subtracts normally for a URL both runs requested", () => {
    expect(resourceChangeValue(makeResource({ transferDelta: 1024 }))).toBe("+1.0 KB");
  });

  it("falls back to the one recorded side, signed, when the differ could not subtract", () => {
    // `transferDelta` is ALWAYS null on these; an em dash on the majority of
    // rows would be useless, and the one-sided figure is the same basis
    // `transferSizeDelta` is summed on.
    expect(
      resourceChangeValue(
        makeResource({
          status: "added",
          baselineTransferSize: null,
          comparisonTransferSize: 2048,
          transferDelta: null,
        }),
      ),
    ).toBe("+2.0 KB");
    expect(
      resourceChangeValue(
        makeResource({
          status: "removed",
          baselineTransferSize: 1923,
          comparisonTransferSize: null,
          transferDelta: null,
        }),
      ),
    ).toBe("-1.9 KB");
  });

  it("keeps a zero-byte arrival distinct from an unrecorded one", () => {
    // 0 is a real measurement (a cache hit that cost nothing); null is not.
    expect(
      resourceChangeValue(
        makeResource({ status: "added", comparisonTransferSize: 0, transferDelta: null }),
      ),
    ).toBe("±0");
    expect(
      resourceChangeValue(
        makeResource({ status: "added", comparisonTransferSize: null, transferDelta: null }),
      ),
    ).toBe("—");
    expect(
      resourceChangeValue(
        makeResource({ status: "removed", baselineTransferSize: null, transferDelta: null }),
      ),
    ).toBe("—");
  });
});

describe("diffFinalHost", () => {
  it("labels rows against the comparison run's host", () => {
    expect(
      diffFinalHost({
        baseline: { finalUrl: "https://old.example.com/" },
        comparison: { finalUrl: "https://new.example.com/" },
      } as RunDiff),
    ).toBe("new.example.com");
  });

  it("falls back to the baseline's when the comparison recorded none", () => {
    expect(
      diffFinalHost({
        baseline: { finalUrl: "https://old.example.com/" },
        comparison: { finalUrl: "" },
      } as RunDiff),
    ).toBe("old.example.com");
  });
});

describe("resourceLabel", () => {
  it("drops the page's own host and keeps a third party's", () => {
    expect(resourceLabel(makeResource(), "example.com")).toEqual({
      text: "/app.js",
      crossHost: false,
    });
    expect(
      resourceLabel(
        makeResource({ host: "cdn.other.com", path: "/t.js" }),
        "example.com",
      ),
    ).toEqual({ text: "cdn.other.com/t.js", crossHost: true });
  });

  it("clamps a hostile data: URL so a megabyte never reaches the DOM", () => {
    const blob = `data:text/javascript;base64,${"A".repeat(100_000)}`;
    const label = resourceLabel(
      makeResource({ url: blob, path: blob, host: "" }),
      "example.com",
    );
    expect(label.text.length).toBeLessThanOrEqual(240);
    expect(label.text.endsWith("…")).toBe(true);
  });
});

describe("resourceCountNote", () => {
  it("surfaces an occurrence change the size columns would hide", () => {
    expect(
      resourceCountNote(makeResource({ baselineCount: 1, comparisonCount: 2 })),
    ).toBe("1 → 2");
  });

  it("says nothing when the page fetched it the same number of times", () => {
    expect(resourceCountNote(makeResource())).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

describe("summarizeRunDiff", () => {
  it("reports the pre-cap totals rather than re-deriving them from the lists", () => {
    const diff = makeDiff({
      audits: [makeAudit()],
      opportunities: [makeOpportunity()],
      unchangedAuditCount: 170,
      resources: makeResources({
        added: [makeResource({ status: "added" })],
        requestCountDelta: 3,
        transferSizeDelta: 348160,
        baselineThirdPartyCount: 2,
        comparisonThirdPartyCount: 5,
      }),
      totals: {
        audits: 112,
        opportunities: 4,
        resourcesAdded: 60,
        resourcesRemoved: 0,
        resourcesChanged: 0,
      },
    });

    expect(summarizeRunDiff(diff)).toMatchObject({
      auditsLabel: "1 of 112",
      opportunitiesLabel: "1 of 4",
      urlRowsLabel: "1 of 60",
      unchangedAuditCount: 170,
      requestCountDelta: "+3",
      transferDelta: "+340.0 KB",
      thirdPartyDelta: "+3",
      resourcesUnavailable: false,
    });
  });

  it("keeps URL KEYS and REQUESTS as separate denominators", () => {
    // The three lists and `unchangedCount` count URL keys; the request counts
    // count requests. A page fetching one URL three times is 1 key, 3 requests.
    const diff = makeDiff({
      resources: makeResources({
        changed: [makeResource()],
        unchangedCount: 30,
        baselineRequestCount: 104,
        comparisonRequestCount: 107,
        baselineTransferSize: 1_000_000,
        comparisonTransferSize: 1_048_576,
      }),
    });

    expect(summarizeRunDiff(diff)).toMatchObject({
      urlRowsShown: 1,
      urlRowsTotal: 1,
      unchangedUrlCount: 30,
      urlKeysTotal: 31,
      baselineRequestCount: 104,
      comparisonRequestCount: 107,
      transferBaseline: "976.6 KB",
      transferComparison: "1.0 MB",
    });
  });

  it("carries the unavailable flag through untouched", () => {
    const diff = makeDiff({ resources: makeResources({ unavailable: true }) });
    expect(summarizeRunDiff(diff).resourcesUnavailable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Empty states                                                                */
/* -------------------------------------------------------------------------- */

describe("isIdenticalDiff", () => {
  it("is true only when nothing moved anywhere", () => {
    expect(isIdenticalDiff(makeDiff())).toBe(true);
  });

  it("is false when any section moved", () => {
    expect(isIdenticalDiff(makeDiff({ audits: [makeAudit()] }))).toBe(false);
    expect(
      isIdenticalDiff(
        makeDiff({ resources: makeResources({ added: [makeResource({ status: "added" })] }) }),
      ),
    ).toBe(false);
  });

  it("is false when a report predates the network trace — that is not 'identical'", () => {
    expect(isIdenticalDiff(makeDiff({ resources: makeResources({ unavailable: true }) }))).toBe(
      false,
    );
  });
});

describe("auditsEmptyReason", () => {
  it("is null while rows are on screen", () => {
    expect(auditsEmptyReason(makeDiff({ audits: [makeAudit()] }), 1, "all")).toBeNull();
  });

  it("blames the filter when the section has rows but none survive it", () => {
    const diff = makeDiff({ audits: [makeAudit({ status: "regressed" })] });
    expect(auditsEmptyReason(diff, 0, "improved")).toBe("filtered");
  });

  it("says the runs are identical when nothing moved at all", () => {
    expect(auditsEmptyReason(makeDiff(), 0, "all")).toBe("identical");
  });

  it("says only this section is quiet when others moved", () => {
    const diff = makeDiff({
      resources: makeResources({ added: [makeResource({ status: "added" })] }),
    });
    expect(auditsEmptyReason(diff, 0, "all")).toBe("none-in-section");
  });
});

describe("opportunitiesEmptyReason", () => {
  it("distinguishes identical runs from a quiet section", () => {
    expect(opportunitiesEmptyReason(makeDiff())).toBe("identical");
    expect(opportunitiesEmptyReason(makeDiff({ audits: [makeAudit()] }))).toBe(
      "none-in-section",
    );
    expect(opportunitiesEmptyReason(makeDiff({ opportunities: [makeOpportunity()] }))).toBeNull();
  });
});

describe("resourcesEmptyReason", () => {
  it("reports an unavailable trace before anything else", () => {
    const diff = makeDiff({
      audits: [makeAudit()],
      resources: makeResources({ unavailable: true }),
    });
    expect(resourcesEmptyReason(diff)).toBe("unavailable");
  });

  it("distinguishes identical runs from a quiet section", () => {
    expect(resourcesEmptyReason(makeDiff())).toBe("identical");
    expect(resourcesEmptyReason(makeDiff({ audits: [makeAudit()] }))).toBe("none-in-section");
  });

  it("is null once there is a request to show", () => {
    const diff = makeDiff({
      resources: makeResources({ changed: [makeResource()] }),
    });
    expect(resourcesEmptyReason(diff)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The AI hand-off                                                             */
/* -------------------------------------------------------------------------- */

describe("analysisCategories", () => {
  it("offers only the categories both runs scored, in canonical order", () => {
    expect(
      analysisCategories(
        { seo: 100, performance: 90, accessibility: 80 },
        { seo: 90, performance: 70 },
      ),
    ).toEqual(["performance", "seo"]);
  });

  it("falls back to performance rather than offering nothing", () => {
    expect(analysisCategories({}, {})).toEqual(["performance"]);
  });
});

describe("worstRegressedCategory", () => {
  it("picks the category that gave up the most points", () => {
    expect(
      worstRegressedCategory(
        { performance: 90, accessibility: 95, seo: 100 },
        { performance: 85, accessibility: 70, seo: 100 },
      ),
    ).toBe("accessibility");
  });

  it("defaults to the first comparable category when nothing regressed", () => {
    expect(
      worstRegressedCategory({ performance: 70, seo: 90 }, { performance: 90, seo: 95 }),
    ).toBe("performance");
  });

  it("ignores a category only one run scored", () => {
    expect(
      worstRegressedCategory(
        { performance: 90, accessibility: 99 },
        { performance: 80 },
      ),
    ).toBe("performance");
  });

  it("never returns a category off a run with no scores at all", () => {
    expect(worstRegressedCategory({}, {})).toBe("performance");
  });
});
