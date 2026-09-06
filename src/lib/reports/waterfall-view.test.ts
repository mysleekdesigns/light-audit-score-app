import { describe, expect, it } from "vitest";

import type { WaterfallData, WaterfallRequest } from "@/lib/reports/types";
import {
  ABSENT,
  barGeometry,
  barTone,
  clampText,
  DEFAULT_WATERFALL_SORT,
  defaultDirection,
  formatBytes,
  formatDuration,
  formatRowNumber,
  hostOf,
  MIN_BAR_PCT,
  nextSort,
  requestLabel,
  requestMarks,
  sortRequests,
  summarizeWaterfall,
  type WaterfallSortKey,
} from "@/lib/reports/waterfall-view";

/** A fully-populated row; every test overrides only the fields it cares about. */
function request(overrides: Partial<WaterfallRequest> = {}): WaterfallRequest {
  return {
    index: 0,
    url: "https://example.com/app.js",
    path: "/app.js",
    host: "example.com",
    resourceType: "Script",
    mimeType: "text/javascript",
    transferSize: 1024,
    resourceSize: 2048,
    statusCode: 200,
    protocol: "h2",
    priority: "High",
    startTime: 100,
    endTime: 200,
    durationMs: 100,
    thirdParty: false,
    entity: "",
    renderBlocking: false,
    finished: true,
    cache: "",
    ...overrides,
  };
}

/** The row indices a sort produced — the compact assertion for order + stability. */
function order(rows: readonly WaterfallRequest[]): number[] {
  return rows.map((r) => r.index);
}

describe("sortRequests", () => {
  // Deliberately NOT in index order, so "sorted by index" is a real assertion.
  const rows: WaterfallRequest[] = [
    request({ index: 2, host: "cdn.example.com", path: "/b.css", resourceType: "Stylesheet", transferSize: 500, startTime: 50, durationMs: 300 }),
    request({ index: 0, host: "example.com", path: "/", resourceType: "Document", transferSize: 9000, startTime: 0, durationMs: 100 }),
    request({ index: 1, host: "example.com", path: "/a.js", resourceType: "Script", transferSize: 500, startTime: 50, durationMs: 200 }),
  ];

  it("restores the LHR's own order by index, ascending", () => {
    expect(order(sortRequests(rows, { key: "index", direction: "asc" }))).toEqual([0, 1, 2]);
  });

  it("reverses the LHR's order by index, descending", () => {
    expect(order(sortRequests(rows, { key: "index", direction: "desc" }))).toEqual([2, 1, 0]);
  });

  it("sorts by start time ascending, then descending", () => {
    expect(order(sortRequests(rows, { key: "start", direction: "asc" }))).toEqual([0, 1, 2]);
    expect(order(sortRequests(rows, { key: "start", direction: "desc" }))).toEqual([1, 2, 0]);
  });

  it("sorts by duration ascending, then descending", () => {
    expect(order(sortRequests(rows, { key: "duration", direction: "asc" }))).toEqual([0, 1, 2]);
    expect(order(sortRequests(rows, { key: "duration", direction: "desc" }))).toEqual([2, 1, 0]);
  });

  it("sorts by transfer size ascending, then descending", () => {
    expect(order(sortRequests(rows, { key: "size", direction: "asc" }))).toEqual([1, 2, 0]);
    expect(order(sortRequests(rows, { key: "size", direction: "desc" }))).toEqual([0, 1, 2]);
  });

  it("sorts by request host first, then path", () => {
    expect(order(sortRequests(rows, { key: "request", direction: "asc" }))).toEqual([2, 0, 1]);
    expect(order(sortRequests(rows, { key: "request", direction: "desc" }))).toEqual([1, 0, 2]);
  });

  it("sorts by resource type", () => {
    expect(order(sortRequests(rows, { key: "type", direction: "asc" }))).toEqual([0, 1, 2]);
  });

  it("keeps ties in LHR order in BOTH directions (stability)", () => {
    // Indices 1 and 2 share startTime 50; index order must survive either way.
    expect(order(sortRequests(rows, { key: "start", direction: "asc" })).slice(1)).toEqual([1, 2]);
    expect(order(sortRequests(rows, { key: "start", direction: "desc" })).slice(0, 2)).toEqual([1, 2]);
  });

  it("sinks null values to the bottom in both directions", () => {
    const withNulls: WaterfallRequest[] = [
      request({ index: 0, transferSize: null }),
      request({ index: 1, transferSize: 10 }),
      request({ index: 2, transferSize: null }),
      request({ index: 3, transferSize: 20 }),
    ];
    expect(order(sortRequests(withNulls, { key: "size", direction: "asc" }))).toEqual([1, 3, 0, 2]);
    expect(order(sortRequests(withNulls, { key: "size", direction: "desc" }))).toEqual([3, 1, 0, 2]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    sortRequests(input, { key: "size", direction: "desc" });
    expect(order(input)).toEqual([2, 0, 1]);
  });

  it("never loses a row's index identity", () => {
    const keys: WaterfallSortKey[] = ["index", "request", "type", "size", "start", "duration"];
    for (const key of keys) {
      for (const direction of ["asc", "desc"] as const) {
        expect(order(sortRequests(rows, { key, direction })).toSorted()).toEqual([0, 1, 2]);
      }
    }
  });

  it("handles an empty list", () => {
    expect(sortRequests([], DEFAULT_WATERFALL_SORT)).toEqual([]);
  });
});

describe("nextSort / defaultDirection", () => {
  it("defaults the LHR order to ascending", () => {
    expect(DEFAULT_WATERFALL_SORT).toEqual({ key: "index", direction: "asc" });
  });

  it("opens size and duration descending, everything else ascending", () => {
    expect(defaultDirection("size")).toBe("desc");
    expect(defaultDirection("duration")).toBe("desc");
    expect(defaultDirection("index")).toBe("asc");
    expect(defaultDirection("request")).toBe("asc");
    expect(defaultDirection("type")).toBe("asc");
    expect(defaultDirection("start")).toBe("asc");
  });

  it("flips the direction when the active column is clicked again", () => {
    expect(nextSort({ key: "start", direction: "asc" }, "start")).toEqual({
      key: "start",
      direction: "desc",
    });
    expect(nextSort({ key: "start", direction: "desc" }, "start")).toEqual({
      key: "start",
      direction: "asc",
    });
  });

  it("adopts the new column's default direction", () => {
    expect(nextSort({ key: "start", direction: "desc" }, "size")).toEqual({
      key: "size",
      direction: "desc",
    });
    expect(nextSort({ key: "size", direction: "asc" }, "index")).toEqual({
      key: "index",
      direction: "asc",
    });
  });
});

describe("barGeometry", () => {
  it("places a bar proportionally on the timeline", () => {
    expect(barGeometry({ startTime: 250, endTime: 500 }, 1000)).toEqual({
      offsetPct: 25,
      widthPct: 25,
    });
  });

  it("returns null rather than dividing by a zero timeline", () => {
    expect(barGeometry({ startTime: 100, endTime: 200 }, 0)).toBeNull();
  });

  it("returns null for a null timeline", () => {
    expect(barGeometry({ startTime: 100, endTime: 200 }, null)).toBeNull();
  });

  it("returns null for a negative or non-finite timeline", () => {
    expect(barGeometry({ startTime: 100, endTime: 200 }, -50)).toBeNull();
    expect(barGeometry({ startTime: 100, endTime: 200 }, Number.NaN)).toBeNull();
    expect(barGeometry({ startTime: 100, endTime: 200 }, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns null when the request has no start time", () => {
    expect(barGeometry({ startTime: null, endTime: 200 }, 1000)).toBeNull();
  });

  it("gives an unfinished request (null end) the minimum-width bar at its start", () => {
    expect(barGeometry({ startTime: 500, endTime: null }, 1000)).toEqual({
      offsetPct: 50,
      widthPct: MIN_BAR_PCT,
    });
  });

  it("gives a sub-millisecond request a visible minimum-width bar", () => {
    const bar = barGeometry({ startTime: 100, endTime: 100.2 }, 4000);
    expect(bar?.widthPct).toBe(MIN_BAR_PCT);
  });

  it("clamps a bar that would run past the right edge", () => {
    // endTime beyond the timeline: 90% offset leaves only 10% of track.
    const bar = barGeometry({ startTime: 900, endTime: 3000 }, 1000);
    expect(bar).toEqual({ offsetPct: 90, widthPct: 10 });
    expect(bar!.offsetPct + bar!.widthPct).toBeLessThanOrEqual(100);
  });

  it("keeps a bar on-track even when the start is at or past the timeline end", () => {
    const bar = barGeometry({ startTime: 1200, endTime: 1300 }, 1000);
    expect(bar).toEqual({ offsetPct: 100 - MIN_BAR_PCT, widthPct: MIN_BAR_PCT });
    expect(bar!.offsetPct + bar!.widthPct).toBe(100);
  });

  it("clamps a negative start to the track's left edge", () => {
    expect(barGeometry({ startTime: -100, endTime: 200 }, 1000)?.offsetPct).toBe(0);
  });

  it("does not produce a negative width when end precedes start", () => {
    expect(barGeometry({ startTime: 500, endTime: 100 }, 1000)?.widthPct).toBe(MIN_BAR_PCT);
  });

  it("never emits NaN into a percentage", () => {
    const bar = barGeometry({ startTime: Number.NaN, endTime: 200 }, 1000);
    expect(bar).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats zero as bytes, not as an absent value", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats sub-kilobyte sizes in bytes", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to KB at exactly 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4300)).toBe("4.2 KB");
  });

  it("switches to MB at exactly 1048576", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
  });

  it("rounds up to MB rather than printing a four-digit KB", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
  });

  it("returns the absent marker for null, undefined, NaN and negatives", () => {
    expect(formatBytes(null)).toBe(ABSENT);
    expect(formatBytes(undefined)).toBe(ABSENT);
    expect(formatBytes(Number.NaN)).toBe(ABSENT);
    expect(formatBytes(-1)).toBe(ABSENT);
  });
});

describe("formatDuration", () => {
  it("formats zero and sub-second durations in milliseconds", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(0.4)).toBe("0 ms");
    expect(formatDuration(84)).toBe("84 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });

  it("switches to seconds at 1000 ms", () => {
    expect(formatDuration(1000)).toBe("1.00 s");
    expect(formatDuration(1240)).toBe("1.24 s");
    expect(formatDuration(4213)).toBe("4.21 s");
  });

  it("rounds up to seconds rather than printing 1000 ms", () => {
    expect(formatDuration(999.6)).toBe("1.00 s");
  });

  it("returns the absent marker for null, undefined, NaN and negatives", () => {
    expect(formatDuration(null)).toBe(ABSENT);
    expect(formatDuration(undefined)).toBe(ABSENT);
    expect(formatDuration(Number.NaN)).toBe(ABSENT);
    expect(formatDuration(-5)).toBe(ABSENT);
  });
});

describe("formatRowNumber", () => {
  it("pads to the width of the largest row number", () => {
    expect(formatRowNumber(0, 9)).toBe("1");
    expect(formatRowNumber(0, 10)).toBe("01");
    expect(formatRowNumber(0, 104)).toBe("001");
    expect(formatRowNumber(103, 104)).toBe("104");
  });

  it("survives a zero count", () => {
    expect(formatRowNumber(0, 0)).toBe("1");
  });
});

describe("clampText", () => {
  it("leaves text at or under the limit alone", () => {
    expect(clampText("/app.js", 20)).toBe("/app.js");
    expect(clampText("abcde", 5)).toBe("abcde");
  });

  it("truncates a long data: URL with an ellipsis", () => {
    expect(clampText("data:image/png;base64,AAAA", 10)).toBe("data:imag…");
  });

  it("returns an empty string for a non-positive limit", () => {
    expect(clampText("anything", 0)).toBe("");
  });
});

describe("hostOf", () => {
  it("returns the hostname of a parseable URL", () => {
    expect(hostOf("https://cdn.example.com/a.js?v=2")).toBe("cdn.example.com");
  });

  it("returns an empty string for an unparseable URL", () => {
    expect(hostOf("")).toBe("");
    expect(hostOf("not a url")).toBe("");
  });

  it("returns an empty string for a data: URL", () => {
    expect(hostOf("data:image/png;base64,AAAA")).toBe("");
  });
});

describe("requestLabel", () => {
  it("shows the bare path for a same-host request", () => {
    expect(requestLabel(request({ host: "example.com", path: "/a.js" }), "example.com")).toEqual({
      text: "/a.js",
      crossHost: false,
    });
  });

  it("prefixes the host for a cross-host request", () => {
    expect(requestLabel(request({ host: "cdn.other.com", path: "/lib.js" }), "example.com")).toEqual(
      { text: "cdn.other.com/lib.js", crossHost: true },
    );
  });

  it("treats a hostless request (data:) as same-host", () => {
    const row = request({ host: "", path: "data:image/png;base64,AAAA" });
    expect(requestLabel(row, "example.com")).toEqual({
      text: "data:image/png;base64,AAAA",
      crossHost: false,
    });
  });

  it("falls back to the raw URL when the path is empty", () => {
    const row = request({ host: "", path: "", url: "blob:https://example.com/xyz" });
    expect(requestLabel(row, "example.com").text).toBe("blob:https://example.com/xyz");
  });

  it("does not claim cross-host when the page's own host is unknown", () => {
    expect(requestLabel(request({ host: "cdn.other.com" }), "").crossHost).toBe(false);
  });
});

describe("requestMarks / barTone", () => {
  it("marks nothing for a plain first-party request", () => {
    expect(requestMarks(request())).toEqual([]);
    expect(barTone(request())).toBe("first-party");
  });

  it("marks a render-blocking request", () => {
    const row = request({ renderBlocking: true });
    expect(requestMarks(row)).toEqual(["render-blocking"]);
    expect(barTone(row)).toBe("blocking");
  });

  it("marks a third-party request", () => {
    const row = request({ thirdParty: true });
    expect(requestMarks(row)).toEqual(["third-party"]);
    expect(barTone(row)).toBe("third-party");
  });

  it("carries both marks but tones the bar as blocking", () => {
    const row = request({ renderBlocking: true, thirdParty: true });
    expect(requestMarks(row)).toEqual(["render-blocking", "third-party"]);
    expect(barTone(row)).toBe("blocking");
  });
});

describe("summarizeWaterfall", () => {
  function data(overrides: Partial<WaterfallData> = {}): WaterfallData {
    return {
      requests: [request({ index: 0 }), request({ index: 1 })],
      totalTransferSize: 1024 * 1024,
      totalResourceSize: 4_000_000,
      timelineMs: 4213,
      thirdPartyCount: 1,
      unavailable: false,
      ...overrides,
    };
  }

  it("reports the counts and pre-formats the figures", () => {
    expect(summarizeWaterfall(data())).toEqual({
      requestCount: 2,
      thirdPartyCount: 1,
      transferLabel: "1.0 MB",
      timelineLabel: "4.21 s",
    });
  });

  it("shows the absent marker for an unknown timeline", () => {
    expect(summarizeWaterfall(data({ timelineMs: null })).timelineLabel).toBe(ABSENT);
  });

  it("summarises an empty payload without throwing", () => {
    expect(
      summarizeWaterfall(
        data({ requests: [], totalTransferSize: 0, thirdPartyCount: 0, timelineMs: null }),
      ),
    ).toEqual({
      requestCount: 0,
      thirdPartyCount: 0,
      transferLabel: "0 B",
      timelineLabel: ABSENT,
    });
  });
});
