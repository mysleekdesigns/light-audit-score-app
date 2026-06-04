/**
 * `GET /api/audits/:id` route tests (PRD §6 Phase 15).
 *
 * Hermetic: each test points `LH_DATA_DIR`/`LH_DB_PATH` at a fresh temp dir,
 * `resetDbForTests()` so the lazy client re-inits against it, seeds rows via the
 * persistence layer ONLY (so the batch is NOT in the in-memory `getAuditQueue()`
 * singleton), then exercises the exported `GET` handler. This proves the DB
 * fallback resolves a completed batch after a queue miss. No Chrome, no network.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/audits/[id]/route";
import { resetDbForTests } from "@/lib/db/client";
import {
  recordBatch,
  recordRun,
  updateBatchStatus,
} from "@/lib/db/persistence";
import type { AuditOptions, AuditResult } from "@/lib/lighthouse/types";
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

function makeJob(id: string, index: number, url: string): AuditJob {
  return {
    id,
    index,
    url,
    device: OPTIONS.formFactor,
    status: "queued",
    queuedAt: new Date().toISOString(),
  };
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-audits-route-"));
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

describe("GET /api/audits/:id", () => {
  it("GET falls back to the DB after a queue miss", async () => {
    const url = "https://ok.test/";
    const job = makeJob("run-ok", 0, url);
    const batch = makeBatch("batch-1", [job]);

    // Seed via the persistence layer ONLY — never touches the in-memory queue.
    recordBatch(batch);
    await recordRun(batch, job, makeResult(url));
    updateBatchStatus(batch.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });

    const res = await GET(new Request("http://test/api/audits/batch-1"), {
      params: Promise.resolve({ id: "batch-1" }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Batch;
    expect(body.id).toBe("batch-1");
    expect(body.status).toBe("completed");
    expect(body.jobs).toHaveLength(batch.jobs.length);
    expect(body.jobs[0].status).toBe("done");
    expect(body.jobs[0].result?.median.scores.performance).toBe(91);
  });

  it("GET returns 404 for an unknown id", async () => {
    const res = await GET(new Request("http://test/api/audits/nope"), {
      params: Promise.resolve({ id: "does-not-exist-123" }),
    });
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("batch_not_found");
  });
});
