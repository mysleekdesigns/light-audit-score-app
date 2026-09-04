"use client";

/**
 * `useMinuteTick` — a shared, hydration-safe wall clock that advances once a
 * minute.
 *
 * Cadence readouts ("Next run", "in 4h 12m") can't be server-rendered: the
 * server's `Date.now()` and the browser's differ, so SSR would either diverge on
 * hydration or lock the page to a stale instant. This exposes the clock through
 * {@link useSyncExternalStore} instead, where `getServerSnapshot` returns `null`
 * — callers render a placeholder for that frame, and the real wall clock swaps
 * in on mount. No setState-in-effect, no mismatch.
 *
 * One interval serves every consumer on the page, and the store hands back a
 * stable `Date` reference until the next minute boundary, so React can bail out
 * of re-renders that the tick didn't actually change. The interval is created by
 * the first subscriber and torn down with the last.
 *
 * Consumers: each `ScheduleCard` on the Scheduled archive page, and the
 * Edit-schedule dialog, which needs the same clock to say when a new time would
 * next fire.
 */

import { useSyncExternalStore } from "react";

/** The current minute, or `null` before the first client subscription. */
let currentTick: Date | null = null;
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60_000;

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  // First subscriber kicks off the interval; the rest reuse it.
  if (intervalId === null) {
    currentTick = new Date();
    intervalId = setInterval(() => {
      currentTick = new Date();
      for (const listener of listeners) listener();
    }, TICK_MS);
    // Notify the just-subscribed caller so its first paint adopts the wall
    // clock instead of waiting a whole minute for it.
    queueMicrotask(notify);
  }
  return () => {
    listeners.delete(notify);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
      currentTick = null;
    }
  };
}

function getClientSnapshot(): Date | null {
  return currentTick;
}

function getServerSnapshot(): null {
  // SSR snapshot — never compute `Date.now()` here or hydration will diverge.
  return null;
}

/**
 * Subscribe to the shared minute clock. Returns `null` during SSR and for the
 * very first client frame; render a placeholder for that case rather than
 * falling back to a locally computed `new Date()`, which would reintroduce the
 * hydration mismatch this hook exists to avoid.
 */
export function useMinuteTick(): Date | null {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
