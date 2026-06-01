import { describe, expect, it } from "vitest";

import {
  buildThrottlingFlags,
  parseCategoryAudits,
  parseEnvironment,
  parseLhr,
} from "@/lib/lighthouse/runAudit";
import {
  type AuditOptions,
  type LighthouseResult,
} from "@/lib/lighthouse/types";

/** A small but representative in-memory LHR. No Chrome is launched here. */
function sampleLhr(): LighthouseResult {
  return {
    requestedUrl: "https://example.com/",
    finalDisplayedUrl: "https://example.com/home",
    fetchTime: "2026-05-26T12:00:00.000Z",
    lighthouseVersion: "13.0.0",
    runWarnings: ["a warning"],
    categories: {
      performance: { id: "performance", score: 0.92 },
      accessibility: { id: "accessibility", score: 1 },
      seo: { id: "seo", score: null },
      // "best-practices" intentionally omitted to test partial scores.
    },
    audits: {
      "largest-contentful-paint": {
        numericValue: 2345.6,
        displayValue: "2.3 s",
        score: 0.88,
      },
      "cumulative-layout-shift": {
        numericValue: 0.01,
        displayValue: "0.01",
        score: 1,
      },
      // No "interactive" audit (TTI absent in v13) → should parse to null.
      "uses-text-compression": {
        title: "Enable text compression",
        description: "Compress text-based resources.",
        displayValue: "Est savings of 0.45 s",
        score: 0.5,
        details: { type: "opportunity", overallSavingsMs: 450 },
      },
      "render-blocking-resources": {
        title: "Eliminate render-blocking resources",
        description: "Resources block first paint.",
        displayValue: "Est savings of 1.20 s",
        score: 0,
        details: { type: "opportunity", overallSavingsMs: 1200 },
      },
      "non-opportunity": {
        title: "Just a passing audit",
        description: "Not an opportunity.",
        score: 1,
        details: { type: "table" },
      },
    },
  };
}

describe("parseLhr", () => {
  it("normalises category scores from 0–1 to 0–100 (null preserved)", () => {
    const parsed = parseLhr(sampleLhr(), "mobile");
    expect(parsed.scores.performance).toBe(92);
    expect(parsed.scores.accessibility).toBe(100);
    expect(parsed.scores.seo).toBeNull();
    // Omitted category should not appear.
    expect(parsed.scores["best-practices"]).toBeUndefined();
  });

  it("maps metric audits and tolerates absent metrics", () => {
    const parsed = parseLhr(sampleLhr(), "mobile");
    expect(parsed.metrics["largest-contentful-paint"]).toEqual({
      numericValue: 2345.6,
      displayValue: "2.3 s",
      score: 0.88,
    });
    expect(parsed.metrics["cumulative-layout-shift"]?.numericValue).toBe(0.01);
    // Missing audits (TTI, TBT, FCP, SI) → null.
    expect(parsed.metrics.interactive).toBeNull();
    expect(parsed.metrics["total-blocking-time"]).toBeNull();
  });

  it("extracts opportunities sorted by savings desc", () => {
    const parsed = parseLhr(sampleLhr(), "mobile");
    expect(parsed.opportunities).toHaveLength(2);
    expect(parsed.opportunities[0]).toMatchObject({
      id: "render-blocking-resources",
      savingsMs: 1200,
    });
    expect(parsed.opportunities[1]).toMatchObject({
      id: "uses-text-compression",
      savingsMs: 450,
    });
    // The non-opportunity audit is excluded.
    expect(
      parsed.opportunities.some((o) => o.id === "non-opportunity"),
    ).toBe(false);
  });

  it("pulls urls, fetchTime, version, warnings and carries formFactor", () => {
    const parsed = parseLhr(sampleLhr(), "desktop");
    expect(parsed.requestedUrl).toBe("https://example.com/");
    expect(parsed.finalUrl).toBe("https://example.com/home");
    expect(parsed.fetchTime).toBe("2026-05-26T12:00:00.000Z");
    expect(parsed.lighthouseVersion).toBe("13.0.0");
    expect(parsed.runWarnings).toEqual(["a warning"]);
    expect(parsed.formFactor).toBe("desktop");
  });

  it("defaults missing top-level fields without throwing", () => {
    const parsed = parseLhr({}, "mobile");
    expect(parsed.requestedUrl).toBe("");
    expect(parsed.finalUrl).toBe("");
    expect(parsed.runWarnings).toEqual([]);
    expect(parsed.opportunities).toEqual([]);
    // Every metric id present and null.
    expect(parsed.metrics.interactive).toBeNull();
  });

  it("includes the parsed environment", () => {
    const parsed = parseLhr(sampleLhr(), "mobile");
    expect(parsed.environment).toEqual({
      benchmarkIndex: null,
      hostUserAgent: "",
      throttlingMethod: "",
      cpuSlowdownMultiplier: null,
    });
  });

  it("carries an empty bestPractices list when the category is absent", () => {
    // sampleLhr() intentionally omits the best-practices category.
    expect(parseLhr(sampleLhr(), "mobile").bestPractices).toEqual([]);
  });
});

/** An LHR with a populated best-practices category + matching audits. */
function bestPracticesLhr(): LighthouseResult {
  return {
    categories: {
      "best-practices": {
        id: "best-practices",
        score: 0.6,
        auditRefs: [
          { id: "is-on-https", weight: 5, group: "best-practices-trust-safety" },
          { id: "errors-in-console", weight: 1 },
          { id: "viewport", weight: 3 },
          { id: "charset", weight: 1 },
          { id: "bp-informative", weight: 0 },
          { id: "valid-source-maps", weight: 0 },
          { id: "ghost", weight: 1 }, // ref with no matching audit → tolerated
        ],
      },
    },
    audits: {
      "is-on-https": {
        title: "Use secure connections (HTTPS)",
        description: "All sites should be protected with HTTPS.",
        score: 0,
        scoreDisplayMode: "binary",
      },
      "errors-in-console": {
        title: "No browser errors logged to the console",
        description: "Errors logged to the console indicate unresolved problems.",
        score: 0,
        scoreDisplayMode: "binary",
        displayValue: "3 errors",
      },
      viewport: {
        title: "Has a `<meta name=viewport>` tag",
        description: "A viewport tag optimises for mobile.",
        score: 1,
        scoreDisplayMode: "binary",
      },
      charset: {
        title: "Charset declared early",
        description: "Declare the charset early.",
        score: 1,
        scoreDisplayMode: "binary",
      },
      "bp-informative": {
        title: "An informative diagnostic",
        description: "Informational only.",
        score: null,
        scoreDisplayMode: "informative",
      },
      "valid-source-maps": {
        title: "Page has valid source maps",
        description: "Source maps help debugging.",
        score: null,
        scoreDisplayMode: "notApplicable",
      },
      // "ghost" intentionally absent from audits.
    },
  };
}

describe("parseCategoryAudits", () => {
  it("joins auditRefs with audit results and derives state", () => {
    const refs = parseCategoryAudits(bestPracticesLhr(), "best-practices");
    expect(refs).toHaveLength(7);

    const byId = Object.fromEntries(refs.map((r) => [r.id, r]));
    expect(byId["is-on-https"]).toMatchObject({ weight: 5, state: "failed" });
    expect(byId["is-on-https"].group).toBe("best-practices-trust-safety");
    expect(byId["errors-in-console"]).toMatchObject({
      state: "failed",
      displayValue: "3 errors",
    });
    expect(byId.viewport.state).toBe("passed");
    expect(byId.charset.state).toBe("passed");
    expect(byId["bp-informative"].state).toBe("informative");
    expect(byId["valid-source-maps"].state).toBe("notApplicable");
    // Missing audit → title falls back to id, treated as failed.
    expect(byId.ghost).toMatchObject({ title: "ghost", state: "failed" });
  });

  it("sorts failed-first (weight desc), then passed, then informative/N-A", () => {
    const refs = parseCategoryAudits(bestPracticesLhr(), "best-practices");
    expect(refs.map((r) => r.state)).toEqual([
      "failed",
      "failed",
      "failed",
      "passed",
      "passed",
      "informative",
      "notApplicable",
    ]);
    // Highest-weight failed audit leads; passed group leads with its heaviest.
    expect(refs[0].id).toBe("is-on-https");
    expect(refs[3].id).toBe("viewport");
  });

  it("returns [] when the category or its auditRefs are missing", () => {
    expect(parseCategoryAudits({}, "best-practices")).toEqual([]);
    expect(
      parseCategoryAudits(
        { categories: { "best-practices": { score: 1 } } },
        "best-practices",
      ),
    ).toEqual([]);
  });

  it("is parameterised by category id (works for any category)", () => {
    const refs = parseCategoryAudits(bestPracticesLhr(), "performance");
    expect(refs).toEqual([]);
  });
});

/** Base validated options; tests override only the fields they exercise. */
function baseOptions(overrides: Partial<AuditOptions> = {}): AuditOptions {
  return {
    formFactor: "mobile",
    throttling: "simulated",
    categories: ["performance"],
    runs: 1,
    warmCache: true,
    ...overrides,
  };
}

describe("buildThrottlingFlags", () => {
  it("maps 'simulated' → throttlingMethod 'simulate' and 'applied' → 'devtools'", () => {
    expect(
      buildThrottlingFlags(baseOptions({ throttling: "simulated" }))
        .throttlingMethod,
    ).toBe("simulate");
    expect(
      buildThrottlingFlags(baseOptions({ throttling: "applied" }))
        .throttlingMethod,
    ).toBe("devtools");
  });

  it("emits NO throttling flag when the multiplier is omitted (keeps Lighthouse defaults)", () => {
    const flags = buildThrottlingFlags(baseOptions());
    expect(flags.throttlingMethod).toBe("simulate");
    expect(flags.throttling).toBeUndefined();
    expect("throttling" in flags).toBe(false);
  });

  it("preserves the mobile network throttling profile when a multiplier is set", () => {
    const flags = buildThrottlingFlags(
      baseOptions({ formFactor: "mobile", cpuSlowdownMultiplier: 8 }),
    );
    expect(flags.throttling).toBeDefined();
    const throttling = flags.throttling as Record<string, unknown>;
    // Only the CPU multiplier changes…
    expect(throttling.cpuSlowdownMultiplier).toBe(8);
    // …the 4G-class network profile from the mobile config is retained.
    expect(typeof throttling.rttMs).toBe("number");
    expect(typeof throttling.throughputKbps).toBe("number");
    expect(throttling.rttMs).toBeGreaterThan(0);
    expect(throttling.throughputKbps).toBeGreaterThan(0);
  });

  it("preserves the desktop network throttling profile when a multiplier is set", () => {
    const flags = buildThrottlingFlags(
      baseOptions({ formFactor: "desktop", cpuSlowdownMultiplier: 2 }),
    );
    const throttling = flags.throttling as Record<string, unknown>;
    expect(throttling.cpuSlowdownMultiplier).toBe(2);
    expect(typeof throttling.rttMs).toBe("number");
    expect(typeof throttling.throughputKbps).toBe("number");
    expect(throttling.rttMs).toBeGreaterThan(0);
    expect(throttling.throughputKbps).toBeGreaterThan(0);
  });

  it("works under 'applied' (devtools) too, still merging over the network profile", () => {
    const flags = buildThrottlingFlags(
      baseOptions({ throttling: "applied", cpuSlowdownMultiplier: 6 }),
    );
    expect(flags.throttlingMethod).toBe("devtools");
    const throttling = flags.throttling as Record<string, unknown>;
    expect(throttling.cpuSlowdownMultiplier).toBe(6);
    expect(typeof throttling.rttMs).toBe("number");
  });
});

describe("parseEnvironment", () => {
  it("reads benchmarkIndex/hostUserAgent and effective throttling from the LHR", () => {
    const lhr: LighthouseResult = {
      environment: { benchmarkIndex: 1234.5, hostUserAgent: "Chrome/130" },
      configSettings: {
        throttlingMethod: "devtools",
        throttling: { cpuSlowdownMultiplier: 6, rttMs: 40 },
      },
    };
    expect(parseEnvironment(lhr)).toEqual({
      benchmarkIndex: 1234.5,
      hostUserAgent: "Chrome/130",
      throttlingMethod: "devtools",
      cpuSlowdownMultiplier: 6,
    });
  });

  it("defaults gracefully when fields are absent", () => {
    expect(parseEnvironment({})).toEqual({
      benchmarkIndex: null,
      hostUserAgent: "",
      throttlingMethod: "",
      cpuSlowdownMultiplier: null,
    });
  });

  it("tolerates a non-numeric benchmarkIndex / missing throttling sub-object", () => {
    const lhr: LighthouseResult = {
      environment: { benchmarkIndex: "nope", hostUserAgent: "UA" },
      configSettings: { throttlingMethod: "simulate" },
    };
    expect(parseEnvironment(lhr)).toEqual({
      benchmarkIndex: null,
      hostUserAgent: "UA",
      throttlingMethod: "simulate",
      cpuSlowdownMultiplier: null,
    });
  });
});
