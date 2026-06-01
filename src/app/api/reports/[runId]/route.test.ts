/**
 * `GET /api/reports/:runId` route tests (PRD §6 Phase 4).
 *
 * Hermetic: each test points `LH_DATA_DIR`/`LH_DB_PATH` at a fresh temp dir,
 * `resetDbForTests()` so the lazy client re-inits, seeds a persisted run via the
 * persistence layer, then exercises the exported `GET` handler against the
 * on-disk report files. The in-memory queue holds no jobs in this hermetic
 * setup, so an unknown/never-persisted run falls through to a 404. No Chrome,
 * no network.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/reports/[runId]/route";
import { resetDbForTests } from "@/lib/db/client";
import { recordBatch, recordRun } from "@/lib/db/persistence";
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

/** Invoke GET with an async params bag, matching the Next 16 handler signature. */
function callGet(runId: string, query = ""): Promise<Response> {
  const url = `http://localhost/api/reports/${runId}${query}`;
  return GET(new Request(url), { params: Promise.resolve({ runId }) });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-report-route-"));
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

describe("GET /api/reports/:runId", () => {
  it("serves the persisted raw LHR JSON from disk", async () => {
    const job = makeJob("run-json", 0, "https://json.test/");
    const batch = makeBatch("batch-1", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeResult("https://json.test/"));

    const res = await callGet("run-json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const lhr = (await res.json()) as { requestedUrl: string };
    expect(lhr.requestedUrl).toBe("https://json.test/");
  });

  it("404s for an unknown run with no persisted file and no in-memory result", async () => {
    const res = await callGet("nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("report_not_found");
  });

  it("404s when ?format=html is requested for an unknown run", async () => {
    const res = await callGet("nope", "?format=html");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("report_not_found");
  });

  it("serves a persisted HTML report from disk when one exists", async () => {
    // Seed a persisted run, then write an HTML report file at the path the
    // persistence layer derives for this run id, and flag it in the row so
    // getRunReport() returns a non-null htmlPath.
    const job = makeJob("run-html", 0, "https://html.test/");
    const batch = makeBatch("batch-html", [job]);
    recordBatch(batch);
    await recordRun(batch, job, makeResult("https://html.test/"));

    const { reportHtmlPath, reportHtmlFilename } = await import("@/lib/db/paths");
    const { getDb } = await import("@/lib/db/client");
    const { runs } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    await fs.writeFile(reportHtmlPath(job.id), "<!doctype html><h1>report</h1>", "utf8");
    getDb()
      .update(runs)
      .set({ reportHtml: reportHtmlFilename(job.id) })
      .where(eq(runs.id, job.id))
      .run();

    const res = await callGet("run-html", "?format=html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>report</h1>");
  });
});
