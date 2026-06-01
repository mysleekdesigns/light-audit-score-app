import { describe, expect, it } from "vitest";

import {
  benchmarkDeviceLabel,
  chromeVersionFromUserAgent,
  cpuMultiplierLabel,
  formatBenchmarkIndex,
  LIGHTHOUSE_DEFAULT_MULTIPLIER,
  throttlingMethodLabel,
} from "@/lib/lighthouse/environment-format";

describe("throttlingMethodLabel", () => {
  it("maps the effective Lighthouse method strings to user-facing words", () => {
    expect(throttlingMethodLabel("simulate")).toBe("Simulated");
    expect(throttlingMethodLabel("devtools")).toBe("Applied");
    expect(throttlingMethodLabel("provided")).toBe("Provided");
  });

  it("falls back to the raw string when unknown, em-dash when empty/missing", () => {
    expect(throttlingMethodLabel("custom")).toBe("custom");
    expect(throttlingMethodLabel("")).toBe("—");
    expect(throttlingMethodLabel(null)).toBe("—");
    expect(throttlingMethodLabel(undefined)).toBe("—");
  });
});

describe("cpuMultiplierLabel", () => {
  it("renders a pinned multiplier with a × suffix", () => {
    expect(cpuMultiplierLabel(4)).toBe("4×");
    expect(cpuMultiplierLabel(9)).toBe("9×");
  });

  it("drops a trailing .0 but keeps real fractions", () => {
    expect(cpuMultiplierLabel(4.0)).toBe("4×");
    expect(cpuMultiplierLabel(8.5)).toBe("8.5×");
  });

  it("renders Auto 4× when no multiplier is pinned", () => {
    expect(cpuMultiplierLabel(null)).toBe(
      `Auto ${LIGHTHOUSE_DEFAULT_MULTIPLIER}×`,
    );
    expect(cpuMultiplierLabel(undefined)).toBe("Auto 4×");
    expect(cpuMultiplierLabel(Number.NaN)).toBe("Auto 4×");
  });
});

describe("formatBenchmarkIndex", () => {
  it("rounds a valid index to an integer string", () => {
    expect(formatBenchmarkIndex(4057.5)).toBe("4058");
    expect(formatBenchmarkIndex(1750)).toBe("1750");
  });

  it("returns em-dash for missing/invalid/non-positive values", () => {
    expect(formatBenchmarkIndex(null)).toBe("—");
    expect(formatBenchmarkIndex(undefined)).toBe("—");
    expect(formatBenchmarkIndex(0)).toBe("—");
    expect(formatBenchmarkIndex(-10)).toBe("—");
    expect(formatBenchmarkIndex(Number.NaN)).toBe("—");
  });
});

describe("benchmarkDeviceLabel", () => {
  it("labels a benchmarkIndex by its device class", () => {
    expect(benchmarkDeviceLabel(4000)).toBe("High-end desktop");
    expect(benchmarkDeviceLabel(900)).toBe("High-end mobile");
    expect(benchmarkDeviceLabel(300)).toBe("Mid-tier mobile");
  });

  it("returns null for missing/invalid values", () => {
    expect(benchmarkDeviceLabel(null)).toBeNull();
    expect(benchmarkDeviceLabel(0)).toBeNull();
    expect(benchmarkDeviceLabel(undefined)).toBeNull();
  });
});

describe("chromeVersionFromUserAgent", () => {
  it("extracts the Chrome version from a desktop UA string", () => {
    expect(
      chromeVersionFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36",
      ),
    ).toBe("126.0.6478.127");
  });

  it("matches HeadlessChrome and Chromium builds", () => {
    expect(
      chromeVersionFromUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36",
      ),
    ).toBe("124.0.0.0");
    expect(
      chromeVersionFromUserAgent("Mozilla/5.0 Chromium/120.0 Safari/537.36"),
    ).toBe("120.0");
  });

  it("returns null when absent or non-string", () => {
    expect(
      chromeVersionFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/604.1",
      ),
    ).toBeNull();
    expect(chromeVersionFromUserAgent("")).toBeNull();
    expect(chromeVersionFromUserAgent(null)).toBeNull();
    expect(chromeVersionFromUserAgent(undefined)).toBeNull();
  });
});
