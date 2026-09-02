"use client";

/**
 * `useLocalAuditDraft` / `usePsiAuditDraft` — per-tab stores for what the audit
 * forms have in them (see `@/lib/settings/drafts` for the shapes).
 *
 * Why a store and not component state: every route change unmounts the page and
 * its form, so `useState` there is wiped the moment the user opens History and
 * comes back — the batch is still running server-side, but the console looks
 * reset. This module's state outlives the form (module scope is torn down only on
 * a full reload), and a `sessionStorage` mirror carries the draft across that
 * reload too. Per tab, gone when the tab closes: the right lifetime for a draft.
 *
 * Built like {@link file://./useAuditDefaults.ts}: `useSyncExternalStore` makes
 * the read SSR-safe by construction — `getServerSnapshot` returns the empty draft
 * (matching the server HTML during hydration) and the persisted blob is read only
 * once the store is first subscribed on the client. No setState-in-effect, no
 * hydration mismatch. Storage writes are debounced (a draft can carry a
 * 10 000-URL crawl, and the paste textarea updates per keystroke) and flushed on
 * `pagehide`. Every storage access is wrapped, so a disabled/throwing store
 * (private mode, quota) degrades to in-memory state.
 */

import { useSyncExternalStore } from "react";

import {
  EMPTY_PSI_FORM_DRAFT,
  EMPTY_TARGETS_DRAFT,
  LOCAL_DRAFT_STORAGE_KEY,
  normalizePsiFormDraft,
  normalizeTargetsDraft,
  PSI_DRAFT_STORAGE_KEY,
  type PsiFormDraft,
  type TargetsDraft,
} from "@/lib/settings/drafts";

/** Replace the draft, or patch it from the previous value (`useState`-style updater). */
export type DraftUpdate<T> = T | ((prev: T) => T);

/** How long a burst of edits is coalesced before it reaches `sessionStorage`. */
const WRITE_DELAY_MS = 250;

/**
 * Build one draft store: a module-level value + listeners + a debounced
 * `sessionStorage` mirror, exposed as a `[draft, update]` hook. `update` is a
 * stable module function, safe to list in dependency arrays.
 */
function createDraftStore<T>(
  key: string,
  empty: T,
  normalize: (raw: unknown) => T,
): () => readonly [T, (next: DraftUpdate<T>) => void] {
  let state: T = empty;
  let loaded = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  /** Read + normalise the persisted blob; falls back to the empty draft on any error. */
  function readStorage(): T {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw) return normalize(JSON.parse(raw));
    } catch {
      // Unreadable/disabled storage — start empty.
    }
    return empty;
  }

  /** Write the current draft through to storage now (no-op when nothing changed). */
  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    dirty = false;
    try {
      window.sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Persisting failed (quota/disabled) — the in-memory draft still stands.
    }
  }

  function scheduleFlush(): void {
    dirty = true;
    if (timer === null) timer = setTimeout(flush, WRITE_DELAY_MS);
  }

  /** Lazily hydrate from storage the first time the store is touched on the client. */
  function ensureLoaded(): void {
    if (loaded) return;
    loaded = true;
    state = readStorage();
    // A reload/close mid-debounce must not lose the last keystrokes.
    window.addEventListener("pagehide", flush);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    // First client subscription reads the persisted value; useSyncExternalStore
    // re-checks the snapshot after subscribing, so the loaded value is picked up.
    ensureLoaded();
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): T {
    return state;
  }

  function getServerSnapshot(): T {
    return empty;
  }

  function update(next: DraftUpdate<T>): void {
    ensureLoaded();
    const resolved =
      typeof next === "function" ? (next as (prev: T) => T)(state) : next;
    if (Object.is(resolved, state)) return;
    state = resolved;
    scheduleFlush();
    for (const listener of listeners) listener();
  }

  function useDraft(): readonly [T, (next: DraftUpdate<T>) => void] {
    const draft = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    return [draft, update] as const;
  }

  return useDraft;
}

/** The local Lighthouse form's targets draft (its dials live in `useAuditDefaults`). */
export const useLocalAuditDraft = createDraftStore<TargetsDraft>(
  LOCAL_DRAFT_STORAGE_KEY,
  EMPTY_TARGETS_DRAFT,
  normalizeTargetsDraft,
);

/** The PageSpeed form's draft: targets plus its dials. */
export const usePsiAuditDraft = createDraftStore<PsiFormDraft>(
  PSI_DRAFT_STORAGE_KEY,
  EMPTY_PSI_FORM_DRAFT,
  normalizePsiFormDraft,
);
