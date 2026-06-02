/**
 * Single Lighthouse run + robust teardown (PRD §6 Phase 1).
 *
 * Each run launches an ISOLATED `--headless=new` Chrome instance. By default it
 * gets a FRESH, unique temp `--user-data-dir` (cold cache) which is always
 * removed in a `finally`, even when Lighthouse throws. When the caller passes an
 * {@link AuditSession}, the run instead REUSES that caller-owned profile dir and
 * disables Lighthouse's storage reset, so the HTTP cache persists across runs
 * (warm cache → DevTools-panel parity); the caller, not the run, disposes it.
 * Use {@link createAuditSession} to mint a disposable session.
 *
 * The pure LHR-narrowing helpers (`parseLhr`, `parseCategoryAudits`,
 * `parseEnvironment`) now live in `./parseLhr.ts` (no Chrome/lighthouse imports)
 * so the PageSpeed Insights engine can reuse them without dragging the heavy
 * engine into the server bundle. They are re-exported here so existing import
 * paths and tests are unchanged.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { launch, type LaunchedChrome } from "chrome-launcher";
import lighthouse, {
  defaultConfig,
  desktopConfig,
  type LighthouseFlags,
} from "lighthouse";

import { classifyAuditError, runtimeErrorMessage } from "@/lib/lighthouse/diagnose";
import {
  isRecord,
  parseCategoryAudits,
  parseEnvironment,
  parseLhr,
} from "@/lib/lighthouse/parseLhr";
import {
  type AuditOptions,
  type AuditSession,
  type FormFactor,
  type LighthouseResult,
  type RunSingleAudit,
  type Throttling,
} from "@/lib/lighthouse/types";

// Re-export the pure parsers so existing call sites (median.ts, tests) and the
// PSI engine import them from one place.
export { parseCategoryAudits, parseEnvironment, parseLhr };

/**
 * Per-navigation load ceiling handed to Lighthouse. Bounds a single run so a
 * hung navigation fails fast (and is then classified by `classifyAuditError`)
 * instead of stalling until the 5-minute worker ceiling (`WORKER_TIMEOUT_MS`).
 */
const MAX_WAIT_FOR_LOAD_MS = 45_000;

/** Map our user-facing throttling choice to Lighthouse's `throttlingMethod`. */
function toThrottlingMethod(
  throttling: Throttling,
): NonNullable<LighthouseFlags["throttlingMethod"]> {
  return throttling === "simulated" ? "simulate" : "devtools";
}

/**
 * The default `throttling` settings object for the active form factor's config
 * (mobile = `defaultConfig`, desktop = `desktopConfig`). These carry the network
 * profile (rttMs/throughputKbps/…) AND the method's default `cpuSlowdownMultiplier`.
 * Returns a fresh shallow copy ({} if absent) so callers can safely spread over it.
 */
function defaultThrottlingFor(
  formFactor: FormFactor,
): Record<string, unknown> {
  const config = formFactor === "desktop" ? desktopConfig : defaultConfig;
  const settings = isRecord(config.settings) ? config.settings : undefined;
  const throttling =
    settings && isRecord(settings.throttling) ? settings.throttling : undefined;
  return throttling ? { ...throttling } : {};
}

/**
 * Pure mapping from validated options → the throttling-related Lighthouse flags.
 * Exported so flag construction is unit-testable without launching Chrome.
 *
 * - Always sets `throttlingMethod` (`simulate`/`devtools`) via {@link toThrottlingMethod}.
 * - When `cpuSlowdownMultiplier` is set, we MUST NOT hand Lighthouse a bare
 *   `{ cpuSlowdownMultiplier }`: a `throttling` flag REPLACES the config's entire
 *   `throttling` object, which would silently drop network throttling
 *   (rttMs/throughputKbps/…). So we MERGE the multiplier over the active form
 *   factor's default throttling profile, changing only `cpuSlowdownMultiplier`.
 * - When omitted, we emit no `throttling` flag at all, so Lighthouse keeps its
 *   own config defaults (mobile 4×, desktop 1×).
 */
export function buildThrottlingFlags(
  options: AuditOptions,
): Pick<LighthouseFlags, "throttlingMethod" | "throttling"> {
  const throttlingMethod = toThrottlingMethod(options.throttling);
  if (options.cpuSlowdownMultiplier === undefined) {
    return { throttlingMethod };
  }
  return {
    throttlingMethod,
    throttling: {
      ...defaultThrottlingFor(options.formFactor),
      cpuSlowdownMultiplier: options.cpuSlowdownMultiplier,
    },
  };
}

// --- Session (warm-cache profile) ------------------------------------------

/**
 * Mint a disposable {@link AuditSession}: a persistent Chrome `--user-data-dir`
 * to reuse across the runs of a single audit so the HTTP cache stays warm
 * (DevTools-panel parity — see {@link AuditOptions.warmCache}). The caller MUST
 * `dispose()` it (in a `finally`) to remove the temp profile; individual runs
 * handed this session never delete it.
 */
export async function createAuditSession(): Promise<
  AuditSession & { dispose: () => Promise<void> }
> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-warm-"));
  return {
    userDataDir,
    dispose: () => fs.rm(userDataDir, { recursive: true, force: true }),
  };
}

// --- Single run + teardown -------------------------------------------------

/**
 * Run Lighthouse once against `url` with already-validated `options`.
 *
 * Without a `session`: uses a fresh isolated Chrome profile (cold cache) that is
 * always removed in the `finally`, even on error. With a `session`: reuses the
 * caller-owned profile dir and disables Lighthouse's storage reset so the cache
 * persists across runs (warm cache); the session owner disposes the dir, not
 * this function. Chrome is always killed either way.
 */
export const runSingleAudit: RunSingleAudit = async (url, options, session) => {
  // A caller-owned session means a reused, warm profile we must NOT delete; no
  // session means a fresh, cold profile this run both creates and tears down.
  const ownsProfile = session === undefined;
  const userDataDir =
    session?.userDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "lh-")));
  let chrome: LaunchedChrome | undefined;

  try {
    // Inner try/catch maps any launch/Lighthouse/network throw onto a friendly,
    // user-facing message via `classifyAuditError`. It NEVER swallows: every
    // path re-throws. Teardown stays in the outer `finally` so it always runs.
    try {
      chrome = await launch({
        userDataDir,
        chromeFlags: ["--headless=new", `--user-data-dir=${userDataDir}`],
      });

      const flags: LighthouseFlags = {
        logLevel: "error",
        output: ["json", "html"],
        port: chrome.port,
        onlyCategories: options.categories,
        formFactor: options.formFactor,
        // throttlingMethod (simulate/devtools) + an optional throttling override
        // that preserves the active config's network profile when a CPU
        // multiplier is set. See `buildThrottlingFlags`.
        ...buildThrottlingFlags(options),
        // Warm cache (session present): keep the profile's HTTP cache between
        // runs instead of Lighthouse wiping it at the start of each run. This is
        // what makes a reused-profile run a *warm* repeat visit (DevTools-panel
        // parity); a fresh-profile run leaves this at Lighthouse's default
        // (storage IS reset → cold first visit).
        ...(ownsProfile ? {} : { disableStorageReset: true }),
        // Optional emulated-UA override (parity lever for bot-sensitive sites).
        // Omitted → Lighthouse uses its config-default device UA.
        ...(options.emulatedUserAgent
          ? { emulatedUserAgent: options.emulatedUserAgent }
          : {}),
        // Bound a single navigation so a hung page fails fast (and is then
        // classified) rather than stalling until the worker timeout.
        maxWaitForLoad: MAX_WAIT_FOR_LOAD_MS,
      };

      // Desktop uses Lighthouse's `desktopConfig` (sets desktop screenEmulation /
      // formFactor); mobile uses the default config (undefined). The
      // throttlingMethod flag is honoured in either case.
      const config: Record<string, unknown> | undefined =
        options.formFactor === "desktop" ? desktopConfig : undefined;

      const result = await lighthouse(url, flags, config);
      if (!result) {
        throw new Error(
          `Lighthouse returned no result for ${url} (formFactor=${options.formFactor}).`,
        );
      }

      const lhr = result.lhr as LighthouseResult;

      // Lighthouse often returns an LHR even when navigation failed, carrying the
      // reason in `lhr.runtimeError`. Treat that as an error (not bogus scores).
      const runtimeError = runtimeErrorMessage(lhr);
      if (runtimeError !== null) {
        throw new Error(runtimeError);
      }

      return { ...parseLhr(lhr, options.formFactor), lhr };
    } catch (error) {
      // Re-throw a friendly, classified message (includes the url for context).
      throw new Error(classifyAuditError(error, url));
    }
  } finally {
    // Always kill Chrome (guard if launch failed). Wrapped so a teardown error
    // never masks a run error.
    try {
      chrome?.kill();
    } catch {
      // best-effort; the process may already be gone
    }
    // Only remove the profile we created. A caller-owned (warm) session dir is
    // reused by later runs and disposed by its owner — see `createAuditSession`.
    if (ownsProfile) {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  }
};
