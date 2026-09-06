import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LighthouseResult } from "@/lib/lighthouse/types";
import { extractWaterfall } from "@/lib/reports/extract";

import { MAX_DIFF_URL } from "@/lib/reports/diff-types";

import { diffRequests } from "./diff-requests";

const PAGE = "https://example.com/index.html";

/** A `network-requests` item with the fields a real LH 13 report carries. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://example.com/app.js",
    protocol: "h2",
    cache: "none",
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

/** A minimal LHR carrying just the audit under test plus the entity table. */
function lhr(
  requests: unknown[],
  overrides: Record<string, unknown> = {},
): LighthouseResult {
  return {
    mainDocumentUrl: PAGE,
    finalDisplayedUrl: PAGE,
    entities: [
      { name: "example.com", origins: ["https://example.com"], isFirstParty: true },
      { name: "Google Analytics", origins: ["https://analytics.google.com"] },
    ],
    audits: {
      "network-requests": { details: { type: "table", headings: [], items: requests } },
    },
    ...overrides,
  };
}

/** The zeroed shape every unavailable diff must return, in full. */
const UNAVAILABLE = {
  added: [],
  removed: [],
  changed: [],
  unchangedCount: 0,
  baselineRequestCount: 0,
  comparisonRequestCount: 0,
  requestCountDelta: 0,
  baselineTransferSize: 0,
  comparisonTransferSize: 0,
  transferSizeDelta: 0,
  baselineThirdPartyCount: 0,
  comparisonThirdPartyCount: 0,
  unavailable: true,
};

describe("diffRequests", () => {
  describe("presence", () => {
    it("reports a URL only the comparison run made as added", () => {
      const diff = diffRequests(
        lhr([request()]),
        lhr([request(), request({ url: "https://example.com/new.js", transferSize: 4200 })]),
      );

      expect(diff.unavailable).toBe(false);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([]);
      expect(diff.unchangedCount).toBe(1);
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0]).toMatchObject({
        url: "https://example.com/new.js",
        path: "/new.js",
        host: "example.com",
        resourceType: "Script",
        thirdParty: false,
        baselineCount: 0,
        comparisonCount: 1,
        baselineTransferSize: null,
        comparisonTransferSize: 4200,
        // Never 4200: the absent side recorded no bytes, and a delta against an
        // implied zero is the fabricated number the contract forbids.
        transferDelta: null,
        status: "added",
      });
    });

    it("reports a URL only the baseline run made as removed", () => {
      const diff = diffRequests(
        lhr([request(), request({ url: "https://example.com/gone.css", transferSize: 900 })]),
        lhr([request()]),
      );

      expect(diff.added).toEqual([]);
      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0]).toMatchObject({
        url: "https://example.com/gone.css",
        baselineCount: 1,
        comparisonCount: 0,
        baselineTransferSize: 900,
        comparisonTransferSize: null,
        transferDelta: null,
        status: "removed",
      });
    });
  });

  describe("size movement", () => {
    it("classifies a request that grew as regressed", () => {
      const diff = diffRequests(
        lhr([request({ transferSize: 1000 })]),
        lhr([request({ transferSize: 1340 })]),
      );

      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0]).toMatchObject({
        url: "https://example.com/app.js",
        baselineTransferSize: 1000,
        comparisonTransferSize: 1340,
        transferDelta: 340,
        status: "regressed",
      });
      expect(diff.unchangedCount).toBe(0);
    });

    it("classifies a request that shrank as improved", () => {
      const diff = diffRequests(
        lhr([request({ transferSize: 1000 })]),
        lhr([request({ transferSize: 400 })]),
      );

      expect(diff.changed[0]).toMatchObject({ transferDelta: -600, status: "improved" });
    });

    it("counts an identical request as unchanged rather than listing it", () => {
      const diff = diffRequests(lhr([request()]), lhr([request()]));

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual([]);
      expect(diff.unchangedCount).toBe(1);
      expect(diff.requestCountDelta).toBe(0);
      expect(diff.transferSizeDelta).toBe(0);
    });
  });

  describe("occurrence counts", () => {
    it("counts a URL fetched twice rather than collapsing it into one row", () => {
      const diff = diffRequests(
        lhr([request({ transferSize: 500 })]),
        lhr([request({ transferSize: 500 }), request({ transferSize: 500 })]),
      );

      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0]).toMatchObject({
        baselineCount: 1,
        comparisonCount: 2,
        baselineTransferSize: 500,
        // Summed across both occurrences, not overwritten by the last one.
        comparisonTransferSize: 1000,
        transferDelta: 500,
        status: "regressed",
      });
      expect(diff.baselineRequestCount).toBe(1);
      expect(diff.comparisonRequestCount).toBe(2);
      expect(diff.requestCountDelta).toBe(1);
    });

    it("classifies on the count when the summed bytes are identical", () => {
      // Two 500-byte fetches become one 1000-byte fetch: the page weighs the
      // same, but it stopped making a request — a real, visible change.
      const diff = diffRequests(
        lhr([request({ transferSize: 500 }), request({ transferSize: 500 })]),
        lhr([request({ transferSize: 1000 })]),
      );

      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0]).toMatchObject({
        baselineCount: 2,
        comparisonCount: 1,
        transferDelta: 0,
        status: "improved",
      });
      expect(diff.unchangedCount).toBe(0);
    });

    it("counts URL keys in unchangedCount, and requests in the totals", () => {
      const diff = diffRequests(
        lhr([request(), request(), request({ url: "https://example.com/a.css" })]),
        lhr([request(), request(), request({ url: "https://example.com/a.css" })]),
      );

      expect(diff.unchangedCount).toBe(2);
      expect(diff.baselineRequestCount).toBe(3);
      expect(diff.comparisonRequestCount).toBe(3);
    });
  });

  describe("unrecorded transfer sizes", () => {
    it("keeps transferDelta null when one side recorded no bytes", () => {
      const diff = diffRequests(
        // `-1` is Chrome's unknown sentinel; the Phase D reader reads it as null.
        lhr([request({ transferSize: -1 })]),
        lhr([request({ transferSize: 1000 })]),
      );

      expect(diff.changed).toEqual([]);
      // Nothing we can MEASURE moved: the bytes are unknown on one side and the
      // occurrence count did not move.
      expect(diff.unchangedCount).toBe(1);
      expect(diff.baselineTransferSize).toBe(0);
      expect(diff.comparisonTransferSize).toBe(1000);
    });

    it("still classifies an unmeasurable request on its occurrence count", () => {
      const diff = diffRequests(
        lhr([request({ transferSize: -1 })]),
        lhr([request({ transferSize: -1 }), request({ transferSize: -1 })]),
      );

      expect(diff.changed[0]).toMatchObject({
        baselineCount: 1,
        comparisonCount: 2,
        baselineTransferSize: null,
        comparisonTransferSize: null,
        transferDelta: null,
        status: "regressed",
      });
    });

    it("sums the occurrences that did record bytes, and only reports null when none did", () => {
      const diff = diffRequests(
        lhr([request({ transferSize: 700 }), request({ transferSize: -1 })]),
        lhr([request({ transferSize: -1 })]),
      );

      expect(diff.changed[0]).toMatchObject({
        baselineCount: 2,
        comparisonCount: 1,
        // The measured half still weighs what it weighed; only the side where
        // NOTHING was recorded reports null.
        baselineTransferSize: 700,
        comparisonTransferSize: null,
        transferDelta: null,
        status: "improved",
      });
    });

    it("leaves an unmeasurable request with an unmoved count as unchanged", () => {
      const diff = diffRequests(
        lhr([request({ transferSize: 700 }), request({ transferSize: -1 })]),
        lhr([request({ transferSize: -1 }), request({ transferSize: -1 })]),
      );

      expect(diff.changed).toEqual([]);
      expect(diff.unchangedCount).toBe(1);
    });

    it("treats a recorded zero as a measurement, unlike the -1 sentinel", () => {
      // Both shapes occur in this repo's stored reports, and they mean opposite
      // things: `0` is a real cache hit that cost no bytes, `-1` is Chrome
      // saying it never saw the bytes at all.
      const diff = diffRequests(
        lhr([request({ transferSize: 0 })]),
        lhr([request({ transferSize: 0 }), request({ transferSize: 1923 })]),
      );

      expect(diff.changed[0]).toMatchObject({
        baselineTransferSize: 0,
        comparisonTransferSize: 1923,
        transferDelta: 1923,
        status: "regressed",
      });
    });
  });

  describe("unavailable", () => {
    const withRequests = lhr([request()]);

    it("returns an empty, zeroed diff when the baseline predates the audit", () => {
      expect(diffRequests({ audits: {} }, withRequests)).toEqual(UNAVAILABLE);
    });

    it("returns an empty, zeroed diff when the comparison predates the audit", () => {
      expect(diffRequests(withRequests, { audits: {} })).toEqual(UNAVAILABLE);
    });

    it("never reports a legacy baseline as a wholesale removal", () => {
      const diff = diffRequests(
        { audits: { "network-requests": { scoreDisplayMode: "error" } } },
        lhr([request(), request({ url: "https://example.com/a.css" })]),
      );

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.comparisonRequestCount).toBe(0);
      expect(diff.unavailable).toBe(true);
    });

    it("distinguishes a page that genuinely made zero requests", () => {
      const diff = diffRequests(lhr([]), lhr([request({ transferSize: 250 })]));

      expect(diff.unavailable).toBe(false);
      expect(diff.added).toHaveLength(1);
      expect(diff.baselineRequestCount).toBe(0);
      expect(diff.transferSizeDelta).toBe(250);
    });

    it("reports two genuinely empty runs as an available, empty diff", () => {
      const diff = diffRequests(lhr([]), lhr([]));

      expect(diff).toEqual({ ...UNAVAILABLE, unavailable: false });
    });
  });

  describe("totals", () => {
    it("reconciles with each side's own waterfall projection", () => {
      const baseline = lhr([
        request({ transferSize: 1000 }),
        request({ url: "https://analytics.google.com/g/collect", entity: "Google Analytics", transferSize: 40 }),
      ]);
      const comparison = lhr([
        request({ transferSize: 1500 }),
        request({ url: "https://analytics.google.com/g/collect", entity: "Google Analytics", transferSize: 40 }),
        request({ url: "https://cdn.other.com/x.js", entity: "Other CDN", transferSize: 9000 }),
      ]);

      const diff = diffRequests(baseline, comparison);
      const baselineWaterfall = extractWaterfall(baseline);
      const comparisonWaterfall = extractWaterfall(comparison);

      expect(diff.baselineRequestCount).toBe(baselineWaterfall.requests.length);
      expect(diff.comparisonRequestCount).toBe(comparisonWaterfall.requests.length);
      expect(diff.baselineTransferSize).toBe(baselineWaterfall.totalTransferSize);
      expect(diff.comparisonTransferSize).toBe(comparisonWaterfall.totalTransferSize);
      expect(diff.transferSizeDelta).toBe(
        comparisonWaterfall.totalTransferSize - baselineWaterfall.totalTransferSize,
      );
      expect(diff.baselineThirdPartyCount).toBe(baselineWaterfall.thirdPartyCount);
      expect(diff.comparisonThirdPartyCount).toBe(comparisonWaterfall.thirdPartyCount);
      expect(diff.baselineThirdPartyCount).toBe(1);
      expect(diff.comparisonThirdPartyCount).toBe(2);
    });
  });

  describe("third-party marking", () => {
    it("marks a request third-party when EITHER side did", () => {
      // Same URL, but only the comparison run's entity table places it as a
      // third party — the mark must survive the join.
      const firstParty = lhr([request({ url: "https://cdn.example.com/x.js", entity: "example.com" })], {
        entities: [
          { name: "example.com", origins: ["https://example.com", "https://cdn.example.com"], isFirstParty: true },
        ],
      });
      const thirdParty = lhr([request({ url: "https://cdn.example.com/x.js", entity: "Some CDN" })], {
        entities: [{ name: "Some CDN", origins: ["https://cdn.example.com"] }],
      });

      // Nothing measurable moved, so the pair is only counted…
      expect(diffRequests(firstParty, thirdParty).unchangedCount).toBe(1);
      // …and the mark itself is read back from a pair where something did move.
      const moved = diffRequests(
        firstParty,
        lhr([request({ url: "https://cdn.example.com/x.js", entity: "Some CDN", transferSize: 2000 })], {
          entities: [{ name: "Some CDN", origins: ["https://cdn.example.com"] }],
        }),
      );
      expect(moved.changed[0]).toMatchObject({ thirdParty: true, status: "regressed" });
    });

    it("marks an added third-party request from the comparison side alone", () => {
      const diff = diffRequests(
        lhr([request()]),
        lhr([request(), request({ url: "https://analytics.google.com/g/collect", entity: "Google Analytics" })]),
      );

      expect(diff.added[0]).toMatchObject({ host: "analytics.google.com", thirdParty: true });
    });
  });

  describe("display fields", () => {
    it("prefers the comparison side's resource type, falling back to the baseline's", () => {
      const diff = diffRequests(
        lhr([request({ resourceType: "Script", transferSize: 100 })]),
        lhr([request({ resourceType: "Fetch", transferSize: 200 })]),
      );
      expect(diff.changed[0].resourceType).toBe("Fetch");

      const missing = diffRequests(
        lhr([request({ resourceType: "Script", transferSize: 100 })]),
        lhr([request({ resourceType: undefined, transferSize: 200 })]),
      );
      expect(missing.changed[0].resourceType).toBe("Script");
    });

    it("names a repeated URL by the first occurrence that carries a type", () => {
      // Real reports really do this: the same RSC URL arrives twice with two
      // different `resourceType`s, and a row can carry none at all — so an
      // aggregate cannot assume the occurrences agree.
      const diff = diffRequests(
        lhr([]),
        lhr([
          request({ url: "https://example.com/rsc", resourceType: undefined, transferSize: 0 }),
          request({ url: "https://example.com/rsc", resourceType: "Fetch", transferSize: 1923 }),
        ]),
      );

      expect(diff.added[0]).toMatchObject({
        resourceType: "Fetch",
        comparisonCount: 2,
        comparisonTransferSize: 1923,
      });
    });

    it("carries the Phase D row's already-sanitised path and the raw url beside it", () => {
      const hostile = "ht!tp://evil‮gnp.exe";
      const diff = diffRequests(lhr([]), lhr([request({ url: hostile })]));

      expect(diff.added[0].url).toBe(hostile);
      expect(diff.added[0].path).toBe("ht!tp://evilgnp.exe");
      expect(diff.added[0].host).toBe("");
    });
  });

  describe("ordering", () => {
    it("sorts added and removed by transfer size, largest first", () => {
      const diff = diffRequests(
        lhr([
          request({ url: "https://example.com/gone-small.js", transferSize: 10 }),
          request({ url: "https://example.com/gone-big.js", transferSize: 9000 }),
        ]),
        lhr([
          request({ url: "https://example.com/new-mid.js", transferSize: 500 }),
          request({ url: "https://example.com/new-big.js", transferSize: 7000 }),
          request({ url: "https://example.com/new-small.js", transferSize: 5 }),
        ]),
      );

      expect(diff.added.map((delta) => delta.url)).toEqual([
        "https://example.com/new-big.js",
        "https://example.com/new-mid.js",
        "https://example.com/new-small.js",
      ]);
      expect(diff.removed.map((delta) => delta.url)).toEqual([
        "https://example.com/gone-big.js",
        "https://example.com/gone-small.js",
      ]);
    });

    it("ranks a request with no recorded size below every measured one", () => {
      const diff = diffRequests(
        lhr([]),
        lhr([
          request({ url: "https://example.com/unknown.js", transferSize: -1 }),
          request({ url: "https://example.com/tiny.js", transferSize: 1 }),
        ]),
      );

      expect(diff.added.map((delta) => delta.url)).toEqual([
        "https://example.com/tiny.js",
        "https://example.com/unknown.js",
      ]);
    });

    it("sorts changed by growth, largest regression first", () => {
      const diff = diffRequests(
        lhr([
          request({ url: "https://example.com/a.js", transferSize: 1000 }),
          request({ url: "https://example.com/b.js", transferSize: 1000 }),
          request({ url: "https://example.com/c.js", transferSize: 1000 }),
        ]),
        lhr([
          request({ url: "https://example.com/a.js", transferSize: 1200 }),
          request({ url: "https://example.com/b.js", transferSize: 200 }),
          request({ url: "https://example.com/c.js", transferSize: 9000 }),
        ]),
      );

      expect(diff.changed.map((delta) => [delta.url, delta.transferDelta])).toEqual([
        ["https://example.com/c.js", 8000],
        ["https://example.com/a.js", 200],
        ["https://example.com/b.js", -800],
      ]);
    });

    it("ranks a count-only change after every measured one", () => {
      const diff = diffRequests(
        lhr([
          request({ url: "https://example.com/unknown.js", transferSize: -1 }),
          request({ url: "https://example.com/shrank.js", transferSize: 5000 }),
        ]),
        lhr([
          request({ url: "https://example.com/unknown.js", transferSize: -1 }),
          request({ url: "https://example.com/unknown.js", transferSize: -1 }),
          request({ url: "https://example.com/shrank.js", transferSize: 100 }),
        ]),
      );

      expect(diff.changed.map((delta) => delta.url)).toEqual([
        "https://example.com/shrank.js",
        "https://example.com/unknown.js",
      ]);
    });

    it("breaks every tie on the URL, so the output is stable across runs", () => {
      const urls = [
        "https://example.com/b.js",
        "https://example.com/a.js",
        "https://example.com/c.js",
      ];
      const addedInOneOrder = diffRequests(
        lhr([]),
        lhr(urls.map((url) => request({ url, transferSize: 1000 }))),
      );
      const addedInAnother = diffRequests(
        lhr([]),
        lhr([...urls].reverse().map((url) => request({ url, transferSize: 1000 }))),
      );

      expect(addedInOneOrder.added.map((delta) => delta.url)).toEqual([
        "https://example.com/a.js",
        "https://example.com/b.js",
        "https://example.com/c.js",
      ]);
      expect(addedInAnother.added.map((delta) => delta.url)).toEqual(
        addedInOneOrder.added.map((delta) => delta.url),
      );
    });

    it("breaks a growth tie on the count movement, then on the URL", () => {
      const diff = diffRequests(
        lhr([
          request({ url: "https://example.com/z.js", transferSize: -1 }),
          request({ url: "https://example.com/y.js", transferSize: -1 }),
          request({ url: "https://example.com/x.js", transferSize: -1 }),
        ]),
        lhr([
          request({ url: "https://example.com/z.js", transferSize: -1 }),
          request({ url: "https://example.com/z.js", transferSize: -1 }),
          request({ url: "https://example.com/z.js", transferSize: -1 }),
          request({ url: "https://example.com/y.js", transferSize: -1 }),
          request({ url: "https://example.com/y.js", transferSize: -1 }),
          request({ url: "https://example.com/x.js", transferSize: -1 }),
          request({ url: "https://example.com/x.js", transferSize: -1 }),
        ]),
      );

      expect(diff.changed.map((delta) => [delta.url, delta.comparisonCount])).toEqual([
        ["https://example.com/z.js", 3],
        ["https://example.com/x.js", 2],
        ["https://example.com/y.js", 2],
      ]);
    });
  });

  describe("tolerance", () => {
    const hostile: [string, LighthouseResult][] = [
      ["empty object", {}],
      ["null audits", { audits: null }],
      ["audits as a string", { audits: "nope" }],
      ["null details", { audits: { "network-requests": { details: null } } }],
      ["items as a string", { audits: { "network-requests": { details: { items: "nope" } } } }],
      ["non-string urls", { audits: { "network-requests": { details: { items: [{ url: 42 }] } } } }],
      ["entities as a string", { ...lhr([request()]), entities: "example.com" }],
    ];

    for (const [name, input] of hostile) {
      it(`never throws: ${name}`, () => {
        expect(() => diffRequests(input, lhr([request()]))).not.toThrow();
        expect(() => diffRequests(lhr([request()]), input)).not.toThrow();
        expect(() => diffRequests(input, input)).not.toThrow();
      });
    }

    it("does not mutate either report it reads", () => {
      const baseline = lhr([request({ transferSize: 100 })]);
      const comparison = lhr([request({ transferSize: 200 }), request({ url: "https://x.example/y" })]);
      const before = [JSON.stringify(baseline), JSON.stringify(comparison)];

      diffRequests(baseline, comparison);

      expect([JSON.stringify(baseline), JSON.stringify(comparison)]).toEqual(before);
    });
  });
});

// --- Real stored reports ----------------------------------------------------
//
// `data/` is machine-local and gitignored, so these are opt-in: a fresh checkout
// has no reports and the whole block skips. Where they run, they diff the
// reports this install actually produced — which is how Phase D found the `-1`
// sentinel that synthetic fixtures had no reason to contain. Assertions are
// therefore RELATIONS between real numbers (the diff's totals against each
// side's own waterfall, exact deltas against a mutated copy) rather than
// hard-coded byte counts, which would only be true of one machine's reports.

const REPORTS_DIR = path.resolve(process.cwd(), "data", "reports");

function readReport(file: string): LighthouseResult | null {
  try {
    return JSON.parse(readFileSync(path.join(REPORTS_DIR, file), "utf8")) as LighthouseResult;
  } catch {
    return null;
  }
}

interface RealReports {
  /** Two reports of the SAME final URL — a diff a user would actually ask for. */
  pair: { baseline: LighthouseResult; comparison: LighthouseResult; url: string } | null;
  /** A report that fetched some URL more than once. */
  withDuplicates: LighthouseResult | null;
  /** A report carrying no usable `network-requests` audit at all. */
  withoutAudit: LighthouseResult | null;
}

/** Scan the stored reports once, keeping only the few fixtures below need. */
function collectRealReports(): RealReports {
  const found: RealReports = { pair: null, withDuplicates: null, withoutAudit: null };
  let files: string[];
  try {
    files = readdirSync(REPORTS_DIR)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return found;
  }

  // Only file NAMES are held while scanning; a matched baseline is re-read on
  // demand, so at most a handful of ~690 KB reports are ever resident.
  const fileByUrl = new Map<string, string>();

  for (const file of files) {
    if (found.pair && found.withDuplicates && found.withoutAudit) break;

    const report = readReport(file);
    if (report === null) continue;

    const waterfall = extractWaterfall(report);
    if (waterfall.unavailable) {
      found.withoutAudit ??= report;
      continue;
    }

    if (found.withDuplicates === null) {
      const seen = new Set<string>();
      for (const row of waterfall.requests) {
        if (seen.has(row.url)) {
          found.withDuplicates = report;
          break;
        }
        seen.add(row.url);
      }
    }

    const url = report.finalDisplayedUrl ?? report.finalUrl;
    if (typeof url !== "string" || url === "") continue;
    const earlier = fileByUrl.get(url);
    if (earlier === undefined) {
      fileByUrl.set(url, file);
      continue;
    }
    if (found.pair === null) {
      const baseline = readReport(earlier);
      if (baseline !== null) found.pair = { baseline, comparison: report, url };
    }
  }

  return found;
}

const real = collectRealReports();

describe.skipIf(real.pair === null)("diffRequests against real stored reports", () => {
  const pair = real.pair!;

  it("reports a report diffed against itself as entirely unchanged", () => {
    const waterfall = extractWaterfall(pair.baseline);
    const distinctUrls = new Set(waterfall.requests.map((row) => row.url)).size;

    const diff = diffRequests(pair.baseline, pair.baseline);

    expect(diff.unavailable).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(distinctUrls);
    expect(diff.requestCountDelta).toBe(0);
    expect(diff.transferSizeDelta).toBe(0);
    expect(diff.baselineRequestCount).toBe(waterfall.requests.length);
    expect(diff.baselineTransferSize).toBe(waterfall.totalTransferSize);
    expect(diff.baselineTransferSize).toBeGreaterThan(0);
  });

  it("reconciles its totals with both sides' waterfall projections", () => {
    const baselineWaterfall = extractWaterfall(pair.baseline);
    const comparisonWaterfall = extractWaterfall(pair.comparison);

    const diff = diffRequests(pair.baseline, pair.comparison);

    expect(diff.baselineRequestCount).toBe(baselineWaterfall.requests.length);
    expect(diff.comparisonRequestCount).toBe(comparisonWaterfall.requests.length);
    expect(diff.baselineTransferSize).toBe(baselineWaterfall.totalTransferSize);
    expect(diff.comparisonTransferSize).toBe(comparisonWaterfall.totalTransferSize);
    expect(diff.requestCountDelta).toBe(
      comparisonWaterfall.requests.length - baselineWaterfall.requests.length,
    );
    expect(diff.transferSizeDelta).toBe(
      comparisonWaterfall.totalTransferSize - baselineWaterfall.totalTransferSize,
    );
    expect(diff.baselineThirdPartyCount).toBe(baselineWaterfall.thirdPartyCount);
    expect(diff.comparisonThirdPartyCount).toBe(comparisonWaterfall.thirdPartyCount);
  });

  it("accounts for every URL exactly once, and for every request in the counts", () => {
    const baselineWaterfall = extractWaterfall(pair.baseline);
    const comparisonWaterfall = extractWaterfall(pair.comparison);
    const baselineUrls = new Set(baselineWaterfall.requests.map((row) => row.url));
    const comparisonUrls = new Set(comparisonWaterfall.requests.map((row) => row.url));
    const union = new Set([...baselineUrls, ...comparisonUrls]);

    const diff = diffRequests(pair.baseline, pair.comparison);

    expect(
      diff.added.length + diff.removed.length + diff.changed.length + diff.unchangedCount,
    ).toBe(union.size);

    // The lists are disjoint, and each names a URL only the side it claims has.
    for (const delta of diff.added) {
      expect(baselineUrls.has(delta.url)).toBe(false);
      expect(comparisonUrls.has(delta.url)).toBe(true);
      expect(delta.baselineCount).toBe(0);
      expect(delta.transferDelta).toBeNull();
    }
    for (const delta of diff.removed) {
      expect(comparisonUrls.has(delta.url)).toBe(false);
      expect(delta.comparisonCount).toBe(0);
    }
    for (const delta of diff.changed) {
      expect(delta.status === "regressed" || delta.status === "improved").toBe(true);
      expect(delta.baselineCount).toBeGreaterThan(0);
      expect(delta.comparisonCount).toBeGreaterThan(0);
    }

    // Per-URL counts sum back to the run's own request count.
    const countedComparison = [...diff.added, ...diff.changed].reduce(
      (total, delta) => total + delta.comparisonCount,
      0,
    );
    const unchangedComparison = comparisonWaterfall.requests.filter(
      (row) =>
        !diff.added.some((delta) => delta.url === row.url) &&
        !diff.changed.some((delta) => delta.url === row.url),
    ).length;
    expect(countedComparison + unchangedComparison).toBe(comparisonWaterfall.requests.length);
  });

  it("orders the real lists by size and by growth", () => {
    const diff = diffRequests(pair.baseline, pair.comparison);
    const rank = (size: number | null): number => size ?? -1;

    for (let i = 1; i < diff.added.length; i += 1) {
      expect(rank(diff.added[i - 1].comparisonTransferSize)).toBeGreaterThanOrEqual(
        rank(diff.added[i].comparisonTransferSize),
      );
    }
    for (let i = 1; i < diff.removed.length; i += 1) {
      expect(rank(diff.removed[i - 1].baselineTransferSize)).toBeGreaterThanOrEqual(
        rank(diff.removed[i].baselineTransferSize),
      );
    }
    const measured = diff.changed
      .map((delta) => delta.transferDelta)
      .filter((delta): delta is number => delta !== null);
    for (let i = 1; i < measured.length; i += 1) {
      expect(measured[i - 1]).toBeGreaterThanOrEqual(measured[i]);
    }
    // Unmeasured rows all sit after the measured ones.
    const firstUnmeasured = diff.changed.findIndex((delta) => delta.transferDelta === null);
    if (firstUnmeasured !== -1) {
      expect(diff.changed.slice(firstUnmeasured).every((d) => d.transferDelta === null)).toBe(true);
    }
  });

  it("is deterministic across repeated diffs of the same pair", () => {
    const first = diffRequests(pair.baseline, pair.comparison);
    const second = diffRequests(pair.baseline, pair.comparison);
    expect(second).toEqual(first);
  });

  it("reports exact deltas against a mutated copy of a real report", () => {
    const waterfall = extractWaterfall(pair.baseline);
    // Three URLs the report fetched exactly once, each with recorded bytes, so
    // the mutations below are unambiguous.
    const once = waterfall.requests.filter(
      (row) =>
        row.transferSize !== null &&
        row.transferSize > 0 &&
        waterfall.requests.filter((other) => other.url === row.url).length === 1,
    );
    expect(once.length).toBeGreaterThanOrEqual(3);
    const [grown, duplicated, dropped] = once;

    const mutated = structuredClone(pair.baseline) as LighthouseResult;
    const items = (mutated.audits as Record<string, { details: { items: Record<string, unknown>[] } }>)[
      "network-requests"
    ].details.items;

    const grownItem = items.find((item) => item.url === grown.url)!;
    grownItem.transferSize = (grownItem.transferSize as number) + 4096;
    items.push({ ...items.find((item) => item.url === duplicated.url)! });
    const droppedIndex = items.findIndex((item) => item.url === dropped.url);
    items.splice(droppedIndex, 1);
    items.push({ ...grownItem, url: "https://example.invalid/newly-added.js", transferSize: 12_345 });

    const diff = diffRequests(pair.baseline, mutated);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]).toMatchObject({
      url: "https://example.invalid/newly-added.js",
      comparisonTransferSize: 12_345,
      baselineTransferSize: null,
      transferDelta: null,
      status: "added",
    });
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]).toMatchObject({
      url: dropped.url,
      baselineTransferSize: dropped.transferSize,
      comparisonTransferSize: null,
      status: "removed",
    });
    expect(diff.changed).toHaveLength(2);
    expect(diff.changed.find((delta) => delta.url === grown.url)).toMatchObject({
      transferDelta: 4096,
      baselineTransferSize: grown.transferSize,
      comparisonTransferSize: (grown.transferSize ?? 0) + 4096,
      status: "regressed",
    });
    expect(diff.changed.find((delta) => delta.url === duplicated.url)).toMatchObject({
      baselineCount: 1,
      comparisonCount: 2,
      baselineTransferSize: duplicated.transferSize,
      comparisonTransferSize: (duplicated.transferSize ?? 0) * 2,
      transferDelta: duplicated.transferSize,
      status: "regressed",
    });

    expect(diff.requestCountDelta).toBe(1);
    expect(diff.transferSizeDelta).toBe(
      4096 + 12_345 + (duplicated.transferSize ?? 0) - (dropped.transferSize ?? 0),
    );
    expect(diff.baselineTransferSize).toBe(waterfall.totalTransferSize);
    expect(diff.comparisonTransferSize).toBe(extractWaterfall(mutated).totalTransferSize);
  });
});

describe.skipIf(real.withDuplicates === null)("real reports that fetched a URL twice", () => {
  it("counts the real occurrences and classifies a dropped one on the count", () => {
    const report = real.withDuplicates!;
    const waterfall = extractWaterfall(report);
    const counts = new Map<string, number>();
    for (const row of waterfall.requests) counts.set(row.url, (counts.get(row.url) ?? 0) + 1);
    const [repeatedUrl, occurrences] = [...counts].find(([, count]) => count > 1)!;

    /** The contract's summed size for one side's occurrences of that URL. */
    const sumFor = (rows: { url: string; transferSize: number | null }[]): number | null => {
      const measured = rows
        .filter((row) => row.url === repeatedUrl)
        .map((row) => row.transferSize)
        .filter((size): size is number => size !== null);
      return measured.length === 0 ? null : measured.reduce((total, size) => total + size, 0);
    };

    const mutated = structuredClone(report) as LighthouseResult;
    const items = (mutated.audits as Record<string, { details: { items: Record<string, unknown>[] } }>)[
      "network-requests"
    ].details.items;
    items.splice(
      items.findIndex((item) => item.url === repeatedUrl),
      1,
    );

    const diff = diffRequests(report, mutated);
    const baselineSum = sumFor(waterfall.requests);
    const comparisonSum = sumFor(extractWaterfall(mutated).requests);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({
      url: repeatedUrl,
      baselineCount: occurrences,
      comparisonCount: occurrences - 1,
      baselineTransferSize: baselineSum,
      comparisonTransferSize: comparisonSum,
      // Improved on the COUNT — and in this repo's data the bytes did not even
      // move, because the dropped occurrence was a 0-byte cache hit.
      status: "improved",
    });
    expect(diff.changed[0].transferDelta).toBe(
      baselineSum === null || comparisonSum === null ? null : comparisonSum - baselineSum,
    );
    expect(diff.requestCountDelta).toBe(-1);
  });
});

describe.skipIf(real.withoutAudit === null || real.pair === null)(
  "a real report that predates the network-requests audit",
  () => {
    it("degrades the whole diff rather than reporting every request as removed", () => {
      const legacy = real.withoutAudit!;
      const modern = real.pair!.comparison;

      expect(extractWaterfall(modern).requests.length).toBeGreaterThan(0);
      expect(diffRequests(legacy, modern)).toEqual(UNAVAILABLE);
      expect(diffRequests(modern, legacy)).toEqual(UNAVAILABLE);
    });
  },
);

describe("page-authored URL strings are bounded (Phase E security review, L4)", () => {
  /** A URL far longer than any real one, of the shape an audited page can mint. */
  const HUGE = `https://evil.test/${"a".repeat(400_000)}`;

  it("clamps url, path and host on an added row", () => {
    const diff = diffRequests(
      lhr([]),
      lhr([request({ url: HUGE, transferSize: 10 })]),
    );

    const row = diff.added[0];
    expect(row).toBeDefined();
    // Row COUNT was always bounded; the strings inside a row were not, which is
    // how one response could be bounded only by the size of the reports.
    expect(row.url.length).toBeLessThanOrEqual(MAX_DIFF_URL);
    expect(row.path.length).toBeLessThanOrEqual(MAX_DIFF_URL);
    expect(row.host.length).toBeLessThanOrEqual(MAX_DIFF_URL);
    // Truncated, not emptied — the row still identifies something.
    expect(row.url.startsWith("https://evil.test/aaa")).toBe(true);
  });

  it("clamps a removed row too", () => {
    const diff = diffRequests(
      lhr([request({ url: HUGE, transferSize: 10 })]),
      lhr([]),
    );
    expect(diff.removed[0].url.length).toBeLessThanOrEqual(MAX_DIFF_URL);
  });

  it("clamps a changed row, and the clamp never unmatches the two sides", () => {
    const diff = diffRequests(
      lhr([request({ url: HUGE, transferSize: 10 })]),
      lhr([request({ url: HUGE, transferSize: 4096 })]),
    );

    // The aggregation key is the RAW url (the maps are built before the clamp),
    // so an over-long URL present on both sides is still recognised as one URL —
    // it must not appear as one added plus one removed.
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].transferDelta).toBe(4086);
    expect(diff.changed[0].url.length).toBeLessThanOrEqual(MAX_DIFF_URL);
  });

  it("leaves a normal URL untouched", () => {
    const url = "https://cdn.example.test/static/app.js?v=2";
    const diff = diffRequests(
      lhr([]),
      lhr([request({ url, transferSize: 10 })]),
    );
    expect(diff.added[0].url).toBe(url);
  });
});
