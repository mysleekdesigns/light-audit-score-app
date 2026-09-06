import { describe, expect, it } from "vitest";

import type { LighthouseResult } from "@/lib/lighthouse/types";

import { extractFilmstrip, extractRunTrace, extractWaterfall } from "./extract";

const PAGE = "https://example.com/index.html";
const FRAME = "data:image/jpeg;base64,/9j/4AAQ";

/** A `network-requests` item with the fields a real LH 13 report carries. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://example.com/app.js",
    sessionTargetType: "page",
    protocol: "h2",
    cache: "none",
    rendererStartTime: 10,
    networkRequestTime: 20,
    networkEndTime: 120,
    finished: true,
    transferSize: 1000,
    resourceSize: 4000,
    statusCode: 200,
    mimeType: "application/javascript",
    resourceType: "Script",
    priority: "High",
    entity: "example.com",
    ...overrides,
  };
}

/** A minimal LHR: the two audits under test plus the entity table. */
function lhr(overrides: Record<string, unknown> = {}): LighthouseResult {
  const {
    requests = [request()],
    frames = [{ timing: 500, timestamp: 1, data: FRAME }],
    ...rest
  } = overrides as {
    requests?: unknown;
    frames?: unknown;
  } & Record<string, unknown>;

  return {
    mainDocumentUrl: PAGE,
    finalDisplayedUrl: PAGE,
    entities: [
      { name: "example.com", origins: ["https://example.com"], isFirstParty: true },
      { name: "Google Analytics", origins: ["https://analytics.google.com"] },
    ],
    audits: {
      "network-requests": { details: { type: "table", headings: [], items: requests } },
      "screenshot-thumbnails": { details: { type: "filmstrip", items: frames } },
      "largest-contentful-paint": { numericValue: 1088 },
    },
    ...rest,
  };
}

describe("extractWaterfall", () => {
  it("flattens a real-shaped report into rows and totals", () => {
    const data = extractWaterfall(
      lhr({
        requests: [
          request({ url: PAGE, resourceType: "Document", transferSize: 500, resourceSize: 2000 }),
          request({ networkEndTime: 350 }),
        ],
      }),
    );

    expect(data.unavailable).toBe(false);
    expect(data.requests).toHaveLength(2);
    expect(data.requests[0]).toMatchObject({
      index: 0,
      url: PAGE,
      host: "example.com",
      path: "/index.html",
      resourceType: "Document",
      statusCode: 200,
      protocol: "h2",
      priority: "High",
      startTime: 20,
      endTime: 120,
      durationMs: 100,
      thirdParty: false,
      entity: "example.com",
      renderBlocking: false,
      finished: true,
      cache: "none",
    });
    expect(data.totalTransferSize).toBe(1500);
    expect(data.totalResourceSize).toBe(6000);
    expect(data.timelineMs).toBe(350);
    expect(data.thirdPartyCount).toBe(0);
  });

  it("keeps path and query together for display", () => {
    const data = extractWaterfall(
      lhr({ requests: [request({ url: "https://cdn.example.com/static/app.js?v=2#top" })] }),
    );
    expect(data.requests[0].host).toBe("cdn.example.com");
    expect(data.requests[0].path).toBe("/static/app.js?v=2");
  });

  it("reports an absent audit as unavailable, not as an empty page", () => {
    const data = extractWaterfall({ audits: { "largest-contentful-paint": {} } });
    expect(data).toEqual({
      requests: [],
      totalTransferSize: 0,
      totalResourceSize: 0,
      timelineMs: null,
      thirdPartyCount: 0,
      unavailable: true,
    });
  });

  it("distinguishes a page that genuinely made zero requests", () => {
    const data = extractWaterfall(lhr({ requests: [] }));
    expect(data.unavailable).toBe(false);
    expect(data.requests).toEqual([]);
    expect(data.timelineMs).toBeNull();
  });

  it("treats an errored audit with no details as unavailable", () => {
    const data = extractWaterfall({
      audits: {
        "network-requests": {
          scoreDisplayMode: "error",
          errorMessage: "Required Network gatherer did not run.",
        },
      },
    });
    expect(data.unavailable).toBe(true);
  });

  it("skips malformed items but keeps every surviving row's original index", () => {
    const data = extractWaterfall(
      lhr({
        requests: [
          "not an item",
          null,
          request({ url: "https://example.com/a.css" }),
          { protocol: "h2" }, // no url — identifies no row
          request({ url: "" }),
          request({ url: "https://example.com/b.css" }),
        ],
      }),
    );

    expect(data.requests.map((r) => r.index)).toEqual([2, 5]);
    expect(data.requests.map((r) => r.url)).toEqual([
      "https://example.com/a.css",
      "https://example.com/b.css",
    ]);
  });

  it("degrades missing fields to null/empty rather than dropping the row", () => {
    const data = extractWaterfall(
      lhr({ requests: [{ url: "https://example.com/x.png" }] }),
    );
    expect(data.requests[0]).toMatchObject({
      transferSize: null,
      resourceSize: null,
      statusCode: null,
      startTime: null,
      endTime: null,
      durationMs: null,
      protocol: "",
      priority: "",
      mimeType: "",
      resourceType: "",
      cache: "",
      entity: "",
      finished: true,
    });
    expect(data.totalTransferSize).toBe(0);
    expect(data.timelineMs).toBeNull();
  });

  it("reads Chrome's -1 sentinels as unknown and leaves them out of the sums", () => {
    const data = extractWaterfall(
      lhr({
        requests: [
          request({
            transferSize: -1,
            resourceSize: -1,
            statusCode: -1,
            finished: false,
            networkEndTime: undefined,
          }),
          request({ url: "https://example.com/ok.js", transferSize: 250, resourceSize: 900 }),
        ],
      }),
    );
    expect(data.requests[0]).toMatchObject({
      transferSize: null,
      resourceSize: null,
      statusCode: null,
      endTime: null,
      durationMs: null,
      finished: false,
    });
    expect(data.totalTransferSize).toBe(250);
    expect(data.totalResourceSize).toBe(900);
  });

  it("keeps the transfer total reconciled with Lighthouse's own byte weight", () => {
    // The real shape from `data/reports/Y7iJVF6Qn6C2M5jBXmHQW.json`: a blob
    // worker request whose bytes DevTools never saw. Summing its `-1` would put
    // the total one byte under `resource-summary`/`total-byte-weight`.
    const data = extractWaterfall(
      lhr({
        requests: [
          request({ transferSize: 197389, resourceSize: 197389 }),
          request({
            url: "blob:https://example.com/f7c657ea-bac6",
            sessionTargetType: "worker",
            protocol: "blob",
            transferSize: -1,
            resourceSize: 10329,
            entity: "example.com",
          }),
        ],
      }),
    );
    // Both rows survive — the waterfall shows every request Lighthouse recorded,
    // even the ones `resource-summary` drops from its own counts.
    expect(data.requests).toHaveLength(2);
    expect(data.totalTransferSize).toBe(197389);
    expect(data.totalResourceSize).toBe(207718);
  });

  it("ignores non-finite numerics", () => {
    const data = extractWaterfall(
      lhr({
        requests: [
          request({ networkRequestTime: NaN, networkEndTime: Infinity, transferSize: NaN }),
        ],
      }),
    );
    expect(data.requests[0]).toMatchObject({
      startTime: null,
      endTime: null,
      durationMs: null,
      transferSize: null,
    });
    expect(data.timelineMs).toBeNull();
    expect(data.totalTransferSize).toBe(0);
  });

  it("reads items even when details.type is not the one we expect", () => {
    const data = extractWaterfall({
      mainDocumentUrl: PAGE,
      audits: {
        "network-requests": { details: { type: "opportunity", items: [request()] } },
      },
    });
    expect(data.unavailable).toBe(false);
    expect(data.requests).toHaveLength(1);
  });

  describe("third-party marking", () => {
    it("uses the entity table, where only an explicit isFirstParty is first-party", () => {
      const data = extractWaterfall(
        lhr({
          requests: [
            request(),
            request({
              url: "https://analytics.google.com/g/collect",
              entity: "Google Analytics",
            }),
          ],
        }),
      );
      expect(data.requests.map((r) => r.thirdParty)).toEqual([false, true]);
      expect(data.thirdPartyCount).toBe(1);
    });

    it("falls back to origin comparison when the report has no entity table", () => {
      const legacy = lhr({
        requests: [
          request({ entity: undefined }),
          request({ url: "https://cdn.other.com/x.js", entity: undefined }),
          request({ url: "http://example.com/insecure.js", entity: undefined }),
        ],
      });
      delete (legacy as Record<string, unknown>).entities;

      const data = extractWaterfall(legacy);
      // Same origin is first-party; a different host — or the same host over a
      // different scheme — is not.
      expect(data.requests.map((r) => r.thirdParty)).toEqual([false, true, true]);
    });

    it("falls back to origin comparison for a request the entity table does not name", () => {
      const data = extractWaterfall(
        lhr({
          requests: [
            request({ url: "https://example.com/same.js", entity: undefined }),
            request({ url: "https://unknown.example.net/x.js", entity: "Mystery Co" }),
          ],
        }),
      );
      expect(data.requests.map((r) => r.thirdParty)).toEqual([false, true]);
    });

    it("never marks a request it cannot place", () => {
      const noOrigin = lhr({
        requests: [
          request({ url: "data:image/svg+xml,%3Csvg%3E", entity: undefined }),
          request({ url: "definitely not a url", entity: undefined }),
        ],
      });
      delete (noOrigin as Record<string, unknown>).entities;

      const data = extractWaterfall(noOrigin);
      expect(data.requests.map((r) => r.thirdParty)).toEqual([false, false]);
      expect(data.thirdPartyCount).toBe(0);
    });

    it("cannot place anything when the report has neither entities nor a page URL", () => {
      const data = extractWaterfall({
        audits: {
          "network-requests": {
            details: { items: [request({ url: "https://cdn.other.com/x.js", entity: undefined })] },
          },
        },
      });
      expect(data.requests[0].thirdParty).toBe(false);
    });

    it("ignores malformed entity rows instead of throwing", () => {
      const data = extractWaterfall(
        lhr({ entities: ["nope", null, { origins: [] }, 42], requests: [request()] }),
      );
      // No usable row named `example.com`, so the origin fallback decides.
      expect(data.requests[0].thirdParty).toBe(false);
    });
  });

  describe("URLs with no hostname", () => {
    it("shows the raw URL for an inline data: request", () => {
      const url = "data:image/svg+xml,%3Csvg%20width%3D%2280%22%3E";
      const data = extractWaterfall(lhr({ requests: [request({ url, protocol: "data" })] }));
      expect(data.requests[0]).toMatchObject({ url, host: "", path: url });
    });

    it("shows the raw URL for a blob: request but still places it by origin", () => {
      const url = "blob:https://example.com/9efe94c0-b988";
      const blob = lhr({ requests: [request({ url, entity: undefined, protocol: "blob" })] });
      delete (blob as Record<string, unknown>).entities;

      const data = extractWaterfall(blob);
      expect(data.requests[0]).toMatchObject({ host: "", path: url, thirdParty: false });
    });

    it("shows the raw URL when it will not parse at all", () => {
      const data = extractWaterfall(lhr({ requests: [request({ url: "//protocol-relative/x" })] }));
      expect(data.requests[0]).toMatchObject({
        host: "",
        path: "//protocol-relative/x",
      });
    });
  });

  describe("render-blocking marking", () => {
    it("reads the Lighthouse 13 render-blocking-insight audit", () => {
      const report = lhr({
        requests: [request({ url: "https://example.com/blocking.css" }), request()],
      });
      (report.audits as Record<string, unknown>)["render-blocking-insight"] = {
        details: {
          type: "table",
          items: [{ url: "https://example.com/blocking.css", totalBytes: 900 }],
        },
      };

      const data = extractWaterfall(report);
      expect(data.requests.map((r) => r.renderBlocking)).toEqual([true, false]);
    });

    it("reads the pre-13 render-blocking-resources audit", () => {
      const report = lhr({
        requests: [request({ url: "https://example.com/legacy.css" }), request()],
      });
      (report.audits as Record<string, unknown>)["render-blocking-resources"] = {
        details: { type: "opportunity", items: [{ url: "https://example.com/legacy.css" }] },
      };

      const data = extractWaterfall(report);
      expect(data.requests.map((r) => r.renderBlocking)).toEqual([true, false]);
    });

    it("unions both audit ids and ignores items with no url", () => {
      const report = lhr({
        requests: [
          request({ url: "https://example.com/new.css" }),
          request({ url: "https://example.com/old.css" }),
          request(),
        ],
      });
      (report.audits as Record<string, unknown>)["render-blocking-insight"] = {
        details: { items: [{ url: "https://example.com/new.css" }, { totalBytes: 1 }, null] },
      };
      (report.audits as Record<string, unknown>)["render-blocking-resources"] = {
        details: { items: [{ url: "https://example.com/old.css" }] },
      };

      const data = extractWaterfall(report);
      expect(data.requests.map((r) => r.renderBlocking)).toEqual([true, true, false]);
    });

    it("matches by exact URL, so a query-string variant is a different resource", () => {
      const report = lhr({ requests: [request({ url: "https://example.com/a.css?v=2" })] });
      (report.audits as Record<string, unknown>)["render-blocking-insight"] = {
        details: { items: [{ url: "https://example.com/a.css" }] },
      };
      expect(extractWaterfall(report).requests[0].renderBlocking).toBe(false);
    });
  });
});

describe("extractFilmstrip", () => {
  it("reads frames in capture order and marks the LCP frame", () => {
    const data = extractFilmstrip(
      lhr({
        frames: [
          { timing: 375, timestamp: 1, data: FRAME },
          { timing: 750, timestamp: 2, data: FRAME },
          { timing: 1125, timestamp: 3, data: FRAME },
          { timing: 1500, timestamp: 4, data: FRAME },
        ],
      }),
    );

    expect(data.unavailable).toBe(false);
    expect(data.frames.map((f) => f.timingMs)).toEqual([375, 750, 1125, 1500]);
    expect(data.frames.map((f) => f.isLcp)).toEqual([false, false, true, false]);
    expect(data.lcpMs).toBe(1088);
    expect(data.timelineMs).toBe(1500);
  });

  it("marks the first frame when LCP lands before the strip starts", () => {
    const report = lhr({ frames: [{ timing: 375, data: FRAME }, { timing: 750, data: FRAME }] });
    (report.audits as Record<string, unknown>)["largest-contentful-paint"] = {
      numericValue: 100,
    };
    expect(extractFilmstrip(report).frames.map((f) => f.isLcp)).toEqual([true, false]);
  });

  it("marks the last frame when LCP lands after the strip ends", () => {
    const report = lhr({ frames: [{ timing: 375, data: FRAME }, { timing: 750, data: FRAME }] });
    (report.audits as Record<string, unknown>)["largest-contentful-paint"] = {
      numericValue: 9000,
    };
    expect(extractFilmstrip(report).frames.map((f) => f.isLcp)).toEqual([false, true]);
  });

  it("marks the frame that lands exactly on the LCP timing", () => {
    const report = lhr({ frames: [{ timing: 375, data: FRAME }, { timing: 750, data: FRAME }] });
    (report.audits as Record<string, unknown>)["largest-contentful-paint"] = {
      numericValue: 750,
    };
    expect(extractFilmstrip(report).frames.map((f) => f.isLcp)).toEqual([false, true]);
  });

  it("marks nothing when the LCP audit is absent", () => {
    const report = lhr();
    delete (report.audits as Record<string, unknown>)["largest-contentful-paint"];

    const data = extractFilmstrip(report);
    expect(data.lcpMs).toBeNull();
    expect(data.frames.every((f) => !f.isLcp)).toBe(true);
  });

  it("marks nothing when the LCP audit carries no numeric value", () => {
    const report = lhr();
    (report.audits as Record<string, unknown>)["largest-contentful-paint"] = {
      scoreDisplayMode: "error",
      numericValue: null,
    };
    expect(extractFilmstrip(report).lcpMs).toBeNull();
  });

  it("reports an absent audit as unavailable but still reads the LCP it has", () => {
    const data = extractFilmstrip({
      audits: { "largest-contentful-paint": { numericValue: 2400 } },
    });
    expect(data).toEqual({ frames: [], lcpMs: 2400, timelineMs: null, unavailable: true });
  });

  it("distinguishes a present audit that captured no frames", () => {
    const data = extractFilmstrip(lhr({ frames: [] }));
    expect(data.unavailable).toBe(false);
    expect(data.frames).toEqual([]);
    expect(data.timelineMs).toBeNull();
  });

  it("skips frames that cannot be rendered", () => {
    const data = extractFilmstrip(
      lhr({
        frames: [
          "nope",
          null,
          { timing: 375 }, // no image
          { data: FRAME }, // no timing
          { timing: NaN, data: FRAME },
          { timing: 750, data: "javascript:alert(1)" },
          { timing: 1125, data: "/9j/4AAQ" }, // bare base64, not a URI
          { timing: 1500, data: FRAME },
        ],
      }),
    );
    expect(data.frames).toEqual([{ timingMs: 1500, data: FRAME, isLcp: true }]);
    expect(data.timelineMs).toBe(1500);
  });
});

describe("extractRunTrace", () => {
  it("echoes the run id and both projections", () => {
    const trace = extractRunTrace(lhr(), "run-123");
    expect(trace.runId).toBe("run-123");
    expect(trace.finalUrl).toBe(PAGE);
    expect(trace.waterfall.requests).toHaveLength(1);
    expect(trace.filmstrip.frames).toHaveLength(1);
  });

  it("falls back to finalUrl, then to an empty string", () => {
    expect(extractRunTrace({ finalUrl: "https://legacy.example/" }, "r").finalUrl).toBe(
      "https://legacy.example/",
    );
    expect(extractRunTrace({}, "r").finalUrl).toBe("");
  });

  it("degrades a report with neither audit to two empty states", () => {
    const trace = extractRunTrace({ finalDisplayedUrl: PAGE, audits: {} }, "r");
    expect(trace.waterfall.unavailable).toBe(true);
    expect(trace.filmstrip.unavailable).toBe(true);
  });
});

describe("tolerance", () => {
  // Every one of these has been seen, or is one field-rename away from being
  // seen, in a stored report; none may ever reach the route as a 500.
  const hostile: [string, LighthouseResult][] = [
    ["empty object", {}],
    ["null audits", { audits: null }],
    ["audits as a string", { audits: "nope" }],
    ["audits as an array", { audits: [] }],
    ["null details", { audits: { "network-requests": { details: null } } }],
    ["items as a string", { audits: { "network-requests": { details: { items: "nope" } } } }],
    ["items as an object", { audits: { "screenshot-thumbnails": { details: { items: {} } } } }],
    ["audit as a string", { audits: { "network-requests": "errored" } }],
    ["entities as an object", { ...lhr(), entities: { name: "x" } }],
    ["entities as a string", { ...lhr(), entities: "example.com" }],
    ["non-string urls", { audits: { "network-requests": { details: { items: [{ url: 42 }] } } } }],
    ["numeric page url", { ...lhr(), mainDocumentUrl: 7, finalDisplayedUrl: 7, finalUrl: 7 }],
    ["render-blocking garbage", { ...lhr(), audits: { "render-blocking-insight": 1 } }],
    ["non-finite lcp", { ...lhr(), audits: { "largest-contentful-paint": { numericValue: NaN } } }],
  ];

  for (const [name, input] of hostile) {
    it(`never throws: ${name}`, () => {
      expect(() => extractWaterfall(input)).not.toThrow();
      expect(() => extractFilmstrip(input)).not.toThrow();
      expect(() => extractRunTrace(input, "run-1")).not.toThrow();
    });
  }

  it("returns a well-formed trace for the emptiest possible report", () => {
    expect(extractRunTrace({}, "run-1")).toEqual({
      runId: "run-1",
      finalUrl: "",
      waterfall: {
        requests: [],
        totalTransferSize: 0,
        totalResourceSize: 0,
        timelineMs: null,
        thirdPartyCount: 0,
        unavailable: true,
      },
      filmstrip: { frames: [], lcpMs: null, timelineMs: null, unavailable: true },
    });
  });

  it("does not mutate the report it reads", () => {
    const report = lhr();
    const before = JSON.stringify(report);
    extractRunTrace(report, "run-1");
    expect(JSON.stringify(report)).toBe(before);
  });
});
