/**
 * `compare_runs` (ROADMAP Phase G) — the projection, and the refusals.
 *
 * Split in two on purpose, because the two halves have different costs:
 *
 *  - {@link projectRunDiff} is pure, so it is tested against a hand-built
 *    {@link RunDiff}. That is the only way to assert the properties that matter
 *    — the caps, the truncation arithmetic, the clamping, and the absence of any
 *    request URL — on a diff shaped exactly the way a hostile or degenerate
 *    report would shape it. Driving those through two real stored LHRs would
 *    mean fabricating megabytes to move one field.
 *  - The argument refusals go through the handler, since the whole point of them
 *    is that they happen BEFORE any lookup: none of these tests touches SQLite
 *    or a report on disk, and a regression that moved a check after the lookup
 *    would show up here as a thrown DB error rather than a clean rejection.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDbForTests } from "@/lib/db/client";
import type { CategoryScores } from "@/lib/lighthouse/types";
import {
  MAX_LISTED_DELTAS,
  MAX_RUN_ID_LENGTH,
  compareRunsTool,
  projectRunDiff,
} from "@/lib/mcp/tools/compare-runs";
import { McpToolError } from "@/lib/mcp/types";
import type {
  AuditDelta,
  OpportunityDelta,
  ResourceDelta,
  RunDiff,
} from "@/lib/reports/diff-types";
import { MAX_TITLE } from "@/lib/compare/what-changed-view";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function makeAudit(overrides: Partial<AuditDelta> = {}): AuditDelta {
  return {
    id: "unused-javascript",
    title: "Reduce unused JavaScript",
    description: "Reduce unused JavaScript and defer loading scripts until they are required.",
    categories: ["performance"],
    weight: 5,
    // 91 and 85 once rounded — deliberately values whose 0–1 delta (-0.068)
    // rounds to -7 while the rounded scores differ by 6. See `pointsDelta`.
    baselineScore: 0.914,
    comparisonScore: 0.846,
    scoreDelta: -0.068,
    baselineNumericValue: 100_000,
    comparisonNumericValue: 448_000,
    numericDelta: 348_000,
    numericUnit: "byte",
    baselineDisplayValue: "Potential savings of 98 KiB",
    comparisonDisplayValue: "Potential savings of 437 KiB",
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
    description: "Resources are blocking the first paint of your page.",
    baselineSavingsMs: 120.4,
    comparisonSavingsMs: 940.6,
    savingsDeltaMs: 820.2,
    baselineDisplayValue: "Potential savings of 120 ms",
    comparisonDisplayValue: "Potential savings of 940 ms",
    baselineScore: 0.9,
    comparisonScore: 0.3,
    status: "regressed",
    ...overrides,
  };
}

/** A request row. Only ever used to prove that NONE of it reaches the payload. */
function makeResource(url: string): ResourceDelta {
  return {
    url,
    path: new URL(url).pathname,
    host: new URL(url).hostname,
    resourceType: "Script",
    thirdParty: true,
    baselineCount: 0,
    comparisonCount: 1,
    baselineTransferSize: null,
    comparisonTransferSize: 240_000,
    transferDelta: null,
    status: "added",
  };
}

const BASELINE_SCORES: CategoryScores = {
  performance: 91,
  accessibility: 96,
  "best-practices": 100,
  seo: 92,
};

const COMPARISON_SCORES: CategoryScores = {
  performance: 83,
  accessibility: 96,
  "best-practices": 100,
  seo: 92,
  // Scored in the comparison run only — must NOT appear in `scoreDeltas`.
  "agentic-browsing": 70,
};

function makeDiff(overrides: Partial<RunDiff> = {}): RunDiff {
  const audits = overrides.audits ?? [makeAudit()];
  const opportunities = overrides.opportunities ?? [makeOpportunity()];
  return {
    baseline: {
      runId: "run-baseline",
      finalUrl: "https://a.test/",
      fetchTime: "2026-05-01T00:00:00.000Z",
      lighthouseVersion: "13.3.0",
      scores: BASELINE_SCORES,
    },
    comparison: {
      runId: "run-comparison",
      finalUrl: "https://a.test/",
      fetchTime: "2026-05-08T00:00:00.000Z",
      lighthouseVersion: "13.3.0",
      scores: COMPARISON_SCORES,
    },
    audits,
    opportunities,
    resources: {
      added: [makeResource("https://tracker.test/beacon.js")],
      removed: [],
      changed: [],
      unchangedCount: 27,
      baselineRequestCount: 30,
      comparisonRequestCount: 34,
      requestCountDelta: 4,
      baselineTransferSize: 1_000_000,
      comparisonTransferSize: 1_348_000,
      transferSizeDelta: 348_000,
      baselineThirdPartyCount: 3,
      comparisonThirdPartyCount: 5,
      unavailable: false,
    },
    unchangedAuditCount: 148,
    totals: {
      audits: audits.length,
      opportunities: opportunities.length,
      resourcesAdded: 1,
      resourcesRemoved: 0,
      resourcesChanged: 0,
    },
    urlMismatch: false,
    ...overrides,
  };
}

const LIMITS = { maxAudits: 8, maxOpportunities: 5 };

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

describe("projectRunDiff", () => {
  it("keeps both sides' identity and only the categories they scored", () => {
    const payload = projectRunDiff(makeDiff(), LIMITS);

    expect(payload.baseline).toEqual({
      runId: "run-baseline",
      finalUrl: "https://a.test/",
      fetchTime: "2026-05-01T00:00:00.000Z",
      scores: BASELINE_SCORES,
    });
    expect(payload.comparison.runId).toBe("run-comparison");
    // A category only ONE run scored is silence, not a catastrophic regression.
    expect(payload.scoreDeltas).toEqual({
      performance: -8,
      accessibility: 0,
      "best-practices": 0,
      seo: 0,
    });
    expect("agentic-browsing" in payload.scoreDeltas).toBe(false);
  });

  it("puts the audit's numbers on the 0–100 scale, with a self-consistent delta", () => {
    const [audit] = projectRunDiff(makeDiff(), LIMITS).audits;

    expect(audit.baselineScore).toBe(91);
    expect(audit.comparisonScore).toBe(85);
    // Scaling the contract's own -0.068 would print -7 beside "91 → 85".
    expect(audit.scoreDelta).toBe(-6);
    expect(audit.comparisonScore! - audit.baselineScore!).toBe(audit.scoreDelta);
  });

  it("carries the measurement beside a scored audit", () => {
    const [audit] = projectRunDiff(makeDiff(), LIMITS).audits;

    // 348 000 bytes of new script — the fact that turns "-6 points" into a task.
    expect(audit.note).toBe("+339.8 KB");
  });

  it("reports a scoreless diagnostic's own measurement as its note", () => {
    const diff = makeDiff({
      audits: [
        makeAudit({
          id: "total-byte-weight",
          title: "Avoid enormous network payloads",
          baselineScore: null,
          comparisonScore: null,
          scoreDelta: null,
          basis: "numeric",
        }),
      ],
    });

    const [audit] = projectRunDiff(diff, LIMITS).audits;

    expect(audit.baselineScore).toBeNull();
    expect(audit.scoreDelta).toBeNull();
    expect(audit.note).toBe("+339.8 KB");
  });

  it("says which side a presence-only audit was on, and signs nothing", () => {
    const diff = makeDiff({
      audits: [
        makeAudit({
          id: "bf-cache",
          baselineScore: null,
          scoreDelta: null,
          numericDelta: null,
          status: "added",
          basis: "presence",
        }),
      ],
    });

    const [audit] = projectRunDiff(diff, LIMITS).audits;

    expect(audit.status).toBe("added");
    expect(audit.note).toBe("present only in the comparison run");
  });

  it("omits the note entirely when the numbers already say it all", () => {
    const diff = makeDiff({ audits: [makeAudit({ numericDelta: null })] });

    expect(projectRunDiff(diff, LIMITS).audits[0].note).toBeUndefined();
  });

  it("rounds an opportunity's savings and derives the delta from them", () => {
    const [opportunity] = projectRunDiff(makeDiff(), LIMITS).opportunities;

    expect(opportunity.baselineSavingsMs).toBe(120);
    expect(opportunity.comparisonSavingsMs).toBe(941);
    // Positive means the comparison run wastes MORE — the contract's convention.
    expect(opportunity.savingsDeltaMs).toBe(821);
  });

  it("caps both lists and says how many movers it left out", () => {
    const audits = Array.from({ length: 12 }, (_, index) =>
      makeAudit({ id: `audit-${index}` }),
    );
    const opportunities = Array.from({ length: 9 }, (_, index) =>
      makeOpportunity({ id: `opportunity-${index}` }),
    );
    const diff = makeDiff({
      audits,
      opportunities,
      // The differ's own caps already bit: 60 audits moved, 12 were listed.
      totals: {
        audits: 60,
        opportunities: 9,
        resourcesAdded: 1,
        resourcesRemoved: 0,
        resourcesChanged: 0,
      },
    });

    const payload = projectRunDiff(diff, { maxAudits: 4, maxOpportunities: 2 });

    expect(payload.audits).toHaveLength(4);
    expect(payload.opportunities).toHaveLength(2);
    // Counted from the PRE-cap total, so it covers the differ's truncation too —
    // 60 moved, 4 shown, 56 unseen. Counting off the 12-row list would claim 8.
    expect(payload.truncated).toEqual({ audits: 56, opportunities: 7 });
  });

  it("reports nothing truncated when both lists are complete", () => {
    expect(projectRunDiff(makeDiff(), LIMITS).truncated).toEqual({
      audits: 0,
      opportunities: 0,
    });
  });

  it("clamps a title and strips the control/bidi class from it and from the id", () => {
    const diff = makeDiff({
      audits: [
        makeAudit({
          // Escapes, not the characters themselves: written literally they are
          // invisible in a diff and a formatter eats them.
          id: "unused-\u0000javascript",
          title: `\u202eDangerous ${"x".repeat(400)}`,
        }),
      ],
    });

    const [audit] = projectRunDiff(diff, LIMITS).audits;

    // A C0/C1 control becomes a SPACE rather than vanishing (see `displaySafe`
    // in `@/lib/mcp/text`): deleting it would merge the words either side, which
    // in a title invents a token the report never contained. Here that shows up
    // as a space inside an id that could not legally contain one anyway.
    expect(audit.id).toBe("unused- javascript");
    expect(audit.title.startsWith("Dangerous")).toBe(true);
    expect(audit.title).toHaveLength(MAX_TITLE);
    expect(audit.title.endsWith("…")).toBe(true);
    expect(audit.title).not.toMatch(/[\u0000\u202e]/);
  });

  it("clamps a page-chosen final URL", () => {
    const long = `https://a.test/${"p".repeat(2_000)}`;
    const diff = makeDiff();
    const payload = projectRunDiff(
      { ...diff, comparison: { ...diff.comparison, finalUrl: long } },
      LIMITS,
    );

    expect(payload.comparison.finalUrl.length).toBeLessThanOrEqual(300);
  });

  it("summarises the requests without ever naming one", () => {
    const payload = projectRunDiff(makeDiff(), LIMITS);

    expect(payload.resources).toEqual({
      added: 1,
      removed: 0,
      changed: 0,
      unchanged: 27,
      requestCountDelta: 4,
      transferSizeDelta: 348_000,
      unavailable: false,
    });
    // The unbounded, page-controlled half of the contract, gone entirely.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("tracker.test");
    expect(serialized).not.toContain("beacon.js");
    expect(serialized).not.toContain("resourceType");
  });

  it("counts requests from the pre-cap totals, not the capped lists", () => {
    const diff = makeDiff();
    const payload = projectRunDiff(
      {
        ...diff,
        totals: { ...diff.totals, resourcesAdded: 140, resourcesChanged: 41 },
      },
      LIMITS,
    );

    expect(payload.resources.added).toBe(140);
    expect(payload.resources.changed).toBe(41);
  });

  it("passes through the two facts that qualify every other number", () => {
    const payload = projectRunDiff(makeDiff({ urlMismatch: true }), LIMITS);

    expect(payload.urlMismatch).toBe(true);
    expect(payload.unchangedAuditCount).toBe(148);
    expect(payload.summary).toContain("finished on different URLs");
  });

  it("heads the summary with the worst regression and the pre-cap totals", () => {
    const diff = makeDiff({
      totals: {
        audits: 60,
        opportunities: 9,
        resourcesAdded: 1,
        resourcesRemoved: 0,
        resourcesChanged: 0,
      },
    });

    const { summary } = projectRunDiff(diff, { maxAudits: 2, maxOpportunities: 1 });

    expect(summary).toContain("Performance 91 → 83 (-8)");
    // 60, not the 2 rows the caller asked to see.
    expect(summary).toContain("60 audits moved");
    expect(summary).toContain("9 opportunities moved");
    expect(summary).toContain("requests +4 (+339.8 KB)");
  });

  it("says so when a report predates the network trace instead of claiming +0", () => {
    const diff = makeDiff();
    const payload = projectRunDiff(
      { ...diff, resources: { ...diff.resources, unavailable: true } },
      LIMITS,
    );

    expect(payload.resources.unavailable).toBe(true);
    expect(payload.summary).toContain("no request data");
  });

  it("survives a diff in which nothing moved", () => {
    const diff = makeDiff({
      audits: [],
      opportunities: [],
      totals: {
        audits: 0,
        opportunities: 0,
        resourcesAdded: 0,
        resourcesRemoved: 0,
        resourcesChanged: 0,
      },
    });

    const payload = projectRunDiff(diff, LIMITS);

    expect(payload.audits).toEqual([]);
    expect(payload.truncated).toEqual({ audits: 0, opportunities: 0 });
    expect(payload.summary).toContain("0 audits moved");
  });
});

/* -------------------------------------------------------------------------- */
/* Argument refusals                                                           */
/* -------------------------------------------------------------------------- */

describe("compare_runs arguments", () => {
  let tmpDir: string;

  // Every case below is refused before a lookup, so nothing here should touch
  // SQLite. The temp DB exists only so that a regression which moved a check
  // AFTER the lookup fails as a wrong-message assertion rather than by writing
  // to the developer's real archive.
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-mcp-compare-"));
    process.env.LH_DATA_DIR = tmpDir;
    process.env.LH_DB_PATH = path.join(tmpDir, "test.db");
    resetDbForTests();
  });

  afterEach(async () => {
    resetDbForTests();
    delete process.env.LH_DATA_DIR;
    delete process.env.LH_DB_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("refuses a run diffed against itself", async () => {
    const rejected = compareRunsTool.handler({
      baselineRunId: "run-1",
      comparisonRunId: "run-1",
    });

    await expect(rejected).rejects.toBeInstanceOf(McpToolError);
    await expect(rejected).rejects.toThrow(/two different runs/);
  });

  it("refuses an over-long id without echoing it", async () => {
    const overLong = `${"a".repeat(MAX_RUN_ID_LENGTH)}-secret-token-value`;
    const rejected = compareRunsTool.handler({
      baselineRunId: overLong,
      comparisonRunId: "run-2",
    });

    await expect(rejected).rejects.toThrow(
      new RegExp(`at most ${MAX_RUN_ID_LENGTH} characters`),
    );
    await expect(rejected).rejects.not.toThrow(/secret-token-value/);
  });

  it("accepts an id exactly at the ceiling (the bound is not off by one)", async () => {
    // Reaches the lookup and fails there — which is the proof it was not refused
    // by the length check.
    const rejected = compareRunsTool.handler({
      baselineRunId: "a".repeat(MAX_RUN_ID_LENGTH),
      comparisonRunId: "run-2",
    });

    await expect(rejected).rejects.toThrow(/no run with a stored report/);
  });

  it("names which of the two ids has no stored report", async () => {
    await expect(
      compareRunsTool.handler({ baselineRunId: "run-1", comparisonRunId: "run-2" }),
    ).rejects.toThrow(/"baselineRunId" names no run with a stored report/);
  });

  it("requires both ids", async () => {
    await expect(
      compareRunsTool.handler({ comparisonRunId: "run-2" }),
    ).rejects.toThrow(/"baselineRunId" is required/);
    await expect(
      compareRunsTool.handler({ baselineRunId: "run-1" }),
    ).rejects.toThrow(/"comparisonRunId" is required/);
  });

  it("rejects an unknown argument by name", async () => {
    const rejected = compareRunsTool.handler({
      baselineRunId: "run-1",
      comparisonRunId: "run-2",
      baseline: "run-1",
    });

    await expect(rejected).rejects.toThrow(/"baseline"/);
    await expect(rejected).rejects.toThrow(/"baselineRunId"/);
  });

  it("rejects a cap outside its bounds rather than clamping it", async () => {
    await expect(
      compareRunsTool.handler({
        baselineRunId: "run-1",
        comparisonRunId: "run-2",
        maxAudits: 0,
      }),
    ).rejects.toThrow(new RegExp(`between 1 and ${MAX_LISTED_DELTAS}`));
    await expect(
      compareRunsTool.handler({
        baselineRunId: "run-1",
        comparisonRunId: "run-2",
        maxOpportunities: 99,
      }),
    ).rejects.toThrow(new RegExp(`between 1 and ${MAX_LISTED_DELTAS}`));
  });

  it("publishes itself as read-only and closed-world", () => {
    expect(compareRunsTool.name).toBe("compare_runs");
    expect(compareRunsTool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(compareRunsTool.inputSchema.additionalProperties).toBe(false);
    expect(compareRunsTool.inputSchema.required).toEqual([
      "baselineRunId",
      "comparisonRunId",
    ]);
  });
});
