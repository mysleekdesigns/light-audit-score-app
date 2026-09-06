/**
 * Tests for the client report renderer (ROADMAP Phase H).
 *
 * Two things are being proved here, and only one of them is layout.
 *
 * 1. **The document is genuinely self-contained.** Every claim the module makes
 *    about offline rendering is asserted rather than assumed: no `<script`, no
 *    `<link `, and no `http(s)` URL inside any `src`/`href` attribute. These are
 *    cheap assertions that would catch the single most expensive regression —
 *    a report that renders as an unstyled dump on a client's machine, or one that
 *    phones home from it.
 *
 * 2. **Escaping holds under hostile input.** Most of what this renderer prints was
 *    written by the AUDITED SITE (see the SECURITY NOTE on `./report-model.ts`),
 *    so the fixtures below feed it the things a hostile page would actually serve:
 *    an `<img onerror>` payload in a URL, quotes in an error message, a
 *    `javascript:` logo, a remote logo, a run id that is not id-shaped.
 *
 * Vitest runs `environment: "node"` here, so there is no DOM to parse the output
 * with. That is fine and deliberate: string assertions test exactly what ships,
 * whereas a DOM round-trip would normalise away the very defects being hunted.
 */

import { describe, expect, it } from "vitest";

import { REPORT_CSS } from "./report-css";
import {
  escapeHtml,
  renderClientReport,
  REPORT_META_CSP,
  safeAnchorId,
  safeImageDataUri,
} from "./report-html";
import {
  ABSENT_VALUE,
  CLIENT_REPORT_VERSION,
  EMPTY_BRANDING,
  type ClientReport,
  type ReportBranding,
  type ReportPage,
  type TraceOmission,
} from "./report-model";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A 1x1 transparent GIF — a real `data:` image, small enough to inline here. */
const TINY_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** The payload a hostile page would put in a URL, a title or an error message. */
const XSS = `<img src=x onerror=alert(1)>"'`;

function makePage(overrides: Partial<ReportPage> = {}): ReportPage {
  return {
    runId: "run0001",
    url: "https://example.test/pricing",
    finalUrl: "",
    device: "mobile",
    source: "local",
    status: "done",
    errorMessage: null,
    runs: 3,
    fetchTime: "2026-09-05T09:15:00.000Z",
    scores: {
      performance: 74,
      accessibility: 96,
      "best-practices": 92,
      seo: 100,
    },
    overall: 90.5,
    clears: false,
    metrics: [
      {
        id: "largest-contentful-paint",
        abbr: "LCP",
        label: "Largest Contentful Paint",
        displayValue: "2.4 s",
        numericValue: 2400,
        score: 0.62,
      },
      {
        id: "cumulative-layout-shift",
        abbr: "CLS",
        label: "Cumulative Layout Shift",
        displayValue: "0.01",
        numericValue: 0.01,
        score: 0.99,
      },
    ],
    opportunities: [
      {
        id: "unused-javascript",
        title: "Reduce unused JavaScript",
        description: "Remove dead code from bundles to cut network and parse cost.",
        savingsMs: 450,
        displayValue: "Est savings of 0.45 s",
        score: 0.32,
      },
    ],
    waterfall: {
      requests: [
        {
          path: "/",
          host: "example.test",
          resourceType: "Document",
          transferSize: 18_400,
          startTime: 0,
          endTime: 240,
          renderBlocking: false,
          thirdParty: false,
        },
        {
          path: "/static/app.js",
          host: "cdn.example.test",
          resourceType: "Script",
          transferSize: 412_000,
          startTime: 260,
          // A 2 ms request: the row that would vanish without a minimum bar width.
          endTime: 262,
          renderBlocking: true,
          thirdParty: true,
        },
        {
          path: "/never-finished",
          host: "example.test",
          resourceType: "Fetch",
          transferSize: null,
          startTime: null,
          endTime: null,
          renderBlocking: false,
          thirdParty: false,
        },
      ],
      totalRequests: 312,
      totalTransferSize: 2_100_000,
      thirdPartyCount: 41,
      timelineMs: 4200,
    },
    filmstrip: {
      frames: [
        { timingMs: 300, data: TINY_GIF, isLcp: false },
        { timingMs: 1200, data: TINY_GIF, isLcp: true },
      ],
      lcpMs: 1200,
      timelineMs: 1200,
    },
    traceOmission: null,
    ...overrides,
  };
}

function makeReport(overrides: Partial<ClientReport> = {}): ClientReport {
  return {
    version: CLIENT_REPORT_VERSION,
    batchId: "8b1f0f6e-6f3f-4a35-9f7f-0c2a1d9c3e11",
    shortId: "8b1f0f6e",
    generatedAt: "2026-09-06T14:22:00.000Z",
    branding: { ...EMPTY_BRANDING },
    provenance: {
      source: "local",
      device: "Mobile",
      throttling: "Simulated",
      runs: 3,
      lighthouseVersion: "13.0.1",
      createdAt: "2026-09-05T09:00:00.000Z",
      status: "completed",
      total: 5,
    },
    thresholds: {
      performance: 90,
      accessibility: 90,
      "best-practices": 90,
      seo: 90,
      "agentic-browsing": 90,
    },
    summary: {
      averageScores: {
        performance: 74,
        accessibility: 96,
        "best-practices": 92,
        seo: 100,
      },
      overall: 90.5,
      passFail: {
        performance: { pass: 0, fail: 1, total: 1 },
        accessibility: { pass: 1, fail: 0, total: 1 },
        "best-practices": { pass: 1, fail: 0, total: 1 },
        seo: { pass: 1, fail: 0, total: 1 },
        "agentic-browsing": { pass: 0, fail: 0, total: 0 },
      },
      clearing: { clearing: 0, total: 1 },
      best: { runId: "run0001", url: "https://example.test/pricing", overall: 90.5 },
      worst: { runId: "run0001", url: "https://example.test/pricing", overall: 90.5 },
      pageCount: 1,
      errorCount: 0,
    },
    pages: [makePage()],
    notes: ["Showing 3 of 312 requests for each page."],
    ...overrides,
  };
}

/** Every `src="…"` / `href="…"` value in a document, in source order. */
function attributeUrls(html: string): string[] {
  return [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)].map((match) => match[1]);
}

/**
 * The markup only, with the inlined stylesheet cut away.
 *
 * Needed because the whole stylesheet ships inside the same string: asserting
 * that a document does NOT contain `brand-logo` or `ring-arc` would otherwise
 * always fail on the CSS selector of that name, whatever the markup did. Any
 * assertion about what was or was not RENDERED has to look here.
 */
function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body>"));
}

/* -------------------------------------------------------------------------- */
/* Escaping helpers                                                            */
/* -------------------------------------------------------------------------- */

describe("escapeHtml", () => {
  it("escapes all five characters that can break out of text or an attribute", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("escapes the ampersand first, so its own output is not re-escaped", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("is total for values a JSON report file could carry", () => {
    expect(escapeHtml(undefined as unknown as string)).toBe("");
    expect(escapeHtml(42 as unknown as string)).toBe("42");
  });
});

describe("safeAnchorId", () => {
  it("accepts an id-shaped run id and prefixes it", () => {
    expect(safeAnchorId("run_01-AB")).toBe("run-run_01-AB");
  });

  it("rejects anything that is not [A-Za-z0-9_-]+", () => {
    expect(safeAnchorId('x" onload="alert(1)')).toBeNull();
    expect(safeAnchorId("has spaces")).toBeNull();
    expect(safeAnchorId("dots.and:colons")).toBeNull();
    expect(safeAnchorId("")).toBeNull();
  });
});

describe("safeImageDataUri", () => {
  it("accepts a data: image URI", () => {
    expect(safeImageDataUri(TINY_GIF)).toBe(TINY_GIF);
    // SVG is refused here too, so the renderer, the assembler and the settings
    // store state ONE policy rather than three (Phase H security review).
    expect(safeImageDataUri("data:image/svg+xml,<svg/>")).toBeNull();
    expect(safeImageDataUri("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(safeImageDataUri("data:image/jpeg;base64,/9j/4AAQ")).toBe(
      "data:image/jpeg;base64,/9j/4AAQ",
    );
  });

  it("rejects every scheme that is not a data: image", () => {
    expect(safeImageDataUri("javascript:alert(1)")).toBeNull();
    expect(safeImageDataUri("https://evil.test/logo.png")).toBeNull();
    expect(safeImageDataUri("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeImageDataUri(" data:image/png;base64,AAAA")).toBeNull();
    expect(safeImageDataUri("")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Self-containment                                                            */
/* -------------------------------------------------------------------------- */

describe("renderClientReport — self-containment", () => {
  const html = renderClientReport(makeReport());

  it("is a complete HTML document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("ships no script of any kind", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("links no external stylesheet and inlines the whole one it uses", () => {
    expect(html).not.toContain("<link ");
    expect(html).toContain("<style>");
    expect(html).toContain("--font-mono");
  });

  it("makes no request for a remote asset", () => {
    const urls = attributeUrls(html);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toMatch(/^https?:/i);
      expect(url).not.toMatch(/^\/\//);
    }
  });

  it("uses only data: images and intra-document anchors", () => {
    for (const url of attributeUrls(html)) {
      expect(url.startsWith("data:image/") || url.startsWith("#")).toBe(true);
    }
  });

  it("declares a CSP that grants no script-src", () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy"`);
    expect(REPORT_META_CSP).not.toContain("script-src");
    expect(REPORT_META_CSP).toContain("default-src 'none'");
    expect(REPORT_META_CSP).toContain("style-src 'unsafe-inline'");
    expect(REPORT_META_CSP).toContain("img-src data:");
    expect(REPORT_META_CSP).toContain("font-src data:");
    expect(REPORT_META_CSP).toContain("connect-src 'none'");
    expect(REPORT_META_CSP).toContain("form-action 'none'");
    expect(REPORT_META_CSP).toContain("base-uri 'none'");
    // frame-ancestors is ignored in a <meta> policy; claiming it would mislead.
    expect(REPORT_META_CSP).not.toContain("frame-ancestors");
  });
});

/* -------------------------------------------------------------------------- */
/* Escaping under hostile input                                                */
/* -------------------------------------------------------------------------- */

describe("renderClientReport — page-authored content", () => {
  const html = renderClientReport(
    makeReport({
      pages: [
        makePage({
          url: `https://evil.test/${XSS}`,
          finalUrl: `https://evil.test/final${XSS}`,
          waterfall: {
            requests: [
              {
                path: `/${XSS}`,
                host: `evil.test${XSS}`,
                resourceType: XSS,
                transferSize: 10,
                startTime: 1,
                endTime: 2,
                renderBlocking: false,
                thirdParty: true,
              },
            ],
            totalRequests: 1,
            totalTransferSize: 10,
            thirdPartyCount: 1,
            timelineMs: 1000,
          },
        }),
      ],
      summary: {
        ...makeReport().summary,
        best: { runId: "run0001", url: `https://evil.test/${XSS}`, overall: 12 },
        worst: null,
      },
      notes: [XSS],
    }),
  );

  it("renders an injected tag as text, never as markup", () => {
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes both quote characters, so nothing escapes an attribute", () => {
    expect(html).toContain("&quot;&#39;");
  });

  it("never emits an href for a page-derived URL", () => {
    for (const url of attributeUrls(html)) {
      expect(url).not.toContain("evil.test");
    }
  });

  it("still renders a failing run's message as inert text", () => {
    const failed = renderClientReport(
      makeReport({
        pages: [
          makePage({
            status: "error",
            errorMessage: XSS,
            runs: null,
            fetchTime: null,
            scores: {},
            overall: null,
            waterfall: null,
            filmstrip: null,
            traceOmission: "no-report",
          }),
        ],
      }),
    );
    expect(failed).not.toContain("<img src=x");
    expect(failed).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(failed).toContain("Run failed");
  });
});

/* -------------------------------------------------------------------------- */
/* Branding                                                                    */
/* -------------------------------------------------------------------------- */

describe("renderClientReport — branding", () => {
  function withBranding(branding: Partial<ReportBranding>): string {
    return renderClientReport(
      makeReport({ branding: { ...EMPTY_BRANDING, showDate: false, ...branding } }),
    );
  }

  it("omits the whole header block when nothing is configured and the date is off", () => {
    const body = bodyOf(withBranding({}));
    expect(body).not.toContain('class="brand"');
    expect(body).not.toContain("brand-title");
    // The report's own identity still renders — only the branding block is gone.
    expect(body).toContain("LightAudit Score — client report");
  });

  it("renders the block when only the date is enabled", () => {
    const html = withBranding({ showDate: true });
    expect(html).toContain('class="brand"');
    expect(html).toContain("6 September 2026");
  });

  it("renders a title, subtitle and data: logo, all escaped", () => {
    const html = withBranding({
      title: `Acme & Co "Audits"`,
      subtitle: "Quarterly review",
      logoDataUri: TINY_GIF,
    });
    expect(html).toContain("Acme &amp; Co &quot;Audits&quot;");
    expect(html).toContain("Quarterly review");
    expect(html).toContain(`src="${TINY_GIF}"`);
    // A branded report puts the auditor's name in the tab title too.
    expect(html).toContain("<title>Acme &amp; Co &quot;Audits&quot; — Lighthouse report");
  });

  it("drops a javascript: logo rather than rendering it", () => {
    const body = bodyOf(withBranding({ title: "Acme", logoDataUri: "javascript:alert(1)" }));
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("brand-logo");
    expect(body).toContain("Acme");
  });

  it("drops a remote logo rather than rendering it", () => {
    const body = bodyOf(withBranding({ title: "Acme", logoDataUri: "https://evil.test/logo.png" }));
    expect(body).not.toContain("evil.test");
    expect(body).not.toContain("brand-logo");
  });
});

/* -------------------------------------------------------------------------- */
/* Score rings                                                                 */
/* -------------------------------------------------------------------------- */

describe("renderClientReport — score rings", () => {
  it("draws an unscored gauge as the absent value, not a zero-filled ring", () => {
    const html = renderClientReport(
      makeReport({
        summary: {
          ...makeReport().summary,
          averageScores: { performance: null, accessibility: null },
          overall: null,
          best: null,
          worst: null,
        },
        pages: [makePage({ scores: { performance: null }, overall: null })],
      }),
    );
    expect(bodyOf(html)).toContain("ring--none");
    // No arc at all — an arc of length zero is indistinguishable from a score of 0.
    expect(bodyOf(html)).not.toContain("ring-arc");
    expect(html).toContain(`>${ABSENT_VALUE}</text>`);
    expect(html).toContain("no score recorded");
  });

  it("draws a scored gauge with an arc and an out-of-100 label", () => {
    const html = renderClientReport(makeReport());
    expect(bodyOf(html)).toContain("ring--good");
    expect(bodyOf(html)).toContain("ring-arc");
    expect(html).toContain("stroke-dasharray=");
    expect(html).toContain("Performance: 74 out of 100 (Needs work)");
    expect(html).toContain("SEO: 100 out of 100 (Good)");
  });

  it("never emits a NaN in a style attribute, whatever the timeline says", () => {
    const html = renderClientReport(
      makeReport({
        pages: [
          makePage({
            waterfall: {
              requests: [
                {
                  path: "/x",
                  host: "example.test",
                  resourceType: "Script",
                  transferSize: 1,
                  startTime: 0,
                  endTime: 10,
                  renderBlocking: false,
                  thirdParty: false,
                },
              ],
              totalRequests: 1,
              totalTransferSize: 1,
              thirdPartyCount: 0,
              // No usable timeline: the bar must be omitted, not divided by zero.
              timelineMs: null,
            },
          }),
        ],
      }),
    );
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(bodyOf(html)).toContain("wf-no-bar");
  });
});

/* -------------------------------------------------------------------------- */
/* Waterfall and filmstrip                                                     */
/* -------------------------------------------------------------------------- */

describe("renderClientReport — trace rendering", () => {
  const html = renderClientReport(makeReport());

  it("gives even a 2 ms request a visible bar", () => {
    const widths = [...html.matchAll(/wf-bar[^"]*" style="left:[\d.]+%;width:([\d.]+)%"/g)].map(
      (match) => Number(match[1]),
    );
    // Two of the fixture's three rows have a usable start; the third has none.
    expect(widths).toHaveLength(2);
    // MIN_BAR_PCT is 0.8 — anything narrower would render as nothing at all.
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(0.8);
  });

  it("says how many requests were left out by the cap", () => {
    expect(html).toContain("3 of 312 requests");
  });

  it("marks render-blocking and third-party rows in words as well as colour", () => {
    expect(html).toContain("render-blocking");
    expect(html).toContain("third party");
  });

  it("inlines filmstrip frames and marks the LCP frame", () => {
    expect(html).toContain(`src="${TINY_GIF}"`);
    expect(bodyOf(html)).toContain("frame--lcp");
    expect(html).toContain(">LCP<");
    expect(html).toContain("largest contentful paint");
  });

  it("drops a frame whose data is not a data: image and says the slot is empty", () => {
    const hostile = renderClientReport(
      makeReport({
        pages: [
          makePage({
            filmstrip: {
              frames: [{ timingMs: 100, data: "https://evil.test/frame.jpg", isLcp: false }],
              lcpMs: null,
              timelineMs: 100,
            },
          }),
        ],
      }),
    );
    expect(hostile).not.toContain("evil.test/frame.jpg");
    expect(hostile).toContain("Frame 1 unavailable");
  });
});

/* -------------------------------------------------------------------------- */
/* Trace omission                                                              */
/* -------------------------------------------------------------------------- */

describe("renderClientReport — trace omission", () => {
  function omissionText(reason: TraceOmission): string {
    const html = renderClientReport(
      makeReport({
        pages: [makePage({ waterfall: null, filmstrip: null, traceOmission: reason })],
      }),
    );
    const match = html.match(/<p class="omission">([^<]*)<\/p>/);
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  }

  it("gives each reason its own sentence, not one shared shrug", () => {
    const sentences = (["no-report", "unavailable", "unreadable"] as const).map(omissionText);
    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(40);
  });

  it("says a missing report is missing", () => {
    expect(omissionText("no-report")).toContain("No Lighthouse report was stored");
  });

  it("names PageSpeed Insights when the engine never captured a trace", () => {
    expect(omissionText("unavailable")).toContain("PageSpeed Insights");
  });

  it("admits when the stored file could not be read", () => {
    expect(omissionText("unreadable")).toContain("could not be read or parsed");
  });
});

/* -------------------------------------------------------------------------- */
/* Degrading honestly                                                          */
/* -------------------------------------------------------------------------- */

describe("renderClientReport — empty and partial reports", () => {
  it("renders a valid document with a stated empty state for a batch with no pages", () => {
    const html = renderClientReport(
      makeReport({
        pages: [],
        summary: {
          ...makeReport().summary,
          averageScores: {},
          overall: null,
          passFail: {
            performance: { pass: 0, fail: 0, total: 0 },
            accessibility: { pass: 0, fail: 0, total: 0 },
            "best-practices": { pass: 0, fail: 0, total: 0 },
            seo: { pass: 0, fail: 0, total: 0 },
            "agentic-browsing": { pass: 0, fail: 0, total: 0 },
          },
          clearing: { clearing: 0, total: 0 },
          best: null,
          worst: null,
          pageCount: 0,
          errorCount: 0,
        },
        notes: [],
      }),
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("This batch contains no pages");
    expect(html).toContain("the batch itself has no runs to report");
    expect(html).toContain("Generated by <strong>LightAudit Score</strong>");
  });

  it("states each absence separately when a page has no metrics, opportunities or frames", () => {
    const html = renderClientReport(
      makeReport({
        pages: [
          makePage({
            metrics: [],
            opportunities: [],
            filmstrip: { frames: [], lcpMs: null, timelineMs: null },
            waterfall: {
              requests: [],
              totalRequests: 0,
              totalTransferSize: 0,
              thirdPartyCount: 0,
              timelineMs: null,
            },
          }),
        ],
      }),
    );
    expect(html).toContain("recorded no metric values");
    expect(html).toContain("no scored opportunities");
    expect(html).toContain("no screenshot frames");
    expect(html).toContain("recorded no network requests");
  });

  it("prints the notes the caps produced", () => {
    const html = renderClientReport(makeReport());
    expect(html).toContain("Showing 3 of 312 requests for each page.");
  });

  it("falls back to the raw string when a timestamp will not parse", () => {
    const html = renderClientReport(makeReport({ generatedAt: "not-a-date" }));
    expect(html).toContain("not-a-date");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("NaN");
  });

  it("drops the anchor, not the row, when a run id is not id-shaped", () => {
    const html = renderClientReport(
      makeReport({
        summary: {
          ...makeReport().summary,
          best: { runId: 'x" onload="alert(1)', url: "https://example.test/a", overall: 55 },
          worst: null,
        },
        pages: [makePage({ runId: 'x" onload="alert(1)' })],
      }),
    );
    expect(html).not.toContain("onload=");
    expect(html).not.toContain('id="run-x');
    expect(html).toContain("Strongest page");
  });
});

/* -------------------------------------------------------------------------- */
/* The stylesheet                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every declaration block in the stylesheet whose selector list mentions
 * `selector`, in source order — so a test can reason about the CASCADE rather
 * than about one hand-picked rule.
 *
 * The regex matches only innermost blocks (`[^{}]` on both sides), which means
 * an `@media` prelude never matches as a rule of its own while the rules NESTED
 * inside it do. That is exactly what is wanted here: a `display` re-declared in
 * the print block has to be caught too.
 */
function declarationBlocks(css: string, selector: string): string[] {
  const blocks: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].includes(selector)) blocks.push(match[2]);
  }
  return blocks;
}

/** Every `display: …` value any rule for `selector` sets. */
function declaredDisplays(css: string, selector: string): string[] {
  return declarationBlocks(css, selector).flatMap((block) =>
    [...block.matchAll(/(?:^|;|\n)\s*display\s*:\s*([^;\n!]+)/g)].map((m) => m[1].trim()),
  );
}

describe("REPORT_CSS — waterfall track sizing", () => {
  /*
   * This block exists because of a real bug, and it is written to catch the bug
   * rather than the typo that caused it.
   *
   * `.wf-track` is an EMPTY <span>. Left as an inline box it computes to 0x0 —
   * CSS applies neither width nor height to a non-replaced inline box — and the
   * absolutely-positioned `.wf-bar` inside it then resolves its left/width
   * percentages against a zero-width containing block, collapsing every bar to a
   * ~2px dot at the left edge of the cell.
   *
   * What makes that failure quiet is that the GEOMETRY IS STILL CORRECT: the
   * percentages `barGeometry` emits are right, so a test that only checks the
   * inline styles passes with the document visibly broken. The test above,
   * "gives even a 2 ms request a visible bar", is exactly such a test — necessary,
   * and on its own not sufficient. Hence these assertions on the containing block
   * itself, and on every rule that could take it away later.
   */
  it("gives the bars a containing block with a real width and height", () => {
    const blocks = declarationBlocks(REPORT_CSS, ".wf-track");
    expect(blocks.length).toBeGreaterThan(0);
    const all = blocks.join("\n");
    // A block box, so width/height apply at all…
    expect(all).toMatch(/display\s*:\s*block/);
    // …an explicit width, so a bar's left/width percentages have something to
    // resolve against…
    expect(all).toMatch(/(?:^|[\s;])width\s*:\s*100%/);
    // …and a height, which the empty span cannot get from its own content.
    expect(all).toMatch(/height\s*:\s*[\d.]+/);
    // …and the containing block itself.
    expect(all).toMatch(/position\s*:\s*relative/);
  });

  it("never lets a later rule put the track back into an inline box", () => {
    // The cascade is the thing under test: asserting only that SOME rule says
    // `display: block` would keep passing the day another rule — a print
    // override, a narrow-screen override — re-declared it as inline.
    const displays = declaredDisplays(REPORT_CSS, ".wf-track");
    expect(displays.length).toBeGreaterThan(0);
    for (const display of displays) expect(display).toBe("block");
  });

  it("keeps the bar absolutely positioned against that track", () => {
    const all = declarationBlocks(REPORT_CSS, ".wf-bar").join("\n");
    expect(all).toMatch(/position\s*:\s*absolute/);
    // The pixel floor under MIN_BAR_PCT: 0.8% of a narrow track can still round
    // below one device pixel.
    expect(all).toMatch(/min-width\s*:\s*[1-9]/);
  });
});

describe("REPORT_CSS", () => {
  it("carries a print block that redefines the palette for ink", () => {
    const printBlock = REPORT_CSS.slice(REPORT_CSS.indexOf("@media print"));
    expect(printBlock).not.toBe("");
    expect(printBlock).toContain("--bg: #ffffff");
    expect(printBlock).toContain("--fg: #12161a");
    expect(printBlock).toContain("--good:");
    expect(printBlock).toContain("--average:");
    expect(printBlock).toContain("--poor:");
    // The screen texture must not cost a client a page of toner.
    expect(printBlock).toContain("background-image: none");
  });

  it("prepares the print sheet for paper: page margins, headers, no splits", () => {
    expect(REPORT_CSS).toContain("@page");
    expect(REPORT_CSS).toContain("margin: 14mm 12mm");
    expect(REPORT_CSS).toContain("display: table-header-group");
    expect(REPORT_CSS).toContain("break-inside: avoid");
    // Collapsible sections must not print collapsed.
    expect(REPORT_CSS).toContain("details:not([open]) > *:not(summary)");
  });

  it("names no remote resource of any kind", () => {
    expect(REPORT_CSS).not.toMatch(/https?:/);
    expect(REPORT_CSS).not.toContain("@import");
    expect(REPORT_CSS).not.toContain("url(");
  });

  it("declares an sRGB fallback beside every oklch token", () => {
    // A browser too old for oklch must still get the right colour rather than an
    // unstyled document, so each oklch line is preceded by a hex twin.
    const oklchCount = (REPORT_CSS.match(/oklch\(/g) ?? []).length;
    expect(oklchCount).toBeGreaterThan(0);
    for (const token of ["--bg", "--fg", "--accent", "--good", "--average", "--poor"]) {
      expect(REPORT_CSS).toMatch(new RegExp(`${token}: #[0-9a-f]{6};\\s*\\n\\s*${token}: oklch\\(`));
    }
  });
});
