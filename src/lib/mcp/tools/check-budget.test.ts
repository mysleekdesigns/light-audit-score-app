/**
 * `check_budget` unit tests (ROADMAP Phase G).
 *
 * Driven against a **real** throwaway SQLite database rather than a stubbed
 * `listHistory`: point `LH_DATA_DIR`/`LH_DB_PATH` at a fresh temp directory,
 * `resetDbForTests()`, then seed with the same `recordBatch`/`recordRun` the
 * queue itself calls. The harness is lifted from `src/lib/db/persistence.test.ts`
 * on purpose — this tool's job is to find and judge a PERSISTED row, and a fake
 * history would test the half that cannot be wrong while skipping the half that
 * can (does a `null` score column read back as "unscored" or as zero? does a
 * trailing slash split the lookup?).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDbForTests } from "@/lib/db/client";
import {
  recordBatch,
  recordFailedRun,
  recordRun,
} from "@/lib/db/persistence";
import type {
  AuditOptions,
  AuditResult,
  CategoryScores,
} from "@/lib/lighthouse/types";
import {
  checkBudgetTool,
  type CheckBudgetPayload,
} from "@/lib/mcp/tools/check-budget";
import { McpToolError, type McpToolResult } from "@/lib/mcp/types";
import type { AuditJob, Batch } from "@/lib/queue/types";

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: [
    "performance",
    "accessibility",
    "best-practices",
    "seo",
    "agentic-browsing",
  ],
  runs: 1,
  warmCache: true,
};

/** Every category scored, so a blanket bar can pass without tripping on a null. */
const FULL_SCORES: CategoryScores = {
  performance: 91,
  accessibility: 88,
  "best-practices": 100,
  seo: 80,
  "agentic-browsing": 75,
};

function makeJob(id: string, index: number, url: string): AuditJob {
  return {
    id,
    index,
    url,
    device: "mobile",
    status: "queued",
    queuedAt: new Date().toISOString(),
  };
}

function makeBatch(id: string, jobs: AuditJob[]): Batch {
  return {
    id,
    status: "queued",
    device: "mobile",
    source: "local",
    options: OPTIONS,
    concurrency: 1,
    jobs,
    counts: {
      total: jobs.length,
      queued: jobs.length,
      running: 0,
      done: 0,
      error: 0,
      cancelled: 0,
    },
    createdAt: new Date().toISOString(),
  };
}

function makeResult(url: string, scores: CategoryScores): AuditResult {
  return {
    requestedUrl: url,
    finalUrl: `${url}home`,
    options: OPTIONS,
    runs: 1,
    median: {
      scores,
      metrics: {
        "largest-contentful-paint": {
          numericValue: 2410,
          displayValue: "2.4 s",
          score: 0.62,
        },
        "cumulative-layout-shift": null,
        "total-blocking-time": null,
        "first-contentful-paint": null,
        "speed-index": null,
        interactive: null,
      },
      opportunities: [],
      bestPractices: [],
      lhr: { requestedUrl: url, fetchTime: "2026-09-06T00:00:00.000Z" },
    },
    perRunScores: [scores],
    perRunEnvironments: [
      {
        benchmarkIndex: 1500,
        hostUserAgent: "test",
        throttlingMethod: "simulate",
        cpuSlowdownMultiplier: 4,
      },
    ],
    fetchTime: "2026-09-06T00:00:00.000Z",
    lighthouseVersion: "13.3.0",
    runWarnings: [],
    environment: {
      benchmarkIndex: 1500,
      hostUserAgent: "test",
      throttlingMethod: "simulate",
      cpuSlowdownMultiplier: 4,
    },
  };
}

/** Archive one successful run, exactly the way the queue does. */
async function seedRun(
  runId: string,
  url: string,
  scores: CategoryScores = FULL_SCORES,
): Promise<void> {
  const job = makeJob(runId, 0, url);
  const batch = makeBatch(`batch-${runId}`, [job]);
  recordBatch(batch);
  await recordRun(batch, job, makeResult(url, scores));
}

/** Archive one failed run, with the reason the engine reported. */
function seedFailedRun(runId: string, url: string, message: string): void {
  const job: AuditJob = {
    ...makeJob(runId, 0, url),
    status: "error",
    error: { message },
  };
  const batch = makeBatch(`batch-${runId}`, [job]);
  recordBatch(batch);
  recordFailedRun(batch, job);
}

/** Call the tool and read its payload back as the typed thing it is. */
async function judge(
  args: Record<string, unknown>,
): Promise<{ result: McpToolResult; payload: CheckBudgetPayload }> {
  const result = await checkBudgetTool.handler(args);
  return {
    result,
    payload: result.structuredContent as unknown as CheckBudgetPayload,
  };
}

/** The handler's rejection message, or a failure if it did not reject. */
async function rejectionMessage(args: Record<string, unknown>): Promise<string> {
  try {
    await checkBudgetTool.handler(args);
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolError);
    return (error as McpToolError).message;
  }
  throw new Error("expected the handler to reject");
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-mcp-budget-"));
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

describe("check_budget — published contract", () => {
  it("names itself and its arguments the way tools/index expects", () => {
    expect(checkBudgetTool.name).toBe("check_budget");
    expect(checkBudgetTool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(checkBudgetTool.inputSchema.properties)).toEqual([
      "runId",
      "url",
      "budget",
      "budgets",
    ]);
    // Nothing is `required`: the requirement is "exactly one of runId/url plus
    // at least one bar", which JSON Schema cannot express and the handler does.
    expect(checkBudgetTool.inputSchema.required).toBeUndefined();
  });

  it("declares itself read-only and local", () => {
    expect(checkBudgetTool.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it("warns the model that precedence is inverted, and that it never audits", () => {
    // A model that assumes the usual "explicit flag beats config" would read a
    // passing build as a failing one, so this has to be said out loud.
    expect(checkBudgetTool.description).toMatch(/INVERTED/);
    expect(checkBudgetTool.description).toMatch(/FLOOR applied to\s+every/i);
    expect(checkBudgetTool.description).toMatch(/never audits/i);
    expect(checkBudgetTool.description).toMatch(/ok: false, not a tool error/);
  });
});

describe("check_budget — argument validation", () => {
  it("names the invented argument AND the ones that exist", async () => {
    const message = await rejectionMessage({ run_id: "x", budget: 90 });
    expect(message).toContain('"run_id"');
    expect(message).toContain('"runId"');
    expect(message).toContain('"url"');
    expect(message).toContain('"budget"');
    expect(message).toContain('"budgets"');
  });

  it("requires exactly one of runId and url", async () => {
    const missing = await rejectionMessage({ budget: 90 });
    expect(missing).toContain('"runId"');
    expect(missing).toContain('"url"');

    const both = await rejectionMessage({
      runId: "run-1",
      url: "https://a.test/",
      budget: 90,
    });
    expect(both).toContain("not both");
  });

  it("requires at least one bar", async () => {
    expect(await rejectionMessage({ runId: "run-1" })).toContain(
      "nothing to check",
    );
  });

  it("refuses an empty budgets object rather than passing it trivially", async () => {
    // Judging nothing and answering `ok: true` would be a false green — the
    // exact failure mode the budget rules exist to prevent.
    const message = await rejectionMessage({ runId: "run-1", budgets: {} });
    expect(message).toContain("No bars to check against");
  });

  it("passes BudgetError's own advice through for a misspelt category", async () => {
    const message = await rejectionMessage({
      runId: "run-1",
      budgets: { perfomance: 90 },
    });
    expect(message).toContain("Unknown budget category");
    expect(message).toContain("performance");
    expect(message).toContain("agentic-browsing");
  });

  it("rejects bars outside 0–100 and values that are not numbers", async () => {
    expect(await rejectionMessage({ runId: "run-1", budget: 101 })).toContain(
      '"budget" must be between 0 and 100',
    );
    expect(
      await rejectionMessage({ runId: "run-1", budgets: { seo: "90" } }),
    ).toContain('"budgets" values must be numbers');
    expect(
      await rejectionMessage({ runId: "run-1", budgets: { seo: 900 } }),
    ).toContain('Budget for "seo" must be a number from 0 to 100');
  });

  it("rejects a url that is not an auditable address", async () => {
    expect(
      await rejectionMessage({ url: "not a url at all", budget: 90 }),
    ).toContain("http or https");
  });
});

describe("check_budget — finding the run", () => {
  it("errors on an unknown run id, and says where ids come from", async () => {
    await seedRun("run-1", "https://a.test/");
    const message = await rejectionMessage({ runId: "run-nope", budget: 50 });
    expect(message).toContain("No archived run has that id");
    expect(message).toContain("get_history");
  });

  it("errors on a URL with no archived runs, and says to audit it first", async () => {
    const message = await rejectionMessage({
      url: "https://never-audited.test/",
      budget: 50,
    });
    expect(message).toContain("no archived runs");
    expect(message).toContain("audit_url");
  });

  it("matches a URL regardless of a bare trailing slash", async () => {
    await seedRun("run-1", "https://a.test/");
    const { payload } = await judge({ url: "https://a.test", budget: 50 });
    expect(payload.runId).toBe("run-1");
  });

  it("matches the URL a run redirected to", async () => {
    // `makeResult` stores finalUrl as `<url>home`, so this is the redirect case.
    await seedRun("run-1", "https://a.test/");
    const { payload } = await judge({
      url: "https://a.test/home",
      budget: 50,
    });
    expect(payload.runId).toBe("run-1");
  });

  it("judges the most recent run for a URL", async () => {
    await seedRun("run-old", "https://a.test/", { ...FULL_SCORES, seo: 10 });
    // `createdAt` has millisecond resolution, so the two writes are separated
    // explicitly rather than left to the speed of the machine.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedRun("run-new", "https://a.test/", { ...FULL_SCORES, seo: 99 });

    const { payload } = await judge({ url: "https://a.test/", budget: 90 });
    expect(payload.runId).toBe("run-new");
    expect(payload.scores.seo).toBe(99);
  });
});

describe("check_budget — the verdict", () => {
  it("passes a run that clears every bar", async () => {
    await seedRun("run-1", "https://a.test/");
    const { result, payload } = await judge({ runId: "run-1", budget: 70 });

    expect(payload.ok).toBe(true);
    expect(payload.violations).toEqual([]);
    expect(payload.runId).toBe("run-1");
    expect(payload.url).toBe("https://a.test/");
    expect(payload.device).toBe("mobile");
    expect(payload.status).toBe("done");
    expect(payload.scores).toEqual(FULL_SCORES);
    expect(payload.summary).toBe("Passed: all 5 budgeted categories met their bar.");
    expect(result.isError).toBeUndefined();
  });

  it("fails a run under the bar WITHOUT flagging the call as an error", async () => {
    await seedRun("run-1", "https://a.test/");
    const { result, payload } = await judge({ runId: "run-1", budget: 90 });

    expect(payload.ok).toBe(false);
    // The bar was checked and the answer is "no". Flagging that as a tool error
    // would tell the agent to retry the call instead of fixing the page.
    expect(result.isError).toBeUndefined();
    expect(payload.violations).toEqual([
      { category: "accessibility", score: 88, budget: 90, reason: "below" },
      { category: "seo", score: 80, budget: 90, reason: "below" },
      {
        category: "agentic-browsing",
        score: 75,
        budget: 90,
        reason: "below",
      },
    ]);
    expect(payload.summary).toContain("Failed: 3 of 5 budgeted categories");
    expect(payload.summary).toContain("accessibility 88 < 90");
  });

  it("serialises the same payload into both halves of the result", async () => {
    await seedRun("run-1", "https://a.test/");
    const { result, payload } = await judge({ runId: "run-1", budget: 70 });
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });

  it("treats the flag as a floor and the per-category map as its exceptions", async () => {
    await seedRun("run-1", "https://a.test/");
    const { payload } = await judge({
      runId: "run-1",
      budget: 90,
      budgets: { accessibility: 80, seo: 70, "agentic-browsing": 70 },
    });

    // Inverted precedence: the config lowers three bars the blanket flag set,
    // rather than the flag flattening the three lines the caller wrote.
    expect(payload.budgets).toEqual({
      performance: 90,
      accessibility: 80,
      "best-practices": 90,
      seo: 70,
      "agentic-browsing": 70,
    });
    expect(payload.ok).toBe(true);
  });

  it("returns the bars in canonical category order, not config order", async () => {
    await seedRun("run-1", "https://a.test/");
    const { payload } = await judge({
      runId: "run-1",
      budgets: { seo: 50, performance: 50, "agentic-browsing": 50 },
    });
    expect(Object.keys(payload.budgets)).toEqual([
      "performance",
      "seo",
      "agentic-browsing",
    ]);
  });

  it("fails a budgeted category the run never scored", async () => {
    // A `null` score column is "no data", never a zero — so this is `unscored`,
    // not a `below` violation with a fabricated 0.
    await seedRun("run-1", "https://a.test/", {
      ...FULL_SCORES,
      "agentic-browsing": null,
    });
    const { payload } = await judge({ runId: "run-1", budget: 50 });

    expect(payload.ok).toBe(false);
    expect(payload.violations).toEqual([
      {
        category: "agentic-browsing",
        score: null,
        budget: 50,
        reason: "unscored",
      },
    ]);
    expect(payload.summary).toContain("agentic-browsing not scored (bar 50)");
    // Absent from `scores` too: five nulls would be five keys saying nothing.
    expect("agentic-browsing" in payload.scores).toBe(false);
  });

  it("never fails a category that carries no bar", async () => {
    await seedRun("run-1", "https://a.test/", {
      ...FULL_SCORES,
      performance: 3,
    });
    const { payload } = await judge({ runId: "run-1", budgets: { seo: 50 } });
    expect(payload.ok).toBe(true);
    // Still reported, just not judged.
    expect(payload.scores.performance).toBe(3);
  });

  it("fails a run that errored, and sanitises the reason it carries", async () => {
    seedFailedRun(
      "run-1",
      "https://a.test/",
      "NO_FCP\u001b[31m\nChrome did not paint",
    );
    const { result, payload } = await judge({ runId: "run-1", budget: 50 });

    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("error");
    expect(result.isError).toBeUndefined();
    // Nothing was measured, so every budgeted category is a miss.
    expect(payload.violations).toHaveLength(5);
    expect(payload.violations.every((v) => v.reason === "error")).toBe(true);
    expect(payload.violations.every((v) => v.score === null)).toBe(true);
    expect(payload.scores).toEqual({});
    expect(payload.summary).toContain("the run itself errored");
    // Control characters became spaces before the text reached the transcript.
    expect(payload.summary).toContain("NO_FCP [31m Chrome did not paint");
    expect(payload.summary).not.toContain("\u001b");
  });
});
