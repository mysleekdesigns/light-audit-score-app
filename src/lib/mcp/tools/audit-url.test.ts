/**
 * `audit_url` unit tests (ROADMAP Phase G).
 *
 * Two halves, and the split is deliberate: **no test here launches Chrome.**
 *
 *  - The handler is exercised only along paths that reject before
 *    `runBatchToCompletion` is reached — every argument mistake a model can
 *    make. That is most of what this tool's correctness consists of: the audit
 *    itself is `src/lib/ci/runBatch`'s, already covered, and running one here
 *    would trade a 5ms test for a 60s one to re-prove somebody else's code.
 *  - Everything downstream of the audit is `projectAuditRow`, which is pure and
 *    is tested against `HistoryRow` literals. That function existing as a named
 *    export is the reason the payload can be pinned at all.
 */

import { describe, expect, it } from "vitest";

import type { HistoryRow } from "@/lib/db/persistence";
import { resolveAuditOptions } from "@/lib/lighthouse/options";
import {
  LIGHTHOUSE_CATEGORIES,
  type CoreWebVitals,
} from "@/lib/lighthouse/types";
import {
  DEFAULT_AGENT_RUNS,
  auditUrlTool,
  projectAuditRow,
} from "@/lib/mcp/tools/audit-url";
import { McpToolError } from "@/lib/mcp/types";

/** Build a {@link HistoryRow}, defaulting everything a given test doesn't assert on. */
function makeRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: "run-1",
    batchId: "batch-1",
    url: "https://example.test/",
    finalUrl: "https://example.test/home",
    status: "done",
    errorMessage: null,
    formFactor: "mobile",
    source: "local",
    runs: 1,
    options: {
      formFactor: "mobile",
      throttling: "simulated",
      categories: ["performance", "accessibility", "best-practices", "seo"],
      runs: 1,
      warmCache: true,
    },
    scores: {
      performance: 91,
      accessibility: 88,
      "best-practices": 100,
      seo: 80,
      "agentic-browsing": null,
    },
    metrics: null,
    field: null,
    environment: null,
    hasJsonReport: true,
    hasHtmlReport: true,
    fetchTime: "2026-09-06T00:00:00.000Z",
    createdAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

/** Core Web Vitals with two measured metrics and four absent ones. */
function makeMetrics(): CoreWebVitals {
  return {
    "largest-contentful-paint": {
      numericValue: 2410,
      displayValue: "2.4 s",
      score: 0.62,
    },
    "cumulative-layout-shift": {
      numericValue: 0.013,
      displayValue: "0.013",
      score: 1,
    },
    "total-blocking-time": null,
    "first-contentful-paint": null,
    "speed-index": null,
    interactive: null,
  };
}

/** The handler's rejection message, or a failure if it did not reject. */
async function rejectionMessage(args: Record<string, unknown>): Promise<string> {
  try {
    await auditUrlTool.handler(args);
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolError);
    return (error as McpToolError).message;
  }
  throw new Error("expected the handler to reject");
}

describe("audit_url — published contract", () => {
  it("names itself and its arguments the way tools/index expects", () => {
    expect(auditUrlTool.name).toBe("audit_url");
    expect(auditUrlTool.inputSchema.required).toEqual(["url"]);
    expect(auditUrlTool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(auditUrlTool.inputSchema.properties)).toEqual([
      "url",
      "device",
      "categories",
      "runs",
    ]);
  });

  it("declares itself as the one tool that writes and reaches the network", () => {
    expect(auditUrlTool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("publishes runs: 1 as the default and tells the caller that 3 is the app's", () => {
    // The whole justification for diverging from the app lives in the prose the
    // model reads, so a schema default with no explanation would be the bug.
    expect(DEFAULT_AGENT_RUNS).toBe(1);
    expect(auditUrlTool.inputSchema.properties.runs).toMatchObject({
      default: 1,
    });
    expect(auditUrlTool.description).toMatch(/runs: 3/);
    expect(auditUrlTool.description).toMatch(/default of 3/);
  });

  it("promises no Lighthouse report, and says where to get one", () => {
    expect(auditUrlTool.description).toMatch(/never the Lighthouse report/i);
    expect(auditUrlTool.description).toMatch(/check_budget/);
    expect(auditUrlTool.description).toMatch(/compare_runs/);
  });

  it("lets the app's own schema supply the all-five categories default", () => {
    // The handler passes `categories` straight through even when the caller
    // omitted it, rather than re-stating the default — which is only correct
    // because the schema applies its default to an explicit `undefined`. Pinned
    // here because it is the ONE assumption in the handler that no other test
    // reaches (the paths that would are the ones that launch Chrome), and if it
    // ever stopped holding, every default audit would fail at the door.
    expect(
      resolveAuditOptions({
        formFactor: "mobile",
        categories: undefined,
        runs: DEFAULT_AGENT_RUNS,
      }),
    ).toMatchObject({
      categories: [...LIGHTHOUSE_CATEGORIES],
      formFactor: "mobile",
      runs: 1,
    });
  });
});

describe("audit_url — argument validation", () => {
  it("names the invented argument AND the ones that exist", async () => {
    const message = await rejectionMessage({
      page_url: "https://example.test",
    });
    expect(message).toContain('"page_url"');
    expect(message).toContain('"url"');
    expect(message).toContain('"device"');
    expect(message).toContain('"categories"');
    expect(message).toContain('"runs"');
  });

  it("requires a non-empty url", async () => {
    expect(await rejectionMessage({})).toContain('"url" is required');
    expect(await rejectionMessage({ url: "   " })).toContain('"url" is required');
    expect(await rejectionMessage({ url: 42 })).toContain('"url" is required');
  });

  it("refuses targets the engine cannot audit", async () => {
    expect(await rejectionMessage({ url: "ftp://example.test/" })).toContain(
      "Only http and https URLs",
    );
    expect(await rejectionMessage({ url: "http://" })).toContain("Not a URL");
    expect(
      await rejectionMessage({ url: "https://example.test/\u001bfoo" }),
    ).toContain("control characters");
  });

  it("refuses a URL carrying credentials, and says where they belong", async () => {
    // The archive and any published report would otherwise carry the password.
    const message = await rejectionMessage({
      url: "https://user:pw@example.test/",
    });
    expect(message).toContain("username or password");
    expect(message).toContain("LH_AUDIT_BASIC_AUTH");
  });

  it("rejects a device that is not a form factor", async () => {
    // "both" is a batch-level fan-out, not something one audit can be.
    const message = await rejectionMessage({
      url: "https://example.test/",
      device: "both",
    });
    expect(message).toContain('"device" must be one of');
    expect(message).toContain('"mobile"');
    expect(message).toContain('"desktop"');
  });

  it("rejects unknown or empty category lists", async () => {
    expect(
      await rejectionMessage({
        url: "https://example.test/",
        categories: ["perfomance"],
      }),
    ).toContain('"categories" accepts only');
    expect(
      await rejectionMessage({
        url: "https://example.test/",
        categories: [],
      }),
    ).toContain('"categories" must be a non-empty array');
  });

  it("rejects a runs value outside MIN_RUNS..MAX_RUNS rather than clamping it", async () => {
    // Clamping would make the payload's `runs` a quiet lie about what happened.
    for (const runs of [0, 6, -1]) {
      expect(
        await rejectionMessage({ url: "https://example.test/", runs }),
      ).toContain('"runs" must be between 1 and 5');
    }
    for (const runs of [1.5, "3"]) {
      expect(
        await rejectionMessage({ url: "https://example.test/", runs }),
      ).toContain('"runs" must be an integer');
    }
  });
});

describe("projectAuditRow", () => {
  it("returns the compact payload and nothing report-shaped", () => {
    const payload = projectAuditRow(
      makeRow({ metrics: makeMetrics(), runs: 3 }),
    );
    expect(payload).toEqual({
      runId: "run-1",
      url: "https://example.test/",
      finalUrl: "https://example.test/home",
      device: "mobile",
      status: "done",
      runs: 3,
      scores: {
        performance: 91,
        accessibility: 88,
        "best-practices": 100,
        seo: 80,
      },
      metrics: {
        "largest-contentful-paint": 2410,
        "cumulative-layout-shift": 0.013,
      },
      batchId: "batch-1",
      fetchTime: "2026-09-06T00:00:00.000Z",
    });
  });

  it("drops unscored categories instead of reporting them as null", () => {
    const payload = projectAuditRow(makeRow());
    expect(Object.keys(payload.scores)).toEqual([
      "performance",
      "accessibility",
      "best-practices",
      "seo",
    ]);
    expect("agentic-browsing" in payload.scores).toBe(false);
  });

  it("keeps scores in canonical category order, whatever order the row is in", () => {
    const payload = projectAuditRow(
      makeRow({
        scores: {
          seo: 70,
          "agentic-browsing": 60,
          performance: 50,
        },
      }),
    );
    expect(Object.keys(payload.scores)).toEqual([
      "performance",
      "seo",
      "agentic-browsing",
    ]);
  });

  it("reports metrics as null when the run measured none", () => {
    expect(projectAuditRow(makeRow({ metrics: null })).metrics).toBeNull();
    const empty = makeMetrics();
    empty["largest-contentful-paint"] = null;
    empty["cumulative-layout-shift"] = null;
    expect(projectAuditRow(makeRow({ metrics: empty })).metrics).toBeNull();
  });

  it("carries a failed run's id and its sanitised reason", () => {
    const payload = projectAuditRow(
      makeRow({
        status: "error",
        finalUrl: null,
        runs: null,
        fetchTime: null,
        scores: {},
        errorMessage: "NO_FCP\u001b[31m\nChrome did not paint",
      }),
    );
    expect(payload.runId).toBe("run-1");
    expect(payload.status).toBe("error");
    // Control characters become spaces and collapse; nothing escapes into the
    // agent's transcript able to redraw it.
    expect(payload.errorMessage).toBe("NO_FCP [31m Chrome did not paint");
    expect(payload.scores).toEqual({});
  });

  it("substitutes a reason when a failed run recorded none", () => {
    const payload = projectAuditRow(
      makeRow({ status: "error", errorMessage: null }),
    );
    expect(payload.errorMessage).toBe("unknown error");
  });

  it("omits errorMessage entirely for a successful run", () => {
    // An empty string there would read as an unexplained failure.
    expect("errorMessage" in projectAuditRow(makeRow())).toBe(false);
  });

  it("clamps an over-long URL and an over-long failure message", () => {
    const payload = projectAuditRow(
      makeRow({
        status: "error",
        url: `https://example.test/${"a".repeat(500)}`,
        errorMessage: "x".repeat(900),
      }),
    );
    expect(payload.url).toHaveLength(300);
    expect(payload.url.endsWith("…")).toBe(true);
    expect(payload.errorMessage).toHaveLength(400);
    expect(payload.errorMessage?.endsWith("…")).toBe(true);
  });
});
