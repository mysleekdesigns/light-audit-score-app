/**
 * Device-pairing projection (PRD §6 Phase 12 — Desktop + Mobile paired audits).
 *
 * A `"both"` batch runs each URL twice — once per {@link FormFactor} — persisting
 * two independent `runs` rows / streaming two independent jobs. This module is the
 * pure, never-throwing projection that pairs those mobile + desktop items back
 * together for a per-URL paired view, *without* any DB or schema change: it works
 * over already-fetched items (live `AuditJob`s or persisted `HistoryRow`s alike)
 * via caller-supplied accessors, so it stays trivially unit-testable and free of
 * Chrome / Node / DB imports.
 *
 * Callers that span multiple batches (e.g. the History archive) should group by
 * `batchId` first, then pair within each group, so the same URL audited in two
 * different batches never collides.
 */

import type { FormFactor } from "@/lib/lighthouse/types";

/** One URL's mobile + desktop counterpart items (either side may be absent). */
export interface DevicePair<T> {
  /** The URL shared by the pair (the accessor's value for its items). */
  url: string;
  /** The mobile item for this URL, or `null` if it wasn't audited on mobile. */
  mobile: T | null;
  /** The desktop item for this URL, or `null` if it wasn't audited on desktop. */
  desktop: T | null;
  /**
   * A stable, non-null representative — the mobile item when present, else the
   * desktop one. Handy for keys, the URL label, and single-device fallbacks.
   */
  primary: T;
}

/**
 * Pair items by URL into `{ mobile, desktop }` couples, preserving each URL's
 * first-appearance order. The first item seen for a given `(url, device)` wins
 * (later duplicates — e.g. the same URL pasted twice for one device — are
 * ignored for that slot), so the projection is deterministic and never throws.
 */
export function pairByDevice<T>(
  items: readonly T[],
  getUrl: (item: T) => string,
  getDevice: (item: T) => FormFactor,
): DevicePair<T>[] {
  // Mutable accumulator keyed by URL, in insertion order (Map preserves it).
  const byUrl = new Map<string, { url: string; mobile: T | null; desktop: T | null }>();

  for (const item of items) {
    const url = getUrl(item);
    let entry = byUrl.get(url);
    if (!entry) {
      entry = { url, mobile: null, desktop: null };
      byUrl.set(url, entry);
    }
    const device = getDevice(item);
    if (device === "desktop") {
      if (entry.desktop === null) entry.desktop = item;
    } else {
      // Treat anything that isn't "desktop" as mobile (the only other factor).
      if (entry.mobile === null) entry.mobile = item;
    }
  }

  const pairs: DevicePair<T>[] = [];
  for (const entry of byUrl.values()) {
    // `primary` is non-null by construction: an entry only exists if at least
    // one item was inserted, and that item filled mobile or desktop.
    const primary = (entry.mobile ?? entry.desktop) as T;
    pairs.push({ url: entry.url, mobile: entry.mobile, desktop: entry.desktop, primary });
  }
  return pairs;
}

/**
 * Which form factors are present across `items`. Drives whether a surface shows
 * the paired (mobile + desktop) layout or the compact single-device one.
 */
export function devicesPresent<T>(
  items: readonly T[],
  getDevice: (item: T) => FormFactor,
): { mobile: boolean; desktop: boolean } {
  let mobile = false;
  let desktop = false;
  for (const item of items) {
    if (getDevice(item) === "desktop") desktop = true;
    else mobile = true;
    if (mobile && desktop) break;
  }
  return { mobile, desktop };
}

/**
 * True when BOTH a mobile and a desktop item appear in `items` — i.e. the set is
 * worth rendering as paired columns rather than a single-device list.
 */
export function hasBothDevices<T>(
  items: readonly T[],
  getDevice: (item: T) => FormFactor,
): boolean {
  const { mobile, desktop } = devicesPresent(items, getDevice);
  return mobile && desktop;
}
