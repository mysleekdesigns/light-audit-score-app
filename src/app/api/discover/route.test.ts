/**
 * `POST /api/discover` route tests (PRD §6 Phase 5).
 *
 * Hermetic: the discovery engine is mocked so the route's own behaviour
 * (JSON parsing, validation envelope, success/error responses, 405) is tested
 * in isolation — no network, no cheerio, no Chrome.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoverInput, DiscoverResult } from "@/lib/crawl/types";

// Mock the engine: capture the resolved input and return a canned result.
const discoverMock = vi.fn<(input: DiscoverInput) => Promise<DiscoverResult>>();
vi.mock("@/lib/crawl/discover", () => ({
  discover: (input: DiscoverInput) => discoverMock(input),
}));

import { GET, POST } from "@/app/api/discover/route";

const RESULT: DiscoverResult = {
  origin: "https://example.com",
  urls: [{ url: "https://example.com/a", source: "sitemap" }],
  totalFound: 1,
  robotsBlocked: false,
  warnings: [],
};

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  discoverMock.mockReset();
  discoverMock.mockResolvedValue(RESULT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/discover — success", () => {
  it("validates the body, calls discover with resolved input, and returns 200", async () => {
    const res = await POST(postJson({ url: "https://example.com" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverResult;
    expect(body).toEqual(RESULT);

    expect(discoverMock).toHaveBeenCalledTimes(1);
    const passed = discoverMock.mock.calls[0][0];
    // Defaults resolved before reaching the engine.
    expect(passed).toEqual({
      url: "https://example.com",
      useSitemap: true,
      useCrawl: true,
      maxDepth: 2,
      maxPages: 25,
      excludePaths: [],
    });
  });

  it("forwards clamped bounds + explicit toggles to the engine", async () => {
    await POST(
      postJson({
        url: "https://example.com",
        useSitemap: false,
        maxDepth: 99,
        maxPages: 0,
      }),
    );
    const passed = discoverMock.mock.calls[0][0];
    expect(passed.useSitemap).toBe(false);
    expect(passed.maxDepth).toBe(4); // clamped to MAX_DEPTH
    expect(passed.maxPages).toBe(1); // clamped to MIN_PAGES
  });
});

describe("POST /api/discover — client errors", () => {
  it("returns 400 invalid_json for a non-JSON body", async () => {
    const req = new Request("http://localhost/api/discover", {
      method: "POST",
      body: "not json{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_json");
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_request with issues for a failed validation", async () => {
    const res = await POST(postJson({ url: "ftp://example.com" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; issues?: { path: string }[] };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues?.some((i) => i.path === "url")).toBe(true);
    expect(discoverMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/discover — server errors", () => {
  it("returns 500 discover_failed without leaking internals when discover throws", async () => {
    discoverMock.mockRejectedValueOnce(new Error("secret internal detail"));
    const res = await POST(postJson({ url: "https://example.com" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("discover_failed");
  });
});

describe("GET /api/discover", () => {
  it("rejects unsupported methods with a structured 405", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });
});
