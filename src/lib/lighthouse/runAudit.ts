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
 *
 * This module is also where audit credentials (ROADMAP Phase B) become real:
 * {@link resolveEngineCredentials} layers per-batch credentials over long-lived
 * ones from the environment, {@link buildCredentialFlags} folds the result into
 * Lighthouse's single `extraHeaders` flag, and `scrubLhrCredentials` takes it
 * back out of the LHR before anything downstream can see it. See
 * `./credentials.ts` for the seam those three build on.
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

import {
  type AuditCredentials,
  buildCredentialHeaders,
  envCredentialsForUrl,
  hasUnscopedEnvCredentials,
  mergeAuditCredentials,
  scrubLhrCredentials,
} from "@/lib/lighthouse/credentials";
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

// --- Credentials (ROADMAP Phase B) -----------------------------------------

/**
 * Resolve the credentials this run should send: the per-batch ones the user
 * typed (`options` — the OVERRIDE) layered over long-lived ones from the
 * environment (`env` — the BASE), merged per header/cookie entry by
 * `mergeAuditCredentials`. So a one-off staging token supersedes `.env` for the
 * one header it names without unsetting the rest of it.
 *
 * **The environment is read HERE, in the engine, and that placement is the
 * point.** The engine only ever runs inside the forked worker
 * (`scripts/audit-worker.ts` — Lighthouse keeps process-global `lh:runner:*`
 * marks, see `.claude/rules/engine-workers.md`), so an env-sourced credential is
 * materialised one function call away from the CDP command that consumes it: it
 * never travels through the app's request/response layer, is never a field on an
 * `AuditOptions` object the API serialises to the browser, and has no path into
 * the client bundle at all. Only per-batch credentials — the ones the user
 * *chose* to hand us over HTTP — ever cross a process boundary, and the queue
 * keeps those off the `Batch` object (see `./credentials.ts`).
 *
 * The env half is scoped to `url` by `envCredentialsForUrl`: a `.env` credential
 * applies only to the hosts named in `LH_AUDIT_CREDENTIAL_HOSTS`. Without that
 * gate an ambient credential set for a staging box would be posted to every
 * host ever audited — a batch of competitor URLs would each receive the staging
 * password. Per-batch credentials need no such gate: the user attached them to
 * the very URLs being submitted.
 *
 * `env` is a parameter rather than a direct `process.env` read so the layering
 * order is unit-testable without mutating the process.
 */
export function resolveEngineCredentials(
  options: AuditOptions,
  env: Record<string, string | undefined>,
  url: string,
): AuditCredentials | undefined {
  return mergeAuditCredentials(envCredentialsForUrl(env, url), options);
}

/** One-shot latch so the warning below is printed once per worker, not per run. */
let warnedAboutUnscopedEnvCredentials = false;

/**
 * Warn (once) when `.env` holds an audit credential but names no hosts to send
 * it to, so it is being ignored.
 *
 * This is the one misconfiguration that fails *silently in the wrong direction*:
 * the user set `LH_AUDIT_BASIC_AUTH`, the audit still 401s, and nothing says
 * why. Requiring `LH_AUDIT_CREDENTIAL_HOSTS` is deliberate (see that constant),
 * so the fix is to say so rather than to relax the gate. Prints the variable
 * name only — never a value, and never the hosts.
 */
function warnOnceAboutUnscopedEnvCredentials(
  env: Record<string, string | undefined>,
): void {
  if (warnedAboutUnscopedEnvCredentials) return;
  if (!hasUnscopedEnvCredentials(env)) return;
  warnedAboutUnscopedEnvCredentials = true;
  console.warn(
    "[lighthouse] An audit credential is set in the environment but " +
      "LH_AUDIT_CREDENTIAL_HOSTS is empty, so it was not sent. List the hosts " +
      "it belongs to (e.g. LH_AUDIT_CREDENTIAL_HOSTS=staging.example.com) to use it.",
  );
}

/**
 * Pure mapping from resolved credentials → the credential-related Lighthouse
 * flags, mirroring {@link buildThrottlingFlags}. Returns `{}` when there is
 * nothing to send, so the spread contributes no key at all and Lighthouse keeps
 * its own default (`extraHeaders: null`, `core/config/constants.js`) — an
 * unauthenticated audit is byte-for-byte the run it was before Phase B.
 *
 * All three user-facing mechanisms collapse to this ONE flag: Lighthouse applies
 * `settings.extraHeaders` via CDP `Network.setExtraHTTPHeaders` in
 * `core/gather/driver/prepare.js` before the navigation, so the headers ride the
 * main document request and every subresource request of the run.
 *
 * **Deliberate deviation from the ROADMAP wording.** Phase B says to map
 * `cookies` "to the isolated Chrome profile before the navigation"; we serialise
 * them into a single `Cookie` request header instead
 * ({@link buildCredentialHeaders}). Seeding a profile's cookie jar would mean
 * opening our own CDP session between launch and Lighthouse's navigation on
 * every run, and — worse — it would behave differently for the FRESH
 * `--user-data-dir` a cold run creates than for the REUSED one warm-cache runs
 * share, since `disableStorageReset` is what preserves that jar. A request
 * header is identical under both profile modes, needs no extra CDP session, and
 * is what Unlighthouse does for the same problem.
 *
 * **Scope: per page, not per origin — and that is a real exposure.** Chrome's
 * `Network.setExtraHTTPHeaders` is documented as "always send extra HTTP headers
 * with the requests from this page", so the credential rides EVERY request the
 * audited page makes: third-party fonts, analytics, CDNs, error-reporting
 * endpoints. Confining it to the site's own origin would mean intercepting every
 * request with `Fetch.enable`/`Fetch.requestPaused` and resuming it by hand —
 * which adds latency to every single request and distorts exactly the timings
 * this engine exists to measure accurately (see `.claude/rules/engine-workers.md`
 * on score trustworthiness). We are not willing to trade measurement fidelity
 * for it silently, so the limitation is stated instead: in the Authentication
 * panel, in `.env.example`, and here. The `.env` route is additionally gated to
 * an explicit host allow-list (`LH_AUDIT_CREDENTIAL_HOSTS`) so an ambient
 * credential cannot reach a site the user never meant to authenticate to.
 *
 * The return type is wrapped in `Partial` because our ambient `lighthouse` shim
 * (`src/types/lighthouse.d.ts`) does not declare `extraHeaders`: `Pick` then
 * resolves it through the shim's `[key: string]: unknown` index signature, which
 * makes the property REQUIRED and forbids the empty return.
 */
export function buildCredentialFlags(
  credentials: AuditCredentials | undefined,
): Partial<Pick<LighthouseFlags, "extraHeaders">> {
  const extraHeaders = buildCredentialHeaders(credentials);
  return extraHeaders ? { extraHeaders } : {};
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
 *
 * Credentials (ROADMAP Phase B) are resolved per run and applied as request
 * headers, which makes them independent of the profile in both directions:
 *  - **warm cache** — `median.ts` hands the SAME `options` object to the
 *    discarded warm-up navigation and to every measured run, so the warm-up
 *    authenticates identically. That matters: a warm-up that 401'd would fill
 *    the reused profile's cache with an error page and every measured run would
 *    then score that page.
 *  - **fresh `--user-data-dir`** — a header is re-sent on every navigation, so
 *    it survives both the cold path's brand-new profile and the warm path's
 *    `disableStorageReset` reuse, with no seeding step in between.
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

      // Per-batch credentials layered over any long-lived ones in `.env`. Read
      // from the environment here, inside the worker process, so an env-sourced
      // credential never leaves it — see `resolveEngineCredentials`.
      const credentials = resolveEngineCredentials(options, process.env, url);
      warnOnceAboutUnscopedEnvCredentials(process.env);

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
        // Authenticated / header-aware audits: basic auth, cookies and explicit
        // headers folded into Lighthouse's one `extraHeaders` flag, applied via
        // CDP before the navigation. Emits no key when there is no credential,
        // so it can never clobber a flag set above. See `buildCredentialFlags`.
        ...buildCredentialFlags(credentials),
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

      // Scrub the credential out of the report BEFORE anything reads, returns or
      // forwards it. Lighthouse copies its resolved settings into the LHR
      // verbatim (`core/runner.js`: `configSettings: settings`), so without this
      // the `Authorization`/`Cookie` value would be written into
      // `data/reports/<runId>.json`, re-embedded in the standalone HTML report
      // (`persistence.ts` regenerates it from this very LHR, so scrubbing here
      // covers it), and handed to the AI analysis built from them.
      //
      // `configSettings` is the ONLY route a credential has into an LHR, checked
      // against the installed Lighthouse 13.4.1: `extraHeaders` occurs exactly
      // twice in `core/` — its `null` default in `config/constants.js` and its
      // use in `gather/driver/prepare.js` — and no audit republishes request
      // headers (`network-requests` items carry url/timing/size/status only;
      // `requestHeaders` appears solely in `lib/minify-devtoolslog.js`, which
      // works on artifacts, not the LHR). The `report` strings Lighthouse
      // rendered during the run predate this scrub, which is harmless because we
      // use only `result.lhr` and never persist `result.report`.
      scrubLhrCredentials(lhr);

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
