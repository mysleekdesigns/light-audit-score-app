/**
 * `GET /api/reports/:runId/trace` route tests (ROADMAP Phase D).
 *
 * Hermetic, and deliberately identical in harness to the sibling
 * `../route.test.ts`: each test points `LH_DATA_DIR`/`LH_DB_PATH` at a fresh temp
 * dir, `resetDbForTests()` so the lazy client re-inits, seeds a persisted run via
 * the persistence layer, then exercises the exported `GET` handler against the
 * on-disk report file. The in-memory queue holds no jobs here, so every
 * disk-miss path lands on the 404 rung of the ladder. No Chrome, no network.
 *
 * The size test is the point of the endpoint, not a nicety: if the projection
 * ever stops projecting, the Trace tab silently goes back to shipping a ~690 KB
 * report to the browser, which is exactly what this route exists to prevent.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/reports/[runId]/trace/route";
import { resetDbForTests } from "@/lib/db/client";
import { reportJsonPath } from "@/lib/db/paths";
import { deleteRun, recordBatch, recordRun } from "@/lib/db/persistence";
import type {
  AuditOptions,
  AuditResult,
  LighthouseResult,
} from "@/lib/lighthouse/types";
import type { AuditJob, Batch } from "@/lib/queue/types";
import type { RunTrace } from "@/lib/reports/types";

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "accessibility", "best-practices", "seo"],
  runs: 3,
  warmCache: true,
};

/** URL of the one request the render-blocking audit flags in {@link makeLhr}. */
const BLOCKING_URL = "https://trace.test/static/blocking.css";
/** Host of the requests attributed to a non-first-party entity in {@link makeLhr}. */
const THIRD_PARTY_HOST = "cdn.third-party.test";

const REQUEST_COUNT = 40;
const FRAME_COUNT = 8;

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

/**
 * A synthetic LHR shaped like a real Lighthouse 13 report: the two audits the
 * projection reads, the two audits that enrich it (render-blocking + entities),
 * and a realistic amount of bulk that it must NOT carry across the wire — the
 * full-page screenshot and a long tail of other audits, which is what actually
 * dominates the ~690 KB average of a stored report here.
 *
 * `network-requests` items carry BOTH the modern `networkRequestTime`/
 * `networkEndTime` spelling and the legacy `startTime`/`endTime` one, exactly as
 * a report straddling those Lighthouse versions would, so the fixture does not
 * quietly pin the extractor to one of them.
 */
function makeLhr(url: string, opts?: { bare?: boolean }): LighthouseResult {
  const lhr: Record<string, unknown> = {
    requestedUrl: url,
    finalUrl: `${url}home`,
    finalDisplayedUrl: `${url}home`,
    fetchTime: "2026-09-06T00:00:00.000Z",
    lighthouseVersion: "13.3.0",
    configSettings: { formFactor: "mobile" },
    categories: { performance: { id: "performance", score: 0.91 } },
    audits: {} as Record<string, unknown>,
  };
  const audits = lhr.audits as Record<string, unknown>;

  // The long tail of audits a real report carries and the projection ignores.
  for (let i = 0; i < 60; i += 1) {
    audits[`filler-audit-${i}`] = {
      id: `filler-audit-${i}`,
      title: `Filler audit ${i}`,
      description: "A description of the kind Lighthouse ships for every audit. ".repeat(6),
      score: 1,
      scoreDisplayMode: "binary",
      details: {
        type: "table",
        items: Array.from({ length: 10 }, (_, j) => ({
          url: `https://trace.test/asset-${i}-${j}.js`,
          wastedBytes: 1024 * j,
          wastedMs: 10 * j,
        })),
      },
    };
  }

  // The single biggest thing in a real report, and never part of the projection.
  audits["full-page-screenshot"] = {
    id: "full-page-screenshot",
    details: {
      type: "full-page-screenshot",
      screenshot: {
        width: 412,
        height: 8000,
        data: `data:image/webp;base64,${"A".repeat(200_000)}`,
      },
    },
  };

  if (opts?.bare) {
    // A legacy row: a valid report that predates (or simply omits) both audits.
    return lhr as LighthouseResult;
  }

  audits["network-requests"] = {
    id: "network-requests",
    details: {
      type: "table",
      items: Array.from({ length: REQUEST_COUNT }, (_, i) => {
        const thirdParty = i % 4 === 0;
        const host = thirdParty ? THIRD_PARTY_HOST : "trace.test";
        const requestUrl =
          i === 1 ? BLOCKING_URL : `https://${host}/static/asset-${i}.js`;
        const start = i * 10;
        const end = start + 25;
        return {
          url: requestUrl,
          protocol: "h2",
          // Modern spelling.
          networkRequestTime: start,
          networkEndTime: end,
          // Legacy spelling, same values.
          startTime: start,
          endTime: end,
          finished: true,
          transferSize: 1000 + i * 10,
          resourceSize: 2000 + i * 10,
          statusCode: 200,
          mimeType: i === 1 ? "text/css" : "application/javascript",
          resourceType: i === 1 ? "Stylesheet" : "Script",
          priority: "High",
          entity: thirdParty ? "Third Party CDN" : "trace.test",
          sessionTargetType: "page",
        };
      }),
    },
  };

  audits["screenshot-thumbnails"] = {
    id: "screenshot-thumbnails",
    details: {
      type: "filmstrip",
      scale: 600,
      items: Array.from({ length: FRAME_COUNT }, (_, i) => ({
        timing: (i + 1) * 300,
        timestamp: 1_000_000 + i * 300_000,
        data: `data:image/jpeg;base64,${"B".repeat(512)}`,
      })),
    },
  };

  audits["render-blocking-resources"] = {
    id: "render-blocking-resources",
    score: 0.5,
    details: {
      type: "opportunity",
      items: [{ url: BLOCKING_URL, totalBytes: 4096, wastedMs: 320 }],
    },
  };

  audits["largest-contentful-paint"] = {
    id: "largest-contentful-paint",
    numericValue: 1500,
    numericUnit: "millisecond",
    score: 0.8,
  };

  lhr.entities = [
    { name: "trace.test", origins: ["https://trace.test"], isFirstParty: true },
    {
      name: "Third Party CDN",
      origins: [`https://${THIRD_PARTY_HOST}`],
      isFirstParty: false,
    },
  ];

  return lhr as LighthouseResult;
}

function makeResult(url: string, lhr: LighthouseResult): AuditResult {
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
      lhr,
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

/** Seed one persisted run whose stored report is `lhr`, and return its run id. */
async function seedRun(runId: string, lhr: LighthouseResult): Promise<string> {
  const url = "https://trace.test/";
  const job = makeJob(runId, 0, url);
  const batch = makeBatch(`batch-${runId}`, [job]);
  recordBatch(batch);
  await recordRun(batch, job, makeResult(url, lhr));
  return runId;
}

/** Invoke GET with an async params bag, matching the Next 16 handler signature. */
function callGet(runId: string): Promise<Response> {
  const url = `http://localhost/api/reports/${runId}/trace`;
  return GET(new Request(url), { params: Promise.resolve({ runId }) });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-trace-route-"));
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

describe("GET /api/reports/:runId/trace", () => {
  it("projects a persisted run's stored report into a well-formed RunTrace", async () => {
    await seedRun("run-trace", makeLhr("https://trace.test/"));

    const res = await callGet("run-trace");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const trace = (await res.json()) as RunTrace;
    expect(trace.runId).toBe("run-trace");
    expect(trace.finalUrl).toBe("https://trace.test/home");

    // Waterfall: one row per recorded request, in the LHR's own order.
    expect(trace.waterfall.unavailable).toBe(false);
    expect(trace.waterfall.requests).toHaveLength(REQUEST_COUNT);
    expect(trace.waterfall.requests.map((r) => r.index)).toEqual(
      Array.from({ length: REQUEST_COUNT }, (_, i) => i),
    );

    // Every row is fully populated per the frozen contract — no `undefined`
    // holes, which is what the "nullable-or-empty, never absent" rule buys the UI.
    for (const request of trace.waterfall.requests) {
      expect(typeof request.url).toBe("string");
      expect(typeof request.path).toBe("string");
      expect(typeof request.host).toBe("string");
      expect(typeof request.resourceType).toBe("string");
      expect(typeof request.mimeType).toBe("string");
      expect(typeof request.protocol).toBe("string");
      expect(typeof request.priority).toBe("string");
      expect(typeof request.entity).toBe("string");
      expect(typeof request.cache).toBe("string");
      expect(typeof request.thirdParty).toBe("boolean");
      expect(typeof request.renderBlocking).toBe("boolean");
      expect(typeof request.finished).toBe("boolean");
    }

    // Totals are self-consistent with the rows they summarise.
    const sum = (pick: (r: RunTrace["waterfall"]["requests"][number]) => number | null) =>
      trace.waterfall.requests.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
    expect(trace.waterfall.totalTransferSize).toBe(sum((r) => r.transferSize));
    expect(trace.waterfall.totalResourceSize).toBe(sum((r) => r.resourceSize));
    expect(trace.waterfall.thirdPartyCount).toBe(
      trace.waterfall.requests.filter((r) => r.thirdParty).length,
    );

    // The enrichment the plan asks for actually lands end-to-end: the CDN's
    // requests are attributed to a non-first-party entity, and exactly the URL
    // the render-blocking audit named is marked.
    expect(trace.waterfall.thirdPartyCount).toBeGreaterThan(0);
    expect(
      trace.waterfall.requests.filter((r) => r.renderBlocking).map((r) => r.url),
    ).toEqual([BLOCKING_URL]);
    if (trace.waterfall.timelineMs !== null) {
      const ends = trace.waterfall.requests
        .map((r) => r.endTime)
        .filter((t): t is number => t !== null);
      expect(trace.waterfall.timelineMs).toBe(Math.max(...ends));
    }

    // Filmstrip: every captured frame, inline, in capture order.
    expect(trace.filmstrip.unavailable).toBe(false);
    expect(trace.filmstrip.frames).toHaveLength(FRAME_COUNT);
    for (const frame of trace.filmstrip.frames) {
      expect(frame.data.startsWith("data:image/")).toBe(true);
      expect(typeof frame.timingMs).toBe("number");
    }
    // Exactly one frame is the LCP frame, at the LCP the report recorded.
    expect(trace.filmstrip.lcpMs).toBe(1500);
    expect(trace.filmstrip.frames.filter((f) => f.isLcp)).toHaveLength(1);
  });

  it("returns a projection materially smaller than the stored report", async () => {
    await seedRun("run-size", makeLhr("https://trace.test/"));

    const res = await callGet("run-size");
    expect(res.status).toBe(200);
    const traceBytes = Buffer.byteLength(await res.text(), "utf8");
    const reportBytes = (await fs.stat(reportJsonPath("run-size"))).size;

    // The endpoint's entire reason to exist. A generous bound so the assertion
    // tracks "this projects" rather than a fixture's exact byte count.
    expect(traceBytes).toBeLessThan(reportBytes / 3);
  });

  it("degrades to an empty trace for a legacy report missing both audits", async () => {
    await seedRun("run-legacy", makeLhr("https://trace.test/", { bare: true }));

    const res = await callGet("run-legacy");
    expect(res.status).toBe(200);
    const trace = (await res.json()) as RunTrace;
    // `unavailable` is how the UI tells "this report predates the feature" from
    // "this page genuinely made zero requests" — it must not be a bare empty list.
    expect(trace.waterfall.unavailable).toBe(true);
    expect(trace.waterfall.requests).toEqual([]);
    expect(trace.filmstrip.unavailable).toBe(true);
    expect(trace.filmstrip.frames).toEqual([]);
  });

  it("404s for an unknown run with no persisted file and no in-memory result", async () => {
    const res = await callGet("nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("report_not_found");
  });

  it("falls through to a 404 when the stored report file is gone from disk", async () => {
    await seedRun("run-missing", makeLhr("https://trace.test/"));
    // The row still points at a report; the file behind it does not exist. The
    // read must degrade to the in-memory fallback (empty here), not 500.
    await fs.rm(reportJsonPath("run-missing"));

    const res = await callGet("run-missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("report_not_found");
  });

  it("500s without throwing when the stored report file is not valid JSON", async () => {
    await seedRun("run-corrupt", makeLhr("https://trace.test/"));
    await fs.writeFile(reportJsonPath("run-corrupt"), "{ this is not json", "utf8");

    const res = await callGet("run-corrupt");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("report_unreadable");
  });

  it("reflects no request data into its error bodies", async () => {
    // `.claude/rules/security.md`: the run id is caller-supplied, so it must not
    // be echoed back into a response body.
    const runId = "reflect-me-9f3c";
    const notFoundBody = await (await callGet(runId)).text();
    expect(notFoundBody).not.toContain(runId);

    await seedRun("run-reflect", makeLhr("https://trace.test/"));
    await fs.writeFile(reportJsonPath("run-reflect"), "nope", "utf8");
    const serverErrorBody = await (await callGet("run-reflect")).text();
    expect(serverErrorBody).not.toContain("run-reflect");
  });
  /**
   * Hardening added after the Phase D security review (its L1/L2).
   */
  describe("hardening", () => {
    it("serves a repeat read from the memo instead of re-reading the file", async () => {
      await seedRun("run-cached", makeLhr("https://trace.test/"));
      const first = (await (await callGet("run-cached")).json()) as RunTrace;

      // Corrupt the file on disk but leave the DB row. A route that re-read per
      // request would now 500; the memo answers identically, because a finished
      // run's report is immutable and that is the premise of caching it.
      await fs.writeFile(reportJsonPath("run-cached"), "{ broken", "utf8");

      const res = await callGet("run-cached");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(first);
    });

    it("stops serving a cached trace once the run is deleted", async () => {
      // The privacy half of the memo. Deleting a run (or clearing history) has
      // to actually remove it — an in-process cache is exactly how a deleted
      // run's URLs would keep being served. ROADMAP Phase C's M2 is the
      // precedent for taking this seriously rather than assuming it.
      await seedRun("run-evicted", makeLhr("https://trace.test/"));
      expect((await callGet("run-evicted")).status).toBe(200);

      await deleteRun("run-evicted");

      const res = await callGet("run-evicted");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("report_not_found");
    });

    it("refuses a report far larger than one can legitimately be", async () => {
      await seedRun("run-huge", makeLhr("https://trace.test/"));
      // 33 MB of valid JSON — over the 32 MB ceiling, and never read into memory.
      const padding = "x".repeat(33 * 1024 * 1024);
      await fs.writeFile(
        reportJsonPath("run-huge"),
        JSON.stringify({ audits: {}, padding }),
        "utf8",
      );

      const res = await callGet("run-huge");
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("report_unreadable");
      expect(await res.text().catch(() => "")).not.toContain("run-huge");
    });

    it("marks the response no-store, cache hit and miss alike", async () => {
      // The payload embeds screenshots of the audited page, which ROADMAP Phase
      // B made possible to be a logged-in or staging one.
      await seedRun("run-nostore", makeLhr("https://trace.test/"));

      const miss = await callGet("run-nostore");
      expect(miss.headers.get("cache-control")).toBe("no-store");
      expect(miss.headers.get("x-content-type-options")).toBe("nosniff");

      const hit = await callGet("run-nostore");
      expect(hit.headers.get("cache-control")).toBe("no-store");
    });

    it("echoes the stored run id, not the caller's string", async () => {
      await seedRun("run-echo", makeLhr("https://trace.test/"));
      const body = (await (await callGet("run-echo")).json()) as RunTrace;
      expect(body.runId).toBe("run-echo");
    });
  });
});
