import { describe, expect, it } from "vitest";

import type { AuditOptions } from "@/lib/lighthouse/types";
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
    const url = new URL(
      buildPsiUrl(
        "https://example.com",
        {
          ...OPTIONS,
          categories: ["performance", "accessibility", "best-practices", "seo"],
        },
        undefined,
      ),
    );
    expect(url.searchParams.getAll("category")).toEqual([
      "PERFORMANCE",
      "ACCESSIBILITY",
      "BEST_PRACTICES",
      "SEO",
    ]);
  });
});
