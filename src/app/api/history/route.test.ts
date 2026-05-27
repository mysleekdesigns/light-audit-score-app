/**
 * `GET /api/history` route tests (PRD §6 Phase 4).
 *
 * Hermetic: each test points `LH_DATA_DIR`/`LH_DB_PATH` at a fresh temp dir,
 * `resetDbForTests()` so the lazy client re-inits against it, seeds rows via the
 * persistence layer, then exercises the exported `GET`/`POST` handlers. No
 * Chrome, no network.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/history/route";
import { resetDbForTests } from "@/lib/db/client";
import {
  recordBatch,
  recordFailedRun,
  recordRun,
  type HistoryRow,
} from "@/lib/db/persistence";
import type { AuditOptions, AuditResult } from "@/lib/lighthouse/types";
import type { AuditJob, Batch } from "@/lib/queue/types";

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "accessibility", "best-practices", "seo"],
  runs: 3,
};

function makeBatch(id: string, jobs: AuditJob[]): Batch {
  return {
    id,
    status: "queued",
    options: OPTIONS,
    concurrency: 3,
    jobs,
    counts: { total: jobs.length, queued: jobs.length, running: 0, done: 0, error: 0 },
    createdAt: new Date().toISOString(),
  };
}

function makeJob(id: string, index: number, url: string): AuditJob {
  return { id, index, url, status: "queued", queuedAt: new Date().toISOString() };
}

function makeResult(url: string): AuditResult {
  return {
    requestedUrl: url,
    finalUrl: `${url}home`,
    options: OPTIONS,
    runs: 3,
    median: {
      scores: { performance: 91, accessibility: 88, "best-practices": 100, seo: 80 },
      metrics: {
        "largest-contentful-paint": null,
        "cumulative-layout-shift": null,
        "total-blocking-time": null,
        "first-contentful-paint": null,
        "speed-index": null,
        interactive: null,
      },
      opportunities: [],
      lhr: { requestedUrl: url, fetchTime: "2026-05-26T00:00:00.000Z" },
    },
    perRunScores: [{ performance: 91 }],
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-history-route-"));
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

describe("GET /api/history", () => {
  it("returns an empty runs array when nothing is persisted", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: HistoryRow[] };
    expect(body.runs).toEqual([]);
  });

  it("returns persisted runs newest-first", async () => {
    const ok = makeJob("run-ok", 0, "https://ok.test/");
    const bad: AuditJob = {
      ...makeJob("run-bad", 1, "https://bad.test/"),
      status: "error",
      error: { message: "Chrome launch failed" },
    };
    const batch = makeBatch("batch-1", [ok, bad]);

    recordBatch(batch);
    await recordRun(batch, ok, makeResult("https://ok.test/"));
    await new Promise((r) => setTimeout(r, 5));
    recordFailedRun(batch, bad);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: HistoryRow[] };
    expect(body.runs).toHaveLength(2);
    // Newest first: the failed run was recorded last.
    expect(body.runs[0].id).toBe("run-bad");
    expect(body.runs[0].status).toBe("error");
    expect(body.runs[0].errorMessage).toBe("Chrome launch failed");
    expect(body.runs[1].id).toBe("run-ok");
    expect(body.runs[1].status).toBe("done");
    expect(body.runs[1].scores.performance).toBe(91);
    expect(body.runs[1].hasJsonReport).toBe(true);
  });
});

describe("POST /api/history", () => {
  it("rejects unsupported methods with a structured 405", async () => {
    const res = await POST();
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });
});
