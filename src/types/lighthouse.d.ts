/**
 * Ambient module declarations for `lighthouse` v13, which ships no resolvable
 * TypeScript types (no `types`/`exports` field in its package.json). These are
 * intentionally minimal — just enough for the engine to import and call the API
 * with `strict` mode on. Treat LHR contents as `Record<string, unknown>` and
 * narrow at the parse boundary.
 */

declare module "lighthouse" {
  /** Lighthouse run flags (subset; passthrough of arbitrary extras allowed). */
  export interface LighthouseFlags {
    logLevel?: "silent" | "error" | "warn" | "info" | "verbose";
    output?: "json" | "html" | "csv" | Array<"json" | "html" | "csv">;
    onlyCategories?: string[];
    port?: number;
    formFactor?: "mobile" | "desktop";
    screenEmulation?: Record<string, unknown>;
    throttlingMethod?: "simulate" | "devtools" | "provided";
    throttling?: Record<string, unknown>;
    /** Override the emulated page UA (string), or `false` to disable UA emulation. */
    emulatedUserAgent?: string | false;
    [key: string]: unknown;
  }

  export interface RunnerResult {
    /** The Lighthouse Result object. */
    lhr: Record<string, unknown>;
    /** Generated report(s) in the requested output format(s). */
    report: string | string[];
    artifacts: Record<string, unknown>;
  }

  /**
   * Run Lighthouse against a URL. Resolves to a `RunnerResult`, or `undefined`
   * if the run produced no result.
   */
  export default function lighthouse(
    url: string,
    flags?: LighthouseFlags,
    config?: Record<string, unknown>,
    page?: unknown,
  ): Promise<RunnerResult | undefined>;

  /** Built-in desktop configuration preset. */
  export const desktopConfig: Record<string, unknown>;
  /** Built-in default (mobile) configuration. */
  export const defaultConfig: Record<string, unknown>;

  export function generateReport(
    lhr: unknown,
    format: "json" | "html" | "csv",
  ): string;
}

declare module "lighthouse/core/lib/median-run.js" {
  /** Returns the run whose key metrics are median across the provided runs. */
  export function computeMedianRun(
    runs: Array<Record<string, unknown>>,
  ): Record<string, unknown>;
  /** Filters an array of LHRs down to those usable for median computation. */
  export function filterToValidRuns(
    runs: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>>;
}
