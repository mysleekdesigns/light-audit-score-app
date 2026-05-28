import { describe, expect, it } from "vitest";

import type { FormFactor } from "@/lib/lighthouse/types";
import {
  devicesPresent,
  hasBothDevices,
  pairByDevice,
  type DevicePair,
} from "@/lib/pairing/devicePairs";

/** Minimal item shape standing in for an AuditJob / HistoryRow. */
interface Item {
  id: string;
  url: string;
  device: FormFactor;
}

const url = (i: Item) => i.url;
const device = (i: Item) => i.device;

function pair(items: Item[]): DevicePair<Item>[] {
  return pairByDevice(items, url, device);
}

describe("pairByDevice", () => {
  it("pairs the mobile + desktop item for the same URL", () => {
    const m: Item = { id: "m", url: "https://a.com", device: "mobile" };
    const d: Item = { id: "d", url: "https://a.com", device: "desktop" };
    const pairs = pair([m, d]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({
      url: "https://a.com",
      mobile: m,
      desktop: d,
      primary: m,
    });
  });

  it("leaves the absent side null for a single-device set", () => {
    const m: Item = { id: "m", url: "https://a.com", device: "mobile" };
    const pairs = pair([m]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].mobile).toBe(m);
    expect(pairs[0].desktop).toBeNull();
    expect(pairs[0].primary).toBe(m);
  });

  it("uses desktop as the primary when there is no mobile", () => {
    const d: Item = { id: "d", url: "https://a.com", device: "desktop" };
    const [p] = pair([d]);
    expect(p.mobile).toBeNull();
    expect(p.desktop).toBe(d);
    expect(p.primary).toBe(d);
  });

  it("preserves first-appearance URL order", () => {
    const items: Item[] = [
      { id: "1", url: "https://b.com", device: "mobile" },
      { id: "2", url: "https://a.com", device: "mobile" },
      { id: "3", url: "https://b.com", device: "desktop" },
      { id: "4", url: "https://a.com", device: "desktop" },
    ];
    const pairs = pair(items);
    expect(pairs.map((p) => p.url)).toEqual(["https://b.com", "https://a.com"]);
    expect(pairs[0].mobile?.id).toBe("1");
    expect(pairs[0].desktop?.id).toBe("3");
  });

  it("keeps the first item per (url, device) slot when duplicated", () => {
    const items: Item[] = [
      { id: "first", url: "https://a.com", device: "mobile" },
      { id: "dup", url: "https://a.com", device: "mobile" },
    ];
    const [p] = pair(items);
    expect(p.mobile?.id).toBe("first");
  });

  it("returns an empty list for empty input (never throws)", () => {
    expect(pair([])).toEqual([]);
  });
});

describe("devicesPresent / hasBothDevices", () => {
  it("detects a single device", () => {
    const items: Item[] = [{ id: "m", url: "https://a.com", device: "mobile" }];
    expect(devicesPresent(items, device)).toEqual({ mobile: true, desktop: false });
    expect(hasBothDevices(items, device)).toBe(false);
  });

  it("detects both devices", () => {
    const items: Item[] = [
      { id: "m", url: "https://a.com", device: "mobile" },
      { id: "d", url: "https://a.com", device: "desktop" },
    ];
    expect(devicesPresent(items, device)).toEqual({ mobile: true, desktop: true });
    expect(hasBothDevices(items, device)).toBe(true);
  });

  it("is false for empty input", () => {
    expect(hasBothDevices([], device)).toBe(false);
    expect(devicesPresent([], device)).toEqual({ mobile: false, desktop: false });
  });
});
