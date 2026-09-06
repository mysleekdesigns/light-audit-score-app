/**
 * `GET /api/reports/:runId/diff?baseline=<id>` route tests (ROADMAP Phase E).
 *
 * Hermetic, and deliberately identical in harness to its siblings
 * (`../trace/route.test.ts`, `../route.test.ts`): each test points
 * `LH_DATA_DIR`/`LH_DB_PATH` at a fresh temp dir, `resetDbForTests()` so the lazy
 * client re-inits, seeds persisted runs through the persistence layer, then
 * exercises the exported `GET` handler against the on-disk report files. The
 * in-memory queue holds no jobs here, so every disk-miss path lands on the 404
 * rung of the ladder. No Chrome, no network.
 *
 * The size assertion is the point of the endpoint, not a nicety: a diff reads
 * TWO stored reports (~690 KB each in this repo), and if the projection ever
 * stops projecting, `/compare` silently goes back to shipping ~1.4 MB to the
 * browser — exactly what this route exists to prevent.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/reports/[runId]/diff/route";
import { resetDbForTests } from "@/lib/db/client";
import { reportJsonPath } from "@/lib/db/paths";
import { deleteRun, recordBatch, recordRun } from "@/lib/db/persistence";
import type {
  AuditOptions,
  AuditResult,
  LighthouseResult,
} from "@/lib/lighthouse/types";
import type { AuditJob, Batch } from "@/lib/queue/types";
import type { RunDiff } from "@/lib/reports/diff-types";

let tmpDir: string;

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "accessibility", "best-practices", "seo"],
  runs: 3,
  warmCache: true,
};

const SITE = "https://diff.test/";

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
 * A synthetic LHR shaped like a real Lighthouse 13 report, parameterised on the
 * handful of things the diff is supposed to notice.
 *
 * It carries the bulk a real report carries and the projection must NOT ship —
 * a full-page screenshot and a long tail of audits — because the size assertion
 * below is only meaningful against a report that is actually big.
 */
function makeLhr(opts: {
  seoScore: number;
  /** Score of the one audit the tests move. */
  metaScore: number;
  /** Requests the page made, as `[url, transferSize]`. */
  requests: [string, number][];
  /** Estimated savings of the one opportunity, ms. */
  savingsMs: number;
}): LighthouseResult {
  const lhr: Record<string, unknown> = {
    requestedUrl: SITE,
    finalUrl: `${SITE}home`,
    finalDisplayedUrl: `${SITE}home`,
    fetchTime: "2026-09-06T00:00:00.000Z",
    lighthouseVersion: "13.4.1",
    configSettings: { formFactor: "mobile" },
    categories: {
      performance: { id: "performance", score: 0.9, auditRefs: [] },
      seo: {
        id: "seo",
        score: opts.seoScore,
        auditRefs: [
          { id: "meta-description", weight: 10, group: "seo-content" },
          { id: "document-title", weight: 10, group: "seo-content" },
        ],
      },
    },
    audits: {} as Record<string, unknown>,
  };
  const audits = lhr.audits as Record<string, unknown>;

  // The long tail a real report carries; identical on both sides, so every one
  // of these must classify as unchanged and be counted, not listed.
  for (let i = 0; i < 60; i += 1) {
    audits[`filler-audit-${i}`] = {
      id: `filler-audit-${i}`,
      title: `Filler audit ${i}`,
      description: "A description of the kind Lighthouse ships for every audit. ".repeat(6),
      score: 1,
      scoreDisplayMode: "binary",
    };
  }

  // The single biggest thing in a real report, and never part of a projection.
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

  audits["meta-description"] = {
    id: "meta-description",
    title: "Document has a meta description",
    description: "Meta descriptions may be included in search results.",
    score: opts.metaScore,
    scoreDisplayMode: "binary",
  };
  audits["document-title"] = {
    id: "document-title",
    title: "Document has a <title> element",
    description: "The title gives screen reader users an overview of the page.",
    score: 1,
    scoreDisplayMode: "binary",
  };

  audits["unused-javascript"] = {
    id: "unused-javascript",
    title: "Reduce unused JavaScript",
    description: "Reduce unused JavaScript and defer loading scripts.",
    score: 0.5,
    scoreDisplayMode: "numeric",
    details: {
      type: "opportunity",
      overallSavingsMs: opts.savingsMs,
      items: [],
    },
  };

  audits["network-requests"] = {
    id: "network-requests",
    details: {
      type: "table",
      items: opts.requests.map(([url, transferSize], i) => ({
        url,
        protocol: "h2",
        networkRequestTime: i * 10,
        networkEndTime: i * 10 + 25,
        finished: true,
        transferSize,
        resourceSize: transferSize * 2,
        statusCode: 200,
        mimeType: "application/javascript",
        resourceType: "Script",
        priority: "High",
        entity: "diff.test",
      })),
    },
  };

  lhr.entities = [
    { name: "diff.test", origins: [SITE.slice(0, -1)], isFirstParty: true },
  ];

  return lhr as LighthouseResult;
}

function makeResult(lhr: LighthouseResult): AuditResult {
  return {
    requestedUrl: SITE,
    finalUrl: `${SITE}home`,
    options: OPTIONS,
    runs: 3,
    median: {
      scores: { performance: 90, accessibility: 88, "best-practices": 100, seo: 80 },
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
    perRunScores: [{ performance: 90 }],
    perRunEnvironments: [
      {
        benchmarkIndex: 1500,
        hostUserAgent: "test",
        throttlingMethod: "simulate",
        cpuSlowdownMultiplier: 4,
      },
    ],
    fetchTime: "2026-09-06T00:00:00.000Z",
    lighthouseVersion: "13.4.1",
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
  const job = makeJob(runId, 0, SITE);
  const batch = makeBatch(`batch-${runId}`, [job]);
  recordBatch(batch);
  await recordRun(batch, job, makeResult(lhr));
  return runId;
}

/** The baseline: a clean run. */
function baselineLhr(): LighthouseResult {
  const requests: [string, number][] = [
    [`${SITE}app.js`, 1000],
    [`${SITE}vendor.js`, 2000],
  ];
  return makeLhr({ seoScore: 1, metaScore: 1, savingsMs: 100, requests });
}

/** The comparison: the meta description dropped, a script grew, another arrived. */
function comparisonLhr(): LighthouseResult {
  const requests: [string, number][] = [
    [`${SITE}app.js`, 1000],
    [`${SITE}vendor.js`, 9000],
    [`${SITE}tracker.js`, 500],
  ];
  return makeLhr({ seoScore: 0.82, metaScore: 0, savingsMs: 450, requests });
}

/** Invoke GET with an async params bag, matching the Next 16 handler signature. */
function callGet(runId: string, baseline?: string): Promise<Response> {
  const query = baseline === undefined ? "" : `?baseline=${encodeURIComponent(baseline)}`;
  const url = `http://localhost/api/reports/${runId}/diff${query}`;
  return GET(new Request(url), { params: Promise.resolve({ runId }) });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-diff-route-"));
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

describe("GET /api/reports/:runId/diff", () => {
  it("diffs two persisted runs into a well-formed RunDiff", async () => {
    await seedRun("run-base", baselineLhr());
    await seedRun("run-head", comparisonLhr());

    const res = await callGet("run-head", "run-base");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    // A diff carries the audited page's URLs, which Phase B made able to belong
    // to a logged-in or staging site.
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const diff = (await res.json()) as RunDiff;

    // Both sides echo the DB-round-tripped ids and their own headline numbers.
    expect(diff.baseline.runId).toBe("run-base");
    expect(diff.comparison.runId).toBe("run-head");
    expect(diff.baseline.scores.seo).toBe(100);
    expect(diff.comparison.scores.seo).toBe(82);
    expect(diff.urlMismatch).toBe(false);

    // The audit that actually moved is named, and classified as a regression.
    const meta = diff.audits.find((a) => a.id === "meta-description");
    expect(meta).toBeDefined();
    expect(meta?.status).toBe("regressed");
    expect(meta?.basis).toBe("score");
    expect(meta?.categories).toContain("seo");
    expect(meta?.weight).toBe(10);

    // The 60 identical filler audits are COUNTED, never listed — that is the
    // whole reason the composer filters what the differ classifies.
    expect(diff.unchangedAuditCount).toBeGreaterThanOrEqual(60);
    expect(diff.audits.some((a) => a.id.startsWith("filler-audit-"))).toBe(false);

    // The opportunity got worse by 350 ms, and positive means "wastes more now".
    const opportunity = diff.opportunities.find((o) => o.id === "unused-javascript");
    expect(opportunity?.savingsDeltaMs).toBe(350);
    expect(opportunity?.status).toBe("regressed");

    // Resources: one arrived, one grew, one held still, none disappeared.
    expect(diff.resources.unavailable).toBe(false);
    expect(diff.resources.added.map((r) => r.url)).toEqual([`${SITE}tracker.js`]);
    expect(diff.resources.removed).toEqual([]);
    expect(diff.resources.changed.map((r) => r.url)).toEqual([`${SITE}vendor.js`]);
    expect(diff.resources.requestCountDelta).toBe(1);
    expect(diff.resources.transferSizeDelta).toBe(10_500 - 3_000);
  });

  it("projects rather than forwarding: the payload is a fraction of the two reports", async () => {
    await seedRun("run-base", baselineLhr());
    await seedRun("run-head", comparisonLhr());

    const [baseBytes, headBytes] = await Promise.all([
      fs.stat(reportJsonPath("run-base")).then((s) => s.size),
      fs.stat(reportJsonPath("run-head")).then((s) => s.size),
    ]);
    const res = await callGet("run-head", "run-base");
    const payload = (await res.text()).length;

    expect(baseBytes + headBytes).toBeGreaterThan(200_000);
    expect(payload).toBeLessThan((baseBytes + headBytes) / 10);
  });

  it("rejects a missing baseline, and a run diffed against itself", async () => {
    await seedRun("run-head", comparisonLhr());

    const missing = await callGet("run-head");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("missing_baseline");

    const same = await callGet("run-head", "run-head");
    expect(same.status).toBe(400);
    expect((await same.json()).error.code).toBe("same_run");
  });

  it("refuses an over-long id before it reaches a lookup or a cache key", async () => {
    await seedRun("run-base", baselineLhr());
    await seedRun("run-head", comparisonLhr());

    // Phase E security review, L3: the analyze route bounded this same value at
    // 64 and this one did not, so two doors into one lookup disagreed.
    const huge = "a".repeat(65);

    const longBaseline = await callGet("run-head", huge);
    expect(longBaseline.status).toBe(400);
    expect((await longBaseline.json()).error.code).toBe("invalid_run_id");

    const longComparison = await callGet(huge, "run-base");
    expect(longComparison.status).toBe(400);
    // The over-long id is the last thing that should be echoed back.
    expect(await longComparison.text()).not.toContain(huge);

    // 64 is accepted as a length (it 404s because no such run exists, which is
    // the next check, not this one) — so the bound is a ceiling, not a shape.
    const atLimit = await callGet("run-head", "b".repeat(64));
    expect(atLimit.status).toBe(404);
  });

  it("404s when either side has no stored report, without reflecting the id", async () => {
    await seedRun("run-base", baselineLhr());

    // A caller-chosen id that would be unmistakable if it were echoed.
    const marker = "<script>alert(1)</script>";
    const noComparison = await callGet(marker, "run-base");
    expect(noComparison.status).toBe(404);
    const body = await noComparison.text();
    expect(body).not.toContain(marker);
    expect(body).not.toContain("script");

    const noBaseline = await callGet("run-base", marker);
    expect(noBaseline.status).toBe(404);
    expect(await noBaseline.text()).not.toContain(marker);
  });

  it("stops serving a memoised diff once a run is deleted", async () => {
    await seedRun("run-base", baselineLhr());
    await seedRun("run-head", comparisonLhr());

    expect((await callGet("run-head", "run-base")).status).toBe(200);
    // Warm the memo a second time so the eviction below is exercised against a
    // hit, not a miss.
    expect((await callGet("run-head", "run-base")).status).toBe(200);

    await deleteRun("run-head");

    // The DB stays authoritative for EXISTENCE: an in-process memo is exactly
    // how a deleted run's URLs keep being served for the life of the process
    // (ROADMAP Phase C's M2 is the standing precedent).
    const after = await callGet("run-head", "run-base");
    expect(after.status).toBe(404);
  });

  it("500s on a present-but-corrupt report rather than falling through to a 404", async () => {
    await seedRun("run-base", baselineLhr());
    await seedRun("run-head", comparisonLhr());
    await fs.writeFile(reportJsonPath("run-head"), "{ not json", "utf8");

    const res = await callGet("run-head", "run-base");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("report_unreadable");
  });
});
