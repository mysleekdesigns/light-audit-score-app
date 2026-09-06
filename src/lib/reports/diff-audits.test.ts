import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LIGHTHOUSE_CATEGORIES, type LighthouseResult } from "@/lib/lighthouse/types";
import { MAX_DIFF_DESCRIPTION, type AuditDelta } from "@/lib/reports/diff-types";

import { diffAudits, diffOpportunities, rankAuditDeltas } from "./diff-audits";

// --- Fixtures ---------------------------------------------------------------

/** One audit result with the fields a real LH 13 audit carries. */
function audit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Reduce unused JavaScript",
    description: "Reduce unused JS to lower bytes consumed by network activity.",
    score: 1,
    scoreDisplayMode: "metricSavings",
    numericValue: 0,
    numericUnit: "millisecond",
    displayValue: "",
    ...overrides,
  };
}

/** An opportunity-shaped audit: the `details` half is what the predicate reads. */
function opportunity(
  savingsMs: number | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const details: Record<string, unknown> = { type: "opportunity", items: [] };
  if (savingsMs !== null) details.overallSavingsMs = savingsMs;
  return audit({ score: null, details, ...overrides });
}

type Refs = Partial<Record<string, { id: string; weight: number }[]>>;

/** A minimal LHR: an audits map plus the category `auditRefs` that weight them. */
function lhr(audits: Record<string, unknown>, categories: Refs = {}): LighthouseResult {
  return {
    audits,
    categories: Object.fromEntries(
      Object.entries(categories).map(([id, auditRefs]) => [id, { auditRefs }]),
    ),
  };
}

/** A complete {@link AuditDelta}, so ranking tests can state only what matters. */
function delta(overrides: Partial<AuditDelta> = {}): AuditDelta {
  return {
    id: "audit",
    title: "Audit",
    description: "",
    categories: [],
    weight: 0,
    baselineScore: null,
    comparisonScore: null,
    scoreDelta: null,
    baselineNumericValue: null,
    comparisonNumericValue: null,
    numericDelta: null,
    numericUnit: "",
    baselineDisplayValue: "",
    comparisonDisplayValue: "",
    scoreDisplayMode: "",
    status: "unchanged",
    basis: "none",
    ...overrides,
  };
}

/** A score regression of `loss` points on an audit of the given weight. */
function regression(id: string, weight: number, loss: number): AuditDelta {
  return delta({
    id,
    weight,
    baselineScore: 1,
    comparisonScore: 1 - loss,
    scoreDelta: -loss,
    status: "regressed",
    basis: "score",
  });
}

const byId = (deltas: { id: string }[]): string[] => deltas.map((entry) => entry.id);

// --- diffAudits -------------------------------------------------------------

describe("diffAudits", () => {
  it("classifies a regression, an improvement and a steady audit in one pass", () => {
    const deltas = diffAudits(
      lhr({ a: audit({ score: 1 }), b: audit({ score: 0.5 }), c: audit({ score: 0.75 }) }),
      lhr({ a: audit({ score: 0.5 }), b: audit({ score: 1 }), c: audit({ score: 0.75 }) }),
    );

    expect(deltas.map((entry) => [entry.id, entry.status, entry.basis])).toEqual([
      ["a", "regressed", "score"],
      ["b", "improved", "score"],
      ["c", "unchanged", "score"],
    ]);
    expect(deltas.map((entry) => entry.scoreDelta)).toEqual([-0.5, 0.5, 0]);
    expect(deltas[0]).toMatchObject({ baselineScore: 1, comparisonScore: 0.5 });
  });

  it("reports an audit present on one side only as added / removed", () => {
    const deltas = diffAudits(
      lhr({ gone: audit({ score: 0.5, numericValue: 100 }) }),
      lhr({ fresh: audit({ score: 0.5, numericValue: 100 }) }),
    );

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      id: "fresh",
      status: "added",
      basis: "presence",
      baselineScore: null,
      comparisonScore: 0.5,
      scoreDelta: null,
      baselineNumericValue: null,
      numericDelta: null,
    });
    expect(deltas[1]).toMatchObject({
      id: "gone",
      status: "removed",
      basis: "presence",
      baselineScore: 0.5,
      comparisonScore: null,
      scoreDelta: null,
      comparisonNumericValue: null,
      numericDelta: null,
    });
  });

  it("treats an audit that errored into a non-record as absent on that side", () => {
    const [only] = diffAudits(lhr({ a: "gatherer crashed" }), lhr({ a: audit() }));
    expect(only).toMatchObject({ id: "a", status: "added", basis: "presence" });

    // Unreadable on BOTH sides is nothing to classify at all.
    expect(diffAudits(lhr({ a: "x" }), lhr({ a: null }))).toEqual([]);
  });

  it("stays silent on a scored-vs-unscored pair rather than inventing a direction", () => {
    const appeared = diffAudits(
      lhr({ a: audit({ score: null }) }),
      lhr({ a: audit({ score: 0.5 }) }),
    );
    expect(appeared[0]).toMatchObject({
      status: "unchanged",
      basis: "none",
      baselineScore: null,
      comparisonScore: 0.5,
      scoreDelta: null,
    });

    const vanished = diffAudits(
      lhr({ a: audit({ score: 1 }) }),
      lhr({ a: audit({ score: null }) }),
    );
    expect(vanished[0]).toMatchObject({ status: "unchanged", basis: "none", scoreDelta: null });
  });

  it("falls back to the numeric value only when neither side is scored", () => {
    const worse = diffAudits(
      lhr({ a: audit({ score: null, numericValue: 1000 }) }),
      lhr({ a: audit({ score: null, numericValue: 2500 }) }),
    );
    expect(worse[0]).toMatchObject({
      status: "regressed",
      basis: "numeric",
      numericDelta: 1500,
      numericUnit: "millisecond",
    });

    const better = diffAudits(
      lhr({ a: audit({ score: null, numericValue: 2500 }) }),
      lhr({ a: audit({ score: null, numericValue: 1000 }) }),
    );
    expect(better[0]).toMatchObject({ status: "improved", basis: "numeric", numericDelta: -1500 });

    const steady = diffAudits(
      lhr({ a: audit({ score: null, numericValue: 1000 }) }),
      lhr({ a: audit({ score: null, numericValue: 1000 }) }),
    );
    expect(steady[0]).toMatchObject({ status: "unchanged", basis: "numeric", numericDelta: 0 });
  });

  it("lets the score own the classification even when the measurement moved", () => {
    // A metric can shift a long way inside one scoring band. The score is what
    // moved the category number, so it decides — and reports 0.
    const [only] = diffAudits(
      lhr({ lcp: audit({ score: 1, numericValue: 900 }) }),
      lhr({ lcp: audit({ score: 1, numericValue: 2200 }) }),
    );
    expect(only).toMatchObject({
      status: "unchanged",
      basis: "score",
      scoreDelta: 0,
      numericDelta: 1300,
    });
  });

  it("only reaches the numeric branch when both sides carry a number", () => {
    const [only] = diffAudits(
      lhr({ a: audit({ score: null, numericValue: undefined }) }),
      lhr({ a: audit({ score: null, numericValue: 500 }) }),
    );
    expect(only).toMatchObject({
      status: "unchanged",
      basis: "none",
      baselineNumericValue: null,
      numericDelta: null,
    });
  });

  it("is total over the union of ids and ordered by id", () => {
    const deltas = diffAudits(
      lhr({ zeta: audit(), alpha: audit(), mid: audit() }),
      lhr({ mid: audit(), beta: audit() }),
    );
    expect(byId(deltas)).toEqual(["alpha", "beta", "mid", "zeta"]);
    // Unchanged audits are the differ's job to report; the composer filters.
    expect(deltas.filter((entry) => entry.status === "unchanged")).toHaveLength(1);
  });

  it("joins categories from both sides in canonical order with the max weight", () => {
    const deltas = diffAudits(
      // Declared seo-first on purpose: the output order must be a property of
      // LIGHTHOUSE_CATEGORIES, not of however the report was written.
      lhr({ "document-title": audit() }, {
        seo: [{ id: "document-title", weight: 1 }],
        accessibility: [{ id: "document-title", weight: 7 }],
      }),
      // The comparison run's config dropped it from accessibility entirely.
      lhr({ "document-title": audit() }, { seo: [{ id: "document-title", weight: 1 }] }),
    );

    expect(deltas[0].categories).toEqual(["accessibility", "seo"]);
    expect(deltas[0].weight).toBe(7);
  });

  it("picks up a category that only the comparison run names", () => {
    const [only] = diffAudits(
      lhr({ a: audit() }),
      lhr({ a: audit() }, { "agentic-browsing": [{ id: "a", weight: 3 }] }),
    );
    expect(only.categories).toEqual(["agentic-browsing"]);
    expect(only.weight).toBe(3);
  });

  it("reports no category and zero weight for an audit nothing scores", () => {
    const [only] = diffAudits(lhr({ a: audit() }), lhr({ a: audit() }));
    expect(only.categories).toEqual([]);
    expect(only.weight).toBe(0);
  });

  it("truncates a description to the cap, ellipsis included", () => {
    const long = "x".repeat(MAX_DIFF_DESCRIPTION + 120);
    const [only] = diffAudits(lhr({ a: audit() }), lhr({ a: audit({ description: long }) }));

    expect(only.description).toHaveLength(MAX_DIFF_DESCRIPTION);
    expect(only.description.endsWith("…")).toBe(true);
  });

  it("never truncates an astral character into a lone surrogate", () => {
    const long = `${"x".repeat(MAX_DIFF_DESCRIPTION - 2)}👍tail`;
    const [only] = diffAudits(lhr({ a: audit() }), lhr({ a: audit({ description: long }) }));

    expect(only.description.endsWith("…")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(only.description)).toBe(false);
  });

  it("prefers the comparison run's labels and falls back to the baseline's", () => {
    const deltas = diffAudits(
      lhr({
        both: audit({ title: "Old title", scoreDisplayMode: "binary" }),
        gone: audit({ title: "Only baseline", numericUnit: "byte" }),
      }),
      lhr({ both: audit({ title: "New title", scoreDisplayMode: "metricSavings" }) }),
    );

    expect(deltas[0]).toMatchObject({
      id: "both",
      title: "New title",
      scoreDisplayMode: "metricSavings",
    });
    expect(deltas[1]).toMatchObject({
      id: "gone",
      title: "Only baseline",
      numericUnit: "byte",
    });
  });

  it("falls back to the audit id when neither side carries a title", () => {
    const [only] = diffAudits(lhr({ a: { score: 1 } }), lhr({ a: { score: 1 } }));
    expect(only.title).toBe("a");
    expect(only.description).toBe("");
  });

  it("carries each side's display value separately", () => {
    const [only] = diffAudits(
      lhr({ a: audit({ displayValue: "1.2 s" }) }),
      lhr({ a: audit({ displayValue: "3.4 s" }) }),
    );
    expect(only.baselineDisplayValue).toBe("1.2 s");
    expect(only.comparisonDisplayValue).toBe("3.4 s");
  });
});

// --- rankAuditDeltas --------------------------------------------------------

describe("rankAuditDeltas", () => {
  it("puts the heaviest score regression first", () => {
    const ranked = rankAuditDeltas([
      regression("light", 1, 1),
      regression("heavy", 10, 1),
      regression("medium", 3, 1),
    ]);
    expect(byId(ranked)).toEqual(["heavy", "medium", "light"]);
  });

  it("weighs the size of the drop, not just the weight", () => {
    const ranked = rankAuditDeltas([
      regression("small-drop-heavy", 10, 0.1), // impact 1
      regression("big-drop-light", 3, 1), // impact 3
    ]);
    expect(byId(ranked)).toEqual(["big-drop-light", "small-drop-heavy"]);
  });

  it("ranks a newly-present failing audit under score regressions but above the rest", () => {
    const ranked = rankAuditDeltas([
      delta({ id: "improved", weight: 10, scoreDelta: 1, status: "improved", basis: "score" }),
      delta({
        id: "new-failure",
        weight: 4,
        comparisonScore: 0,
        status: "added",
        basis: "presence",
      }),
      regression("regressed", 1, 0.5),
      delta({ id: "removed", weight: 9, status: "removed", basis: "presence" }),
      delta({
        id: "new-pass",
        weight: 4,
        comparisonScore: 1,
        status: "added",
        basis: "presence",
      }),
    ]);
    expect(byId(ranked)).toEqual([
      "regressed",
      "new-failure",
      "removed",
      "new-pass",
      "improved",
    ]);
  });

  it("ranks a numeric regression below every score regression", () => {
    const ranked = rankAuditDeltas([
      delta({
        id: "numeric",
        numericDelta: 900_000,
        status: "regressed",
        basis: "numeric",
      }),
      regression("scored", 0, 0.01),
    ]);
    expect(byId(ranked)).toEqual(["scored", "numeric"]);
  });

  it("separates weightless regressions by how far the score fell", () => {
    const ranked = rankAuditDeltas([
      regression("small", 0, 0.25),
      regression("large", 0, 1),
    ]);
    expect(byId(ranked)).toEqual(["large", "small"]);
  });

  it("breaks a dead tie on audit id, whatever order it is handed", () => {
    const tied = [regression("c", 5, 1), regression("a", 5, 1), regression("b", 5, 1)];
    expect(byId(rankAuditDeltas(tied))).toEqual(["a", "b", "c"]);
    expect(byId(rankAuditDeltas([...tied].reverse()))).toEqual(["a", "b", "c"]);
  });

  it("returns a new array and does not mutate its input", () => {
    const input = [regression("b", 1, 1), regression("a", 9, 1)];
    const ranked = rankAuditDeltas(input);
    expect(ranked).not.toBe(input);
    expect(byId(input)).toEqual(["b", "a"]);
    expect(byId(ranked)).toEqual(["a", "b"]);
  });

  it("handles an empty list", () => {
    expect(rankAuditDeltas([])).toEqual([]);
  });
});

// --- diffOpportunities ------------------------------------------------------

describe("diffOpportunities", () => {
  it("classifies more estimated waste as a regression and ranks it first", () => {
    const deltas = diffOpportunities(
      lhr({
        "unused-javascript": opportunity(300),
        "unused-css-rules": opportunity(900),
        redirects: opportunity(0),
      }),
      lhr({
        "unused-javascript": opportunity(1500),
        "unused-css-rules": opportunity(100),
        redirects: opportunity(0),
      }),
    );

    expect(deltas.map((entry) => [entry.id, entry.status, entry.savingsDeltaMs])).toEqual([
      ["unused-javascript", "regressed", 1200],
      ["redirects", "unchanged", 0],
      ["unused-css-rules", "improved", -800],
    ]);
  });

  it("surfaces an opportunity that only one side has, past the 15-per-side cap", () => {
    // `parseOpportunities` keeps only the top 15 by savings. The 16th here is
    // the SMALLEST, so a cap applied before the join would drop exactly the
    // entry the diff exists to report.
    const baselineAudits: Record<string, unknown> = {};
    const comparisonAudits: Record<string, unknown> = {};
    for (let index = 0; index < 15; index += 1) {
      baselineAudits[`opp-${index}`] = opportunity(5000 - index * 100);
      comparisonAudits[`opp-${index}`] = opportunity(5000 - index * 100);
    }
    comparisonAudits["late-arrival"] = opportunity(25);

    const deltas = diffOpportunities(lhr(baselineAudits), lhr(comparisonAudits));

    expect(deltas).toHaveLength(16);
    const late = deltas.find((entry) => entry.id === "late-arrival");
    expect(late).toMatchObject({
      status: "added",
      baselineSavingsMs: null,
      comparisonSavingsMs: 25,
      savingsDeltaMs: null,
    });
    // Ranked above every unchanged entry: 25 ms of brand-new waste beats 0.
    expect(deltas[0].id).toBe("late-arrival");
  });

  it("ranks a disappeared opportunity by the waste it took with it", () => {
    const deltas = diffOpportunities(
      lhr({ big: opportunity(4000), steady: opportunity(10) }),
      lhr({ steady: opportunity(10), fresh: opportunity(50) }),
    );
    expect(deltas.map((entry) => [entry.id, entry.status])).toEqual([
      ["fresh", "added"],
      ["steady", "unchanged"],
      ["big", "removed"],
    ]);
    expect(deltas[2].baselineSavingsMs).toBe(4000);
    expect(deltas[2].savingsDeltaMs).toBeNull();
  });

  it("reads an unlabelled audit that merely exposes overallSavingsMs", () => {
    // Shape-driven, not label-driven: no `details.type` assertion.
    const [only] = diffOpportunities(
      lhr({ a: audit({ details: { overallSavingsMs: 100 } }) }),
      lhr({ a: audit({ details: { overallSavingsMs: 400 } }) }),
    );
    expect(only).toMatchObject({ id: "a", status: "regressed", savingsDeltaMs: 300 });
  });

  it("stays silent when one side never quantified its savings", () => {
    const [only] = diffOpportunities(
      lhr({ a: opportunity(null) }),
      lhr({ a: opportunity(900) }),
    );
    expect(only).toMatchObject({
      status: "unchanged",
      baselineSavingsMs: null,
      comparisonSavingsMs: 900,
      savingsDeltaMs: null,
    });
  });

  it("mirrors the Opportunity vocabulary side-for-side", () => {
    const [only] = diffOpportunities(
      lhr({ a: opportunity(900, { displayValue: "Est savings of 0.9 s", score: 0.5 }) }),
      lhr({ a: opportunity(100, { displayValue: "Est savings of 0.1 s", score: 1 }) }),
    );
    expect(only).toEqual({
      id: "a",
      title: "Reduce unused JavaScript",
      description: "Reduce unused JS to lower bytes consumed by network activity.",
      baselineSavingsMs: 900,
      comparisonSavingsMs: 100,
      savingsDeltaMs: -800,
      baselineDisplayValue: "Est savings of 0.9 s",
      comparisonDisplayValue: "Est savings of 0.1 s",
      baselineScore: 0.5,
      comparisonScore: 1,
      status: "improved",
    });
  });

  it("ignores audits with no details and truncates the descriptions it keeps", () => {
    const long = "y".repeat(MAX_DIFF_DESCRIPTION + 40);
    const deltas = diffOpportunities(
      lhr({ plain: audit(), opp: opportunity(10, { description: long }) }),
      lhr({ plain: audit(), opp: opportunity(20, { description: long }) }),
    );
    expect(byId(deltas)).toEqual(["opp"]);
    expect(deltas[0].description).toHaveLength(MAX_DIFF_DESCRIPTION);
  });
});

// --- Tolerance --------------------------------------------------------------

describe("tolerance", () => {
  // Each of these is a shape a stored report can genuinely take (an errored
  // gatherer, a pre-categories report, a truncated file). None may reach the
  // route as a 500.
  const hostile: [string, LighthouseResult][] = [
    ["empty object", {}],
    ["null audits", { audits: null }],
    ["audits as a string", { audits: "nope" }],
    ["audits as an array", { audits: [] }],
    ["categories as a string", { audits: { a: audit() }, categories: "performance" }],
    ["categories as an array", { audits: { a: audit() }, categories: [] }],
    ["category as a string", { audits: { a: audit() }, categories: { seo: "x" } }],
    ["auditRefs as a string", { audits: { a: audit() }, categories: { seo: { auditRefs: "x" } } }],
    ["ref without an id", { audits: { a: audit() }, categories: { seo: { auditRefs: [{}] } } }],
    ["ref as a string", { audits: { a: audit() }, categories: { seo: { auditRefs: ["a"] } } }],
    ["weight as a string", {
      audits: { a: audit() },
      categories: { seo: { auditRefs: [{ id: "a", weight: "10" }] } },
    }],
    ["non-finite score", { audits: { a: audit({ score: NaN, numericValue: Infinity }) } }],
    ["details as a string", { audits: { a: audit({ details: "table" }) } }],
    ["savings as a string", { audits: { a: audit({ details: { overallSavingsMs: "900" } }) } }],
    ["numeric title", { audits: { a: { title: 7, description: 7, score: 1 } } }],
  ];

  for (const [name, input] of hostile) {
    it(`never throws: ${name}`, () => {
      expect(() => diffAudits(input, {})).not.toThrow();
      expect(() => diffAudits({}, input)).not.toThrow();
      expect(() => diffAudits(input, input)).not.toThrow();
      expect(() => diffOpportunities(input, input)).not.toThrow();
      expect(() => rankAuditDeltas(diffAudits(input, input))).not.toThrow();
    });
  }

  it("returns empty lists for two empty reports", () => {
    expect(diffAudits({}, {})).toEqual([]);
    expect(diffOpportunities({}, {})).toEqual([]);
  });

  it("degrades a malformed side to a wholesale added / removed diff", () => {
    const report = lhr({ a: audit(), b: audit() });
    expect(diffAudits({ audits: "corrupt" }, report).map((entry) => entry.status)).toEqual([
      "added",
      "added",
    ]);
    expect(diffAudits(report, { audits: "corrupt" }).map((entry) => entry.status)).toEqual([
      "removed",
      "removed",
    ]);
  });

  it("keeps a non-finite number out of the contract entirely", () => {
    const [only] = diffAudits(
      lhr({ a: audit({ score: NaN, numericValue: Infinity }) }),
      lhr({ a: audit({ score: 1, numericValue: 10 }) }),
    );
    expect(only).toMatchObject({
      baselineScore: null,
      baselineNumericValue: null,
      scoreDelta: null,
      numericDelta: null,
      status: "unchanged",
      basis: "none",
    });
  });

  it("does not mutate the reports it reads", () => {
    const baseline = lhr({ a: audit({ score: 1 }) }, { seo: [{ id: "a", weight: 1 }] });
    const comparison = lhr({ a: opportunity(500) }, { seo: [{ id: "a", weight: 5 }] });
    const before = [JSON.stringify(baseline), JSON.stringify(comparison)];

    rankAuditDeltas(diffAudits(baseline, comparison));
    diffOpportunities(baseline, comparison);

    expect([JSON.stringify(baseline), JSON.stringify(comparison)]).toEqual(before);
  });
});

// --- Against this install's stored reports ----------------------------------

/**
 * `data/` is gitignored, so a fresh checkout has no reports and this whole
 * describe skips. Where it DOES run it is the only test here reading numbers
 * nobody wrote by hand — which is how Phase D found the `-1` transfer-size
 * sentinel. Reports are chosen by a deterministic rule, never by filename: this
 * install's corpus is not the contract.
 */
const REPORTS_DIR = fileURLToPath(new URL("../../../data/reports/", import.meta.url));

function reportFiles(): string[] {
  try {
    return readdirSync(REPORTS_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

function readReport(name: string): LighthouseResult | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(`${REPORTS_DIR}${name}`, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as LighthouseResult)
      : null;
  } catch {
    return null;
  }
}

const REPORT_FILES = reportFiles();

/** The first report (by sorted filename) that carries both maps we need. */
function firstUsableReport(): { name: string; lhr: LighthouseResult } | null {
  for (const name of REPORT_FILES) {
    const report = readReport(name);
    if (report && report.audits && report.categories) return { name, lhr: report };
  }
  return null;
}

const SAMPLE = firstUsableReport();

/** `audits` of a real report, narrowed for the assertions below. */
function auditsOf(report: LighthouseResult): Record<string, Record<string, unknown>> {
  return report.audits as Record<string, Record<string, unknown>>;
}

/** The real weight a real report's categories give an audit, per category. */
function realWeights(report: LighthouseResult): Map<string, [string, number][]> {
  const found = new Map<string, [string, number][]>();
  const categories = report.categories as Record<string, { auditRefs?: unknown[] }>;
  for (const [categoryId, category] of Object.entries(categories)) {
    for (const ref of category.auditRefs ?? []) {
      const { id, weight } = ref as { id: string; weight: number };
      found.set(id, [...(found.get(id) ?? []), [categoryId, weight]]);
    }
  }
  return found;
}

describe.skipIf(SAMPLE === null)("against stored reports", () => {
  const sample = SAMPLE as { name: string; lhr: LighthouseResult };

  it("reports a real report diffed against itself as entirely unchanged", () => {
    const deltas = diffAudits(sample.lhr, sample.lhr);

    expect(deltas.length).toBe(Object.keys(auditsOf(sample.lhr)).length);
    expect(deltas.length).toBeGreaterThan(100);
    expect(deltas.every((entry) => entry.status === "unchanged")).toBe(true);
    expect(diffOpportunities(sample.lhr, sample.lhr).every((o) => o.status === "unchanged")).toBe(
      true,
    );
    // The composer's filter therefore empties the whole payload.
    expect(deltas.filter((entry) => entry.status !== "unchanged")).toEqual([]);
  });

  it("keeps every real description inside the cap, and some really need it", () => {
    const deltas = diffAudits({}, sample.lhr);
    const truncated = deltas.filter((entry) => entry.description.endsWith("…"));

    expect(deltas.every((entry) => entry.description.length <= MAX_DIFF_DESCRIPTION)).toBe(true);
    // Lighthouse's own copy runs long: this is a live path, not a guard.
    expect(truncated.length).toBeGreaterThan(0);
  });

  it("reads real multi-category membership and takes the larger real weight", () => {
    const weights = realWeights(sample.lhr);
    const multi = [...weights.entries()]
      .filter(([id, refs]) => refs.length > 1 && auditsOf(sample.lhr)[id] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    expect(multi.length).toBeGreaterThan(0);

    const deltas = diffAudits(sample.lhr, sample.lhr);
    for (const [id, refs] of multi) {
      const found = deltas.find((entry) => entry.id === id);
      expect(found?.weight).toBe(Math.max(...refs.map(([, weight]) => weight)));
      expect(found?.categories.length).toBe(refs.length);
      // Canonical order, never the report's own key order.
      expect(found?.categories).toEqual(
        LIGHTHOUSE_CATEGORIES.filter((category) => found?.categories.includes(category)),
      );
    }
  });

  it("ranks a mutated real audit first, carrying its real weight and score", () => {
    const weights = realWeights(sample.lhr);
    const audits = auditsOf(sample.lhr);
    // The heaviest audit this report actually scores.
    const [targetId, refs] = [...weights.entries()]
      .filter(([id]) => typeof audits[id]?.score === "number")
      .sort(
        ([, a], [, b]) =>
          Math.max(...b.map(([, w]) => w)) - Math.max(...a.map(([, w]) => w)),
      )[0];
    const targetWeight = Math.max(...refs.map(([, weight]) => weight));
    expect(targetWeight).toBeGreaterThan(0);

    const mutated = structuredClone(sample.lhr);
    auditsOf(mutated)[targetId].score = 0;
    delete auditsOf(mutated).redirects;
    auditsOf(mutated)["invented-audit"] = { title: "Invented", score: 0 };

    const moved = diffAudits(sample.lhr, mutated).filter((entry) => entry.status !== "unchanged");
    const ranked = rankAuditDeltas(moved);

    expect(ranked[0]).toMatchObject({
      id: targetId,
      status: "regressed",
      basis: "score",
      weight: targetWeight,
      baselineScore: audits[targetId].score as number,
      comparisonScore: 0,
    });
    expect(ranked[0].title).toBe(audits[targetId].title as string);
    // Then the newly-present failing audit, then the disappeared one.
    expect(byId(ranked.slice(1))).toEqual(["invented-audit", "redirects"]);
    expect(ranked[1]).toMatchObject({ status: "added", basis: "presence" });
    expect(ranked[2]).toMatchObject({ status: "removed", basis: "presence" });
  });

  it("diffs a real opportunity's real savings", () => {
    const opportunities = diffOpportunities(sample.lhr, sample.lhr);
    expect(opportunities.length).toBeGreaterThan(0);

    const [first] = opportunities;
    const raw = auditsOf(sample.lhr)[first.id];
    const details = raw.details as { overallSavingsMs?: number };
    expect(first.baselineSavingsMs).toBe(details.overallSavingsMs ?? null);
    expect(first.comparisonSavingsMs).toBe(first.baselineSavingsMs);
    expect(first.savingsDeltaMs).toBe(first.baselineSavingsMs === null ? null : 0);

    // Doubling one side's waste is a regression of exactly that much.
    const mutated = structuredClone(sample.lhr);
    const mutatedDetails = auditsOf(mutated)[first.id].details as {
      overallSavingsMs?: number;
    };
    mutatedDetails.overallSavingsMs = (details.overallSavingsMs ?? 0) + 1234;
    const [worst] = diffOpportunities(sample.lhr, mutated);
    expect(worst).toMatchObject({ id: first.id, status: "regressed", savingsDeltaMs: 1234 });
  });

  it("sees only lower-is-better numeric units across the whole stored corpus", () => {
    // The design assumption behind `basis: "numeric"`, checked against real data
    // rather than asserted: Lighthouse 13's numericUnit union is
    // 'byte' | 'millisecond' | 'element' | 'unitless', and every one of them is
    // a cost. A higher-is-better unit appearing here would break the fallback.
    const units = new Set<string>();
    let numericAudits = 0;
    for (const name of REPORT_FILES) {
      const report = readReport(name);
      if (!report?.audits) continue;
      for (const raw of Object.values(auditsOf(report))) {
        if (raw === null || typeof raw !== "object") continue;
        if (typeof raw.numericValue !== "number") continue;
        numericAudits += 1;
        units.add(typeof raw.numericUnit === "string" ? raw.numericUnit : "(absent)");
      }
    }

    expect(numericAudits).toBeGreaterThan(0);
    expect([...units].sort()).toEqual(["byte", "element", "millisecond", "unitless"]);
  });

  it("diffs two different real runs of the same page deterministically", () => {
    // Pair on (final URL, form factor) so the two runs are comparable, and take
    // the two oldest by fetch time for a stable choice.
    const groups = new Map<string, { name: string; lhr: LighthouseResult }[]>();
    for (const name of REPORT_FILES) {
      const report = readReport(name);
      if (!report?.audits || !report.categories) continue;
      const settings = report.configSettings as { formFactor?: string } | undefined;
      const key = `${String(report.finalDisplayedUrl ?? report.finalUrl ?? "")}|${
        settings?.formFactor ?? ""
      }`;
      groups.set(key, [...(groups.get(key) ?? []), { name, lhr: report }]);
    }

    const candidates = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, runs]) =>
        [...runs].sort((a, b) =>
          String(a.lhr.fetchTime).localeCompare(String(b.lhr.fetchTime)),
        ),
      )
      .filter((runs) => runs.length >= 2);
    if (candidates.length === 0) return;

    // Prefer a pair whose audit id sets actually differ, so the added/removed
    // assertions below are exercised rather than vacuously satisfied. Real runs
    // of one page do differ: this corpus has runs that dropped `bf-cache` and
    // `modern-http-insight` entirely, which is what `removed` is for.
    const differs = (runs: { lhr: LighthouseResult }[]): boolean => {
      const left = Object.keys(auditsOf(runs[0].lhr));
      const right = new Set(Object.keys(auditsOf(runs[1].lhr)));
      return left.length !== right.size || left.some((id) => !right.has(id));
    };
    const [baseline, comparison] = (candidates.find(differs) ?? candidates[0]).slice(0, 2);

    const deltas = diffAudits(baseline.lhr, comparison.lhr);
    const baselineIds = new Set(Object.keys(auditsOf(baseline.lhr)));
    const comparisonIds = new Set(Object.keys(auditsOf(comparison.lhr)));

    // Total over the union, and the presence classes are the real set difference.
    expect(deltas.length).toBe(new Set([...baselineIds, ...comparisonIds]).size);
    expect(deltas.filter((entry) => entry.status === "added").map((entry) => entry.id)).toEqual(
      [...comparisonIds].filter((id) => !baselineIds.has(id)).sort(),
    );
    expect(deltas.filter((entry) => entry.status === "removed").map((entry) => entry.id)).toEqual(
      [...baselineIds].filter((id) => !comparisonIds.has(id)).sort(),
    );

    // The category join, cross-checked against both reports' own auditRefs.
    // Real pairs here include a run that carried the whole agentic-browsing
    // category and one that did not, so the union is doing real work.
    const baselineWeights = realWeights(baseline.lhr);
    const comparisonWeights = realWeights(comparison.lhr);
    for (const entry of deltas) {
      const refs = [
        ...(baselineWeights.get(entry.id) ?? []),
        ...(comparisonWeights.get(entry.id) ?? []),
      ];
      expect(entry.weight).toBe(
        refs.length === 0 ? 0 : Math.max(...refs.map(([, weight]) => weight)),
      );
      expect(entry.categories).toEqual(
        LIGHTHOUSE_CATEGORIES.filter((category) =>
          refs.some(([categoryId]) => categoryId === category),
        ),
      );
    }

    for (const entry of deltas) {
      expect(entry.description.length).toBeLessThanOrEqual(MAX_DIFF_DESCRIPTION);
      if (entry.status === "regressed" && entry.basis === "score") {
        expect(entry.scoreDelta).toBeLessThan(0);
      }
      if (entry.status === "improved" && entry.basis === "score") {
        expect(entry.scoreDelta).toBeGreaterThan(0);
      }
      if (entry.basis === "presence") {
        expect(entry.scoreDelta).toBeNull();
        expect(entry.numericDelta).toBeNull();
      }
    }

    // Ranking a real, unsorted list is stable across calls.
    expect(byId(rankAuditDeltas(deltas))).toEqual(byId(rankAuditDeltas([...deltas].reverse())));
  });
});
