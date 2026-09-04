import { describe, expect, it } from "vitest";

import { describeTarget, formatCountdown } from "@/lib/schedules/format";
import type { ScheduleTarget } from "@/lib/schedules/types";

function urls(list: string[]): ScheduleTarget {
  return { kind: "urls", urls: list };
}

function crawl(patch: Partial<{ maxDepth: number; maxPages: number }> = {}) {
  return {
    kind: "crawl" as const,
    spec: {
      url: "https://example.com",
      useSitemap: true,
      useCrawl: true,
      maxDepth: 2,
      maxPages: 50,
      excludePaths: [],
      ...patch,
    },
  };
}

// The card titles an unnamed schedule with `label` and prints `detail` beneath
// it, so the two must never say the same thing twice. The count belongs to the
// label, as a `+N more` suffix; a URL list therefore has no detail line at all,
// which is what stops "18 URLs" reappearing under a title ending "+17 more".
describe("describeTarget", () => {
  it("labels a URL list with its first URL and a +N more suffix", () => {
    const described = describeTarget(
      urls(["https://www.example.com/", "https://www.example.com/blog"]),
    );
    expect(described.label).toBe("www.example.com/ +1 more");
    expect(described.kind).toBe("URLs");
  });

  it("counts the rest of the list in the suffix, not a second line", () => {
    const list = Array.from({ length: 18 }, (_, i) => `https://x${i}.example`);
    const described = describeTarget(urls(list));
    expect(described.label).toBe("x0.example +17 more");
    expect(described.detail).toBe("");
  });

  it("drops the suffix for a single-URL list", () => {
    const described = describeTarget(urls(["https://only.example"]));
    expect(described.label).toBe("only.example");
    expect(described.detail).toBe("");
  });

  it("never gives a URL list a detail line to repeat the label with", () => {
    for (const count of [1, 2, 18]) {
      const list = Array.from({ length: count }, (_, i) => `https://x${i}.example`);
      expect(describeTarget(urls(list)).detail).toBe("");
    }
  });

  it("strips the scheme from a crawl root and reports its bounds", () => {
    const described = describeTarget(crawl({ maxDepth: 3, maxPages: 25 }));
    expect(described.label).toBe("example.com");
    expect(described.kind).toBe("Crawl");
    expect(described.detail).toBe("depth 3 · ≤25 pages");
  });

  it("survives an empty URL list without throwing", () => {
    expect(describeTarget(urls([]))).toEqual({
      label: "",
      kind: "URLs",
      detail: "",
    });
  });
});

describe("formatCountdown", () => {
  const base = new Date(2026, 4, 28, 9, 0);

  it("reads 'due' for a moment already past", () => {
    expect(formatCountdown(new Date(2026, 4, 28, 8, 0), base)).toBe("due");
  });

  it("uses minutes under an hour", () => {
    expect(formatCountdown(new Date(2026, 4, 28, 9, 42), base)).toBe("in 42m");
  });

  it("uses hours and minutes under a day", () => {
    expect(formatCountdown(new Date(2026, 4, 28, 13, 12), base)).toBe("in 4h 12m");
  });

  it("uses days and hours beyond a day", () => {
    expect(formatCountdown(new Date(2026, 4, 30, 12, 0), base)).toBe("in 2d 3h");
  });
});
