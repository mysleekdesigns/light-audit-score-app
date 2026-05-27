"use client";

/**
 * `useAuditDefaults` — the client-side store for persisted audit defaults
 * (PRD §6 Phase 7 — settings persistence).
 *
 * Backs {@link AuditDefaults} with `localStorage`, keyed by
 * {@link SETTINGS_STORAGE_KEY}, exposed through {@link useSyncExternalStore} so
 * the read is SSR-safe by construction: `getServerSnapshot` returns the factory
 * defaults (matching the server HTML during hydration), and the persisted blob
 * is only read once the store is subscribed on the client — no setState-in-effect,
 * no hydration mismatch. `loaded` flips `false → true` on that first client read
 * so consumers can avoid persisting the factory defaults back over a user's saved
 * values before they've loaded.
 *
 * `update` takes a *partial* patch, merges it over the current value, and
 * re-validates the whole thing through {@link normalizeDefaults} before
 * persisting — so independent surfaces (the New Audit form, the Batch Summary
 * thresholds) can each write their own slice without clobbering the rest. A
 * single module-level store is shared by every hook instance (and kept in sync
 * across tabs via the `storage` event). All `localStorage` access is wrapped so a
 * disabled/throwing store (private mode, quota) degrades to in-memory state.
 */

import { useCallback, useSyncExternalStore } from "react";

import {
  type AuditDefaults,
  DEFAULT_AUDIT_DEFAULTS,
  normalizeDefaults,
  SETTINGS_STORAGE_KEY,
  serializeDefaults,
} from "@/lib/settings/defaults";

interface StoreState {
  value: AuditDefaults;
  loaded: boolean;
}

/** Stable server/initial snapshot — matches the SSR render until the client reads storage. */
const INITIAL_STATE: StoreState = { value: DEFAULT_AUDIT_DEFAULTS, loaded: false };

let state: StoreState = INITIAL_STATE;
let hasReadStorage = false;
const listeners = new Set<() => void>();

/** Read + normalise the persisted blob; falls back to factory defaults on any error. */
function readStorage(): AuditDefaults {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return normalizeDefaults(JSON.parse(raw));
  } catch {
    // Unreadable/disabled storage — keep the factory defaults.
  }
  return DEFAULT_AUDIT_DEFAULTS;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Lazily hydrate the store from `localStorage` the first time it's subscribed. */
function ensureLoaded(): void {
  if (hasReadStorage) return;
  hasReadStorage = true;
  state = { value: readStorage(), loaded: true };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // First client subscription reads the persisted value; useSyncExternalStore
  // re-checks the snapshot after subscribing, so the loaded value is picked up.
  ensureLoaded();
  emit();

  const onStorage = (event: StorageEvent): void => {
    if (event.key === SETTINGS_STORAGE_KEY) {
      state = { value: readStorage(), loaded: true };
      emit();
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): StoreState {
  return state;
}

function getServerSnapshot(): StoreState {
  return INITIAL_STATE;
}

/** Replace the stored defaults, persist them, and notify subscribers. */
function writeDefaults(next: AuditDefaults): void {
  state = { value: next, loaded: true };
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, serializeDefaults(next));
  } catch {
    // Persisting failed (quota/disabled) — keep the new value in memory.
  }
  emit();
}

export interface UseAuditDefaultsResult {
  /** Current defaults (factory defaults until `loaded`, then the persisted set). */
  defaults: AuditDefaults;
  /** Merge a partial patch over the current defaults, re-validate, and persist. */
  update: (patch: Partial<AuditDefaults>) => void;
  /** Clear persisted defaults and return to the factory set. */
  reset: () => void;
  /** `true` once the persisted blob has been read from `localStorage`. */
  loaded: boolean;
}

export function useAuditDefaults(): UseAuditDefaultsResult {
  const store = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback((patch: Partial<AuditDefaults>) => {
    writeDefaults(normalizeDefaults({ ...state.value, ...patch }));
  }, []);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    } catch {
      // ignore
    }
    state = { value: DEFAULT_AUDIT_DEFAULTS, loaded: true };
    emit();
  }, []);

  return { defaults: store.value, update, reset, loaded: store.loaded };
}
