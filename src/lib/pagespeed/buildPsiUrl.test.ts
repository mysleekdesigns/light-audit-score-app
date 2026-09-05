import { describe, expect, it } from "vitest";

import { type AuditOptions, LIGHTHOUSE_CATEGORIES } from "@/lib/lighthouse/types";
import { buildPsiUrl } from "@/lib/pagespeed/buildPsiUrl";

const OPTIONS: AuditOptions = {
  formFactor: "mobile",
  throttling: "simulated",
  categories: ["performance", "best-practices"],
  runs: 3,
  warmCache: true,
};

describe("buildPsiUrl", () => {
  it("targets the v5 runPagespeed endpoint with strategy + mapped categories + key", () => {
    const url = new URL(buildPsiUrl("https://example.com", OPTIONS, "KEY123"));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed",
    );
    expect(url.searchParams.get("url")).toBe("https://example.com");
    expect(url.searchParams.get("strategy")).toBe("mobile");
    // Repeated `category` params, mapped to PSI's UPPER_SNAKE enum.
    expect(url.searchParams.getAll("category")).toEqual([
      "PERFORMANCE",
      "BEST_PRACTICES",
    ]);
    expect(url.searchParams.get("key")).toBe("KEY123");
  });

  it("omits the key when keyless", () => {
    const url = new URL(buildPsiUrl("https://example.com", OPTIONS, undefined));
    expect(url.searchParams.has("key")).toBe(false);
  });

  it("maps desktop form factor to strategy=desktop and passes locale", () => {
    const url = new URL(
      buildPsiUrl(
        "https://example.com",
        { ...OPTIONS, formFactor: "desktop", locale: "en_US" },
        undefined,
      ),
    );
    expect(url.searchParams.get("strategy")).toBe("desktop");
    expect(url.searchParams.get("locale")).toBe("en_US");
  });

  it("maps every category id to its PSI enum value", () => {
    // Driven off LIGHTHOUSE_CATEGORIES so the case cannot silently stop covering
    // "every" category the way it did when `agentic-browsing` was added. The
    // Record type makes a MISSING key a compile error but says nothing about the
    // value, so a typo in an enum string would otherwise ship and PSI would 400
    // or quietly drop the category.
    const url = new URL(
      buildPsiUrl(
        "https://example.com",
        { ...OPTIONS, categories: [...LIGHTHOUSE_CATEGORIES] },
        undefined,
      ),
    );
    expect(url.searchParams.getAll("category")).toEqual([
      "PERFORMANCE",
      "ACCESSIBILITY",
      "BEST_PRACTICES",
      "SEO",
      // Verified live against PSI v5 (discovery revision 20260904): the API
      // accepts this enum and returns the category scored.
      "AGENTIC_BROWSING",
    ]);
  });

  it("cannot pick up an API key from the environment", () => {
    // The third argument used to default to `getPsiApiKey()`, so passing an
    // explicit `undefined` — the obvious way to request a keyless URL — resolved
    // the env key instead and appended it. That made every assertion here depend
    // on whether PAGESPEED_API_KEY happened to be set, and one `toContain` over
    // the whole URL away from printing a live key into CI logs.
    const previous = process.env.PAGESPEED_API_KEY;
    process.env.PAGESPEED_API_KEY = "not-a-real-key-just-a-test-sentinel";
    try {
      const url = buildPsiUrl("https://example.com", OPTIONS, undefined);
      expect(new URL(url).searchParams.has("key")).toBe(false);
      expect(url).not.toContain("sentinel");
    } finally {
      if (previous === undefined) delete process.env.PAGESPEED_API_KEY;
      else process.env.PAGESPEED_API_KEY = previous;
    }
  });
});
