/**
 * `get_history` against a real archive (ROADMAP Phase G).
 *
 * Deliberately NOT a mocked `listHistory`. The interesting properties of this
 * tool are all properties of the persistence path it sits on — that the newest
 * run comes back first, that a trailing slash or a fragment does not hide a run,
 * that a failed run carries no scores — and a stub that returns hand-built rows
 * would assert only that the filter code runs, which is the half that cannot
 * break. So each test runs against a throwaway SQLite DB under a fresh temp
 * directory, exactly as `src/lib/db/persistence.test.ts` does.
 *
 * The handler is called directly. There is no process, no pipe and no client
 * anywhere in this file — that is the whole reason `McpTool` imports no runtime.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDbForTests } from "@/lib/db/client";
import { recordBatch, recordFailedRun, recordRun } from "@/lib/db/persistence";
import type { AuditOptions, AuditResult, FormFactor } from "@/lib/lighthouse/types";
import {
  getHistoryTool,
  type GetHistoryPayload, MAX_HISTORY_LIMIT } from "@/lib/mcp/tools/get-history";
import { McpToolError } from "@/lib/mcp/types";
import type { AuditJob, Batch } from "@/lib/queue/types";

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "accessibility", "best-practices", "seo"],
  runs: 3,
  warmCache: true,
};

function makeBatch(id: string, jobs: AuditJob[]): Batch {
  return {
    id,
    status: "queued",
    device: OPTIONS.formFactor,
    source: "local",
    options: OPTIONS,
    concurrency: 3,
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

function makeJob(id: string, url: string, device: FormFactor = "mobile"): AuditJob {
  return {
    id,
    index: 0,
    url,
    device,
    status: "queued",
    queuedAt: new Date().toISOString(),
  };
}

function makeResult(
  url: string,
  overrides: { finalUrl?: string; device?: FormFactor } = {},
): AuditResult {
  const device = overrides.device ?? "mobile";
  return {
    requestedUrl: url,
    finalUrl: overrides.finalUrl ?? url,
    options: { ...OPTIONS, formFactor: device },
    runs: 3,
    median: {
      scores: {
        performance: 91,
        accessibility: 88,
        "best-practices": 100,
        seo: 80,
      },
      metrics: {
        "largest-contentful-paint": null,
        "cumulative-layout-shift": null,
        "total-blocking-time": null,
        "first-contentful-paint": null,
        "speed-index": null,
        interactive: null,
      },
      opportunities: [],
      bestPractices: [],
      lhr: { requestedUrl: url, fetchTime: "2026-05-26T00:00:00.000Z" },
    },
    perRunScores: [{ performance: 91 }],
    perRunEnvironments: [
      {
        benchmarkIndex: 1500,
        hostUserAgent: "test",
        throttlingMethod: "simulate",
        cpuSlowdownMultiplier: 4,
      },
    ],
    fetchTime: "2026-05-26T00:00:00.000Z",
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

/**
 * Guarantee the next row gets a later `createdAt`.
 *
 * `recordRun` stamps `new Date().toISOString()`, so two runs written inside one
 * millisecond sort by nothing in particular — and "newest first" is the one
 * ordering the archive is required to have. Two milliseconds is enough to make
 * the ordering a fact rather than a coincidence of how long an fs write took.
 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2));
}

/** Record one completed run, in its own batch, and return its id. */
async function archive(
  runId: string,
  url: string,
  overrides: { finalUrl?: string; device?: FormFactor } = {},
): Promise<string> {
  const job = makeJob(runId, url, overrides.device);
  const batch = makeBatch(`batch-${runId}`, [job]);
  recordBatch(batch);
  await recordRun(batch, job, makeResult(url, overrides));
  return runId;
}

/** Call the tool and return its payload. */
async function call(args: Record<string, unknown>): Promise<GetHistoryPayload> {
  const result = await getHistoryTool.handler(args);
  expect(result.isError).toBeUndefined();
  return result.structuredContent as GetHistoryPayload;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-mcp-history-"));
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

describe("get_history", () => {
  it("returns the newest run first", async () => {
    await archive("run-old", "https://a.test/");
    await tick();
    await archive("run-mid", "https://b.test/");
    await tick();
    await archive("run-new", "https://c.test/");

    const payload = await call({});

    expect(payload.runs.map((run) => run.runId)).toEqual([
      "run-new",
      "run-mid",
      "run-old",
    ]);
    expect(payload.returned).toBe(3);
    expect(payload.matched).toBe(3);
    expect(payload.note).toBeUndefined();
  });

  it("projects identity, verdict and scores — and nothing heavier", async () => {
    await archive("run-1", "https://a.test/", { finalUrl: "https://a.test/home" });

    const [run] = (await call({})).runs;

    expect(run).toEqual({
      runId: "run-1",
      url: "https://a.test/",
      finalUrl: "https://a.test/home",
      device: "mobile",
      status: "done",
      source: "local",
      scores: {
        performance: 91,
        accessibility: 88,
        "best-practices": 100,
        seo: 80,
      },
      fetchTime: "2026-05-26T00:00:00.000Z",
      createdAt: run.createdAt,
    });
    // The archive's own columns that must NOT cross: metrics, options, the
    // environment, and anything naming a file on disk.
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain("largest-contentful-paint");
    expect(serialized).not.toContain("throttling");
    expect(serialized).not.toContain("benchmarkIndex");
    expect(serialized).not.toContain(".json");
  });

  it("omits a category the run did not score rather than reporting it as null", async () => {
    await archive("run-1", "https://a.test/");

    const [run] = (await call({})).runs;

    // Lighthouse 13.3's fifth category was never selected, so the row holds a
    // SQL null for it. Null and absent are the same fact to a reader.
    expect("agentic-browsing" in run.scores).toBe(false);
    expect(Object.values(run.scores).every((score) => score !== null)).toBe(true);
  });

  it("collapses finalUrl to null when the page did not redirect", async () => {
    await archive("run-1", "https://a.test/");

    expect((await call({})).runs[0].finalUrl).toBeNull();
  });

  it("matches a URL whose trailing slash or fragment differs from the stored one", async () => {
    await archive("run-1", "https://a.test/");

    for (const url of [
      "https://a.test",
      "https://a.test/",
      "https://a.test/#pricing",
      "a.test",
    ]) {
      const payload = await call({ url });
      expect(payload.matched, url).toBe(1);
      expect(payload.runs[0].runId, url).toBe("run-1");
    }
  });

  it("matches a run by where it ended up, not only by what was requested", async () => {
    await archive("run-1", "https://a.test/", { finalUrl: "https://a.test/home" });

    const payload = await call({ url: "https://a.test/home#top" });

    expect(payload.matched).toBe(1);
    expect(payload.runs[0].runId).toBe("run-1");
  });

  it("does not match a different page", async () => {
    await archive("run-1", "https://a.test/");

    const payload = await call({ url: "https://b.test/" });

    expect(payload.runs).toEqual([]);
    expect(payload.matched).toBe(0);
    expect(payload.note).toContain("audit_url");
  });

  it("windows the list with limit while reporting the pre-cap total", async () => {
    await archive("run-1", "https://a.test/");
    await tick();
    await archive("run-2", "https://a.test/");
    await tick();
    await archive("run-3", "https://a.test/");

    const payload = await call({ url: "https://a.test/", limit: 2 });

    expect(payload.runs.map((run) => run.runId)).toEqual(["run-3", "run-2"]);
    expect(payload.returned).toBe(2);
    // The field that stops a model concluding it has seen the whole archive.
    expect(payload.matched).toBe(3);
  });

  it("filters by device", async () => {
    await archive("run-mobile", "https://a.test/", { device: "mobile" });
    await tick();
    await archive("run-desktop", "https://a.test/", { device: "desktop" });

    expect((await call({ device: "desktop" })).runs.map((r) => r.runId)).toEqual([
      "run-desktop",
    ]);
    expect((await call({ device: "mobile" })).runs.map((r) => r.runId)).toEqual([
      "run-mobile",
    ]);
  });

  it("filters by status, and a failed run carries no scores", async () => {
    await archive("run-ok", "https://a.test/");
    await tick();
    const job: AuditJob = {
      ...makeJob("run-bad", "https://a.test/"),
      status: "error",
      error: { message: "Chrome launch failed" },
    };
    const batch = makeBatch("batch-bad", [job]);
    recordBatch(batch);
    recordFailedRun(batch, job);

    const failures = await call({ status: "error" });
    expect(failures.runs.map((run) => run.runId)).toEqual(["run-bad"]);
    expect(failures.runs[0].scores).toEqual({});
    expect(failures.runs[0].fetchTime).toBeNull();
    // The engine's own message is page/Chrome-derived text and must not cross.
    expect(JSON.stringify(failures.runs[0])).not.toContain("Chrome launch failed");

    expect((await call({ status: "done" })).runs.map((r) => r.runId)).toEqual([
      "run-ok",
    ]);
  });

  it("answers an empty archive with a note, not an error", async () => {
    const payload = await call({});

    expect(payload.runs).toEqual([]);
    expect(payload.matched).toBe(0);
    expect(payload.note).toContain("audit_url");
  });

  it("says the filters are what excluded everything, when they are", async () => {
    await archive("run-1", "https://a.test/", { device: "mobile" });

    const payload = await call({ url: "https://a.test/", device: "desktop" });

    expect(payload.note).toContain("device");
  });

  it("strips control and bidi characters out of a page-chosen final URL", async () => {
    await archive("run-1", "https://a.test/", {
      // U+202E (RTL override) makes the tail read as "exe.png"; NUL is the
      // control half of the same class. Written as escapes so they survive a
      // formatter and are visible in a diff.
      finalUrl: "https://a.test/\u202edaolnwod/gnp.exe\u0000",
    });

    const [run] = (await call({})).runs;

    expect(run.finalUrl).toBe("https://a.test/daolnwod/gnp.exe");
    expect(run.finalUrl).not.toMatch(/[\u0000\u202e]/);
  });

  it("rejects a url that is not an auditable address, without echoing it", async () => {
    const rejected = getHistoryTool.handler({ url: "ftp://a.test/secret-token-value" });

    await expect(rejected).rejects.toBeInstanceOf(McpToolError);
    await expect(rejected).rejects.toThrow(/must be an http\(s\) page address/);
    await expect(rejected).rejects.not.toThrow(/secret-token-value/);
  });

  it("rejects an unknown argument by name, listing the ones that exist", async () => {
    const rejected = getHistoryTool.handler({ page_url: "https://a.test/" });

    await expect(rejected).rejects.toBeInstanceOf(McpToolError);
    await expect(rejected).rejects.toThrow(/"page_url"/);
    await expect(rejected).rejects.toThrow(/"url"/);
  });

  it("rejects a limit outside its bounds rather than silently clamping it", async () => {
    await expect(getHistoryTool.handler({ limit: 0 })).rejects.toThrow(new RegExp(`between 1 and ${MAX_HISTORY_LIMIT}`));
    await expect(getHistoryTool.handler({ limit: 500 })).rejects.toThrow(new RegExp(`between 1 and ${MAX_HISTORY_LIMIT}`));
    await expect(getHistoryTool.handler({ limit: 1.5 })).rejects.toThrow(/integer/);
  });

  it("rejects a device or status outside its enum", async () => {
    await expect(getHistoryTool.handler({ device: "tablet" })).rejects.toThrow(
      /"mobile", "desktop"/,
    );
    await expect(getHistoryTool.handler({ status: "running" })).rejects.toThrow(
      /"done", "error"/,
    );
  });

  it("publishes itself as read-only and closed-world", () => {
    expect(getHistoryTool.name).toBe("get_history");
    expect(getHistoryTool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(getHistoryTool.inputSchema.additionalProperties).toBe(false);
    expect(getHistoryTool.inputSchema.required).toBeUndefined();
  });
});
