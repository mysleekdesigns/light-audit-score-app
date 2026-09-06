/**
 * Standalone Lighthouse audit runner and CI gate (PRD §6 Phase 1, ROADMAP Phase F).
 *
 *   npm run audit -- <url> [<url> ...] [options]        # developer summary
 *   npm run ci    -- <targets> --budget 90 --reporter json
 *
 * Two jobs, one code path. Given no budgets it is the Phase-1 developer tool:
 * audit some URLs, print the scores, the per-run spread and the opportunities.
 * Given `--budget` / `--config` it is a pipeline gate: exit 1 when a page misses
 * its bar, naming the page and the category (`@/lib/ci/types` holds the full
 * contract and the three decisions behind it).
 *
 * Three things are load-bearing about how it runs:
 *
 *  1. **It goes through the queue.** Execution is `getAuditQueue().createBatch()`
 *     — a new *caller*, not a new queue (the Phase-14 scheduler precedent). That
 *     is what makes CI runs persist to History exactly like UI runs, so one
 *     archive holds both. Rolling a second execution path here would have meant
 *     a second persistence path, and the shared archive is the whole point.
 *  2. **The verdict comes from SQLite, not from memory.** After the batch
 *     settles, the runs are read back out with `listHistory()` and *those rows*
 *     are judged. If persistence ever broke, there would be no rows and the run
 *     fails loudly instead of passing green with an empty archive.
 *  3. **No server, no session token, no browser window.** Nothing here imports
 *     `src/proxy.ts` or the request gate; it talks to the engine and the DB
 *     directly. Chrome still launches — headless, inside the forked worker —
 *     because that is what an audit *is*.
 *
 * Options:
 *   Targets
 *     <url> ...                positional URLs (bare hosts get `https://`)
 *     --urls-file <path>       newline-delimited URL file (`#` comments ignored)
 *     --crawl <seed>           discover pages from a seed URL
 *     --max-pages=N            crawl page cap (default 25)
 *     --max-depth=N            crawl BFS depth (default 2)
 *     --no-sitemap             skip sitemap.xml during discovery
 *     --no-follow-links        skip the shallow same-origin crawl
 *     --exclude-paths=a,b      exclude path prefixes / globs from discovery
 *   Audit dials
 *     --runs=N                 runs to take the median of (1–5, default 3)
 *     --device=mobile|desktop|both   emulated form factor (alias: --form-factor)
 *     --throttling=simulated|applied
 *     --cpu=N                  CPU slowdown multiplier (1–20; omit = Lighthouse 4×)
 *     --categories=performance,accessibility,best-practices,seo,agentic-browsing
 *     --no-warm-cache          cold first-visit (default is warm = DevTools parity)
 *     --user-agent="…"         override the emulated page UA (alias: --ua)
 *     --concurrency=N          parallel audits (1–8, default 3)
 *     --accuracy               force one audit at a time when Performance is scored
 *   CI
 *     --budget=N               one pass bar for every category
 *     --config=<path>          JSON budget file (per-category bars)
 *     --reporter=json|jsonExpanded|csv|html
 *     --output=<path>          write the report to a file instead of stdout
 *     --json                   print each run's own result JSON (developer flag)
 *     --help
 *
 * Exit codes: 0 every budget met · 1 a violation (or an audit that failed) ·
 * 2 a usage error — bad flags, an unreadable config, no targets.
 *
 * **One file on purpose.** The argument parsing below is pure and unit-tested
 * (`audit-cli.test.ts`), which would normally argue for its own module — but a
 * relative import between two `scripts/*.ts` files cannot be written in a form
 * that satisfies both Node's native resolver (which demands the `.ts` extension)
 * and `tsc` (which rejects it without `allowImportingTsExtensions`). The exports
 * are the seam; `main()` runs only when this file is the entry point, so the
 * test imports the parser without launching an audit.
 */

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { BudgetError, evaluateBudgets, resolveBudgets } from "@/lib/ci/budgets";
import { renderCiReport } from "@/lib/ci/reporters";
import { runBatchToCompletion } from "@/lib/ci/runBatch";
import {
  CI_REPORTERS,
  EXIT_FAIL,
  EXIT_PASS,
  EXIT_USAGE,
  type BudgetViolation,
  type CiBudgets,
  type CiPage,
  type CiReporter,
  type CiReport,
} from "@/lib/ci/types";
import { discover } from "@/lib/crawl/discover";
import {
  DEFAULT_DEPTH,
  DEFAULT_PAGES,
  DEFAULT_USE_CRAWL,
  DEFAULT_USE_SITEMAP,
  MAX_EXCLUDE_PATHS,
  MAX_EXCLUDE_PATH_LENGTH,
  clampDepth,
  clampPages,
  type DiscoverInput,
} from "@/lib/crawl/types";
import { resolveAuditOptions } from "@/lib/lighthouse/options";
import {
  type AuditOptions,
  type CategoryScores,
  type CoreWebVitals,
  type DeviceSelection,
  LIGHTHOUSE_CATEGORIES,
  METRIC_IDS,
} from "@/lib/lighthouse/types";
import { getAuditQueue } from "@/lib/queue/AuditQueue";
import {
  DEFAULT_CONCURRENCY,
  clampConcurrency,
  type AuditResultLite,
} from "@/lib/queue/types";
import { safeText } from "@/lib/text/displaySafe";
import {
  UrlNormalizeError,
  normalizeAuditUrl,
} from "@/lib/urls/normalizeAuditUrl";

/** Longest untrusted message echoed into our own output. */
const MAX_MESSAGE_LENGTH = 200;

const USAGE = `Usage: npm run audit -- <url> [<url> ...] [options]
       npm run ci    -- <url> [...] --budget <n> [--reporter <fmt>]

Targets     <url> ... | --urls-file <path> | --crawl <seed>
            --max-pages=N --max-depth=N --no-sitemap --no-follow-links
            --exclude-paths=/admin,*.pdf
Audit       --runs=N --device=mobile|desktop|both --throttling=simulated|applied
            --cpu=N --categories=a,b --no-warm-cache --user-agent="…"
            --concurrency=N --accuracy
CI          --budget=N --config=<path> --reporter=json|jsonExpanded|csv|html
            --output=<path> --json

Exit codes  0 budgets met · 1 violation or failed audit · 2 usage error`;

/* -------------------------------------------------------------------------- */
/* Argument parsing (pure)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A flag or argument combination the CLI cannot act on. Maps to `EXIT_USAGE`.
 *
 * Everything that can be rejected without launching Chrome is rejected as one of
 * these, up front: a typo in `--reporter` surfacing thirty seconds into a Chrome
 * run, as an exception, would read to a pipeline like the site regressed.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/**
 * Crawl target: exactly a {@link DiscoverInput} minus its credentials. Handed
 * straight to `discover()` — one crawler, not a second one.
 */
export type CrawlSpec = Omit<DiscoverInput, "auth">;

/** Fully-parsed, fully-validated invocation. */
export interface CliOptions {
  /** Positional URLs, scheme-normalized. */
  urls: string[];
  /** Path to a newline-delimited URL file, or null. */
  urlsFile: string | null;
  /** Crawl target, or null. */
  crawl: CrawlSpec | null;
  /**
   * Device selection for the batch, or null to inherit the resolved audit
   * options' form factor (so the default lives in one place — the schema).
   */
  device: DeviceSelection | null;
  /** Raw option input for `resolveAuditOptions`, which owns validation. */
  auditOptions: Record<string, unknown>;
  concurrency: number;
  accuracyMode: boolean;
  /**
   * The raw `--budget <n>` text, or null. Deliberately NOT converted here:
   * `resolveBudgets` takes the string so it can reject `0x5a` and `1e9`, which
   * `Number()` would happily turn into a bar nobody meant.
   */
  budget: string | null;
  /** `--config <path>` (a JSON budget file), or null. */
  configPath: string | null;
  /** `--reporter <fmt>`, or null for the human-readable developer output. */
  reporter: CiReporter | null;
  /** `--output <path>`, or null for stdout. Requires a reporter. */
  outputPath: string | null;
  /** Legacy `--json`: dump each run's own result instead of a summary. */
  json: boolean;
  help: boolean;
}

/**
 * Flags that never consume the next argument.
 *
 * The original parser treated any `--flag` followed by a non-`--` token as
 * `--flag value`, which silently ate the URL in `--json https://example.com`.
 * With targets now arriving from three places and CI users composing longer
 * command lines, that failure mode (a usage error blamed on the wrong flag)
 * costs more than the table costs to maintain. `--flag=value` still works for
 * everything.
 */
const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "accuracy",
  "cold",
  "no-warm-cache",
  "no-sitemap",
  "no-follow-links",
]);

/** Raw `--key=value` / `--key value` / `--flag` split, plus positionals. */
export interface ParsedFlags {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Split an argv tail into positionals and flags. Never throws. */
export function parseFlags(argv: string[]): ParsedFlags {
  const positionals: string[] = [];
  // Null-prototype: a flag named `--constructor` or `--toString` would
  // otherwise read back an inherited member rather than "absent". Not reachable
  // with today's flag names, which is why it is cheap to remove the class of
  // bug entirely — the same treatment Phase B's L3 gave header maps.
  const flags: Record<string, string | boolean> = Object.create(null);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (
      !BOOLEAN_FLAGS.has(body) &&
      i + 1 < argv.length &&
      !argv[i + 1].startsWith("--")
    ) {
      flags[body] = argv[i + 1];
      i += 1;
    } else {
      flags[body] = true;
    }
  }

  return { positionals, flags };
}

/**
 * Turn a target as typed into the exact URL that will be audited, or refuse it.
 *
 * A bare host gets `https://`, then the whole thing goes through WHATWG `URL` —
 * which is the point, not a formality. Three things fall out of parsing that a
 * regex cannot give:
 *
 *  1. **`user:pass@host` is REFUSED** (ROADMAP Phase F security review, H2).
 *     `POST /api/audits` already rejects userinfo, and its schema says why: the
 *     URL is written verbatim into `runs.url`, so a credential there defeats the
 *     whole of Phase B, which exists to keep credentials out of SQLite. The CLI
 *     is a second entry point to the same archive and was missing the check —
 *     and it is the worse one, because a CI job would then publish that URL in
 *     the report it uploads as a build artifact. Refusing (rather than silently
 *     stripping, as crawl discovery does for links it found) is right here: the
 *     user typed this, so they should be told, and pointed at the mechanism that
 *     handles it properly.
 *  2. **Only http/https** — `file:`, `data:` and friends are not pages to audit.
 *  3. **Control characters cannot survive.** `parseUrlList` splits on `\r?\n`,
 *     so a lone CR mid-line reaches here; `URL` percent-encodes it, which stops
 *     a `--urls-file` line forging output when the target is echoed to a CI log
 *     (the same forging Phase C's L1 found in alert lines).
 *
 * Throws {@link CliUsageError}, so a bad target costs a usage exit code up front
 * rather than thirty seconds inside Chrome.
 */
export function normalizeUrl(raw: string): string {
  // Thin wrapper over the shared normaliser (Phase G): the rules — refuse
  // control characters, refuse a non-http scheme, refuse embedded credentials,
  // and return the string AS TYPED so the archive doesn't split — moved to
  // `@/lib/urls/normalizeAuditUrl` when the MCP server became a second door into
  // the same History. Only the error TYPE is this file's, because `main` routes
  // `CliUsageError` to exit code 2 (a bad invocation), not 1 (a regression).
  try {
    return normalizeAuditUrl(raw);
  } catch (error) {
    if (error instanceof UrlNormalizeError) throw new CliUsageError(error.message);
    throw error;
  }
}

/**
 * A value echoed back into an error message: control characters stripped, then
 * clamped.
 *
 * Clamping alone was not enough (Phase F security re-review, L-d). Refusing a
 * target is still ECHOING it, so an ESC or CR in a `--urls-file` line could
 * forge the log line from the rejection path after `displayUrl` closed it on the
 * success path. `displayUrl` already does exactly this, so reuse it rather than
 * keeping two nearly-identical strips that can drift.
 */
function clampForMessage(value: string): string {
  const cleaned = displayUrl(value);
  return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 79)}…`;
}

/**
 * Parse a `--urls-file`: one URL per line, `#` comment lines and blank lines
 * ignored, order preserved, duplicates dropped.
 *
 * Only a line that *starts* with `#` is a comment — a `#` inside a line is a URL
 * fragment, and silently truncating `…/docs#install` would audit the wrong page.
 */
export function parseUrlList(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const url = normalizeUrl(trimmed);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** A flag's string value, or `undefined`. Throws when the value is missing. */
function value(
  flags: Record<string, string | boolean>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const raw = flags[name];
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      throw new CliUsageError(`--${name} needs a value`);
    }
    return raw;
  }
  return undefined;
}

/** A flag's numeric value, or `undefined`. Throws on a non-numeric value. */
function numberValue(
  flags: Record<string, string | boolean>,
  ...names: string[]
): number | undefined {
  const raw = value(flags, ...names);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(
      `--${names[0]} must be a number (got "${clampForMessage(raw)}")`,
    );
  }
  return parsed;
}

/** True when a boolean-shaped flag is set as `--flag` or `--flag=true`. */
function boolValue(
  flags: Record<string, string | boolean>,
  ...names: string[]
): boolean {
  return names.some((name) => flags[name] === true || flags[name] === "true");
}

/** Split a comma-separated list flag into trimmed, non-empty entries. */
function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Parse the crawl target and its bounds, or null when `--crawl` is absent. */
function parseCrawl(flags: Record<string, string | boolean>): CrawlSpec | null {
  const seed = value(flags, "crawl");
  // Crawl-only dials without a seed are almost always a mistyped invocation
  // (`--max-pages 20` with a pasted URL list). Silently ignoring them is how a
  // CI run audits the wrong set of pages and nobody notices.
  const crawlOnly = [
    "max-pages",
    "max-depth",
    "exclude-paths",
    "no-sitemap",
    "sitemap",
    "no-follow-links",
    "follow-links",
  ].filter((name) => flags[name] !== undefined);
  if (seed === undefined) {
    if (crawlOnly.length > 0) {
      throw new CliUsageError(
        `--${crawlOnly[0]} only applies with --crawl <seed-url>`,
      );
    }
    return null;
  }

  const excludePaths = splitList(value(flags, "exclude-paths"));
  if (excludePaths.length > MAX_EXCLUDE_PATHS) {
    throw new CliUsageError(
      `--exclude-paths accepts at most ${MAX_EXCLUDE_PATHS} patterns`,
    );
  }
  if (excludePaths.some((p) => p.length > MAX_EXCLUDE_PATH_LENGTH)) {
    throw new CliUsageError(
      `--exclude-paths patterns are limited to ${MAX_EXCLUDE_PATH_LENGTH} characters`,
    );
  }

  return {
    url: normalizeUrl(seed),
    useSitemap:
      boolValue(flags, "no-sitemap") || flags["sitemap"] === "false"
        ? false
        : DEFAULT_USE_SITEMAP,
    useCrawl:
      boolValue(flags, "no-follow-links") || flags["follow-links"] === "false"
        ? false
        : DEFAULT_USE_CRAWL,
    maxDepth: clampDepth(numberValue(flags, "max-depth") ?? DEFAULT_DEPTH),
    maxPages: clampPages(numberValue(flags, "max-pages") ?? DEFAULT_PAGES),
    excludePaths,
  };
}

/**
 * Map the audit dials onto the raw shape `resolveAuditOptions` validates.
 * Deliberately does no validating of its own — the schema owns those messages,
 * and duplicating its bounds here is how the two drift apart.
 */
function parseAuditDials(
  flags: Record<string, string | boolean>,
  device: DeviceSelection | null,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  // `"both"` is a batch-level fan-out, not a form factor the engine can run, so
  // it never reaches the options (the queue expands it into per-device jobs).
  if (device !== null && device !== "both") options.formFactor = device;

  const throttling = value(flags, "throttling");
  if (throttling !== undefined) options.throttling = throttling;

  const runs = numberValue(flags, "runs");
  if (runs !== undefined) options.runs = runs;

  const cpu = numberValue(flags, "cpu", "cpu-multiplier", "cpu-slowdown");
  if (cpu !== undefined) options.cpuSlowdownMultiplier = cpu;

  // Warm cache is on by default (DevTools-panel parity); these opt back into a
  // strict cold first-visit.
  if (
    boolValue(flags, "no-warm-cache", "cold") ||
    flags["warm-cache"] === "false"
  ) {
    options.warmCache = false;
  }

  const categories = value(flags, "categories");
  if (categories !== undefined) options.categories = splitList(categories);

  const userAgent = value(flags, "user-agent", "ua");
  if (userAgent !== undefined) options.emulatedUserAgent = userAgent;

  return options;
}

/**
 * Parse and validate a full argv tail. Throws {@link CliUsageError} for anything
 * the CLI can reject without launching Chrome.
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const { positionals, flags } = parseFlags(argv);

  const deviceRaw = value(flags, "device", "form-factor");
  let device: DeviceSelection | null = null;
  if (deviceRaw !== undefined) {
    if (
      deviceRaw !== "mobile" &&
      deviceRaw !== "desktop" &&
      deviceRaw !== "both"
    ) {
      throw new CliUsageError(
        `--device must be mobile, desktop or both (got "${clampForMessage(deviceRaw)}")`,
      );
    }
    device = deviceRaw;
  }

  const reporterRaw = value(flags, "reporter");
  let reporter: CiReporter | null = null;
  if (reporterRaw !== undefined) {
    if (!(CI_REPORTERS as readonly string[]).includes(reporterRaw)) {
      throw new CliUsageError(
        `--reporter must be one of ${CI_REPORTERS.join(", ")} (got "${clampForMessage(reporterRaw)}")`,
      );
    }
    reporter = reporterRaw as CiReporter;
  }

  const json = boolValue(flags, "json");
  // Both write to stdout; letting them coexist emits a summary spliced into a
  // JSON document, which no consumer can parse.
  if (json && reporter !== null) {
    throw new CliUsageError("--json and --reporter cannot be combined");
  }

  const outputPath = value(flags, "output") ?? null;
  if (outputPath !== null && reporter === null) {
    throw new CliUsageError("--output requires --reporter <format>");
  }

  return {
    urls: positionals.map(normalizeUrl),
    urlsFile: value(flags, "urls-file", "url-file") ?? null,
    crawl: parseCrawl(flags),
    device,
    auditOptions: parseAuditDials(flags, device),
    concurrency: clampConcurrency(
      numberValue(flags, "concurrency") ?? DEFAULT_CONCURRENCY,
    ),
    accuracyMode: boolValue(flags, "accuracy"),
    budget: value(flags, "budget") ?? null,
    configPath: value(flags, "config") ?? null,
    reporter,
    outputPath,
    json,
    help: boolValue(flags, "help"),
  };
}

/* -------------------------------------------------------------------------- */
/* Untrusted text                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Flatten a failure message for our own output.
 *
 * A run's `errorMessage` can carry text derived from the audited page, and this
 * output lands in a CI log. Control characters (ANSI escapes especially) could
 * repaint or truncate a build log, so strip them here rather than trusting every
 * consumer downstream.
 */
/**
 * A URL rendered safe to print into a CI log.
 *
 * Target URLs are untrusted in both directions: a `--urls-file` line can carry a
 * lone CR (`parseUrlList` splits on `\r?\n`), and a crawl takes its URLs from
 * the audited site's own links and sitemap. An ESC or CR echoed unfiltered lets
 * that input rewrite the log line around it — the same forging ROADMAP Phase C's
 * L1 found in alert lines. `normalizeUrl` deliberately does NOT mangle the
 * address it stores and audits (see its note), so the cleaning belongs here, at
 * the point of output.
 *
 * Separate from {@link sanitizeMessage} only because that one answers "unknown
 * error" for an empty string, which is the right fallback for a message and the
 * wrong one for a URL.
 */
export function displayUrl(raw: string): string {
  // `safeText` rather than a local strip since Phase G's security review (M1):
  // the control class alone leaves a bidi override intact, so a URL printed here
  // could read as `…/exe.png` while the audit ran against `…/gnp.exe`. Shared
  // with the MCP tools and the URL normaliser so the three cannot drift.
  return safeText(raw, MAX_MESSAGE_LENGTH);
}

export function sanitizeMessage(raw: string | null | undefined): string {
  if (!raw) return "unknown error";
  // Same shared pipeline as `displayUrl`; the only difference is the fallback,
  // which is why these are two functions and not one (see above).
  const cleaned = safeText(raw, MAX_MESSAGE_LENGTH);
  return cleaned === "" ? "unknown error" : cleaned;
}

/** A thrown value as a readable string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Developer output (Phase 1; unchanged shape)                                 */
/* -------------------------------------------------------------------------- */

/** Color a 0–100 score by Lighthouse thresholds (red <50, orange <90, green). */
function colorScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return "  — ";
  const text = String(score).padStart(3, " ");
  const code = score >= 90 ? 32 : score >= 50 ? 33 : 31; // green / yellow / red
  return `\x1b[${code}m${text}\x1b[0m`;
}

function formatScoresLine(scores: CategoryScores): string {
  return LIGHTHOUSE_CATEGORIES.map(
    (id) => `${id} ${colorScore(scores[id])}`,
  ).join("   ");
}

/** Show per-run scores so the variance/spread is visible (PRD reliability goal). */
function formatPerRunSpread(perRun: CategoryScores[]): string {
  return LIGHTHOUSE_CATEGORIES.map((id) => {
    const values = perRun.map((s) => s[id]).filter((v): v is number => v != null);
    if (values.length === 0) return `${id}: —`;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = values.length > 1 ? ` (spread ${min}–${max})` : "";
    return `${id}: [${values.join(", ")}]${spread}`;
  }).join("\n    ");
}

function formatMetrics(metrics: CoreWebVitals): string {
  return METRIC_IDS.map((id) => {
    const m = metrics[id];
    const value = m && m.displayValue ? m.displayValue : "—";
    return `${id.padEnd(26)} ${value}`;
  }).join("\n    ");
}

/**
 * The Phase-1 per-URL summary, printed from the queue's lhr-stripped job result.
 *
 * Nothing is lost by reading the lite view instead of the engine's return value:
 * `AuditResultLite` drops only `median.lhr`, so the per-run spread, the Best
 * Practices audits and the opportunities this prints are all still here — and
 * the ~1 MB LHR never has to be pulled back out of the queue to print a summary.
 */
function printSummary(result: AuditResultLite): void {
  console.log("");
  console.log(`\x1b[1m${result.finalUrl || result.requestedUrl}\x1b[0m`);
  console.log(
    `  Lighthouse ${result.lighthouseVersion} · ${result.options.formFactor} · ` +
      `${result.options.throttling} throttling · median of ${result.runs} run(s) · ` +
      `${result.options.warmCache ? "warm cache (DevTools parity)" : "cold cache"}`,
  );
  console.log(`  Scores   ${formatScoresLine(result.median.scores)}`);
  console.log(`  Per-run scores:\n    ${formatPerRunSpread(result.perRunScores)}`);
  console.log(`  Core Web Vitals:\n    ${formatMetrics(result.median.metrics)}`);

  const bp = result.median.bestPractices;
  if (bp.length > 0) {
    const weighted = bp.filter((a) => a.weight > 0);
    const passW = weighted
      .filter((a) => a.state === "passed")
      .reduce((sum, a) => sum + a.weight, 0);
    const totW = weighted.reduce((sum, a) => sum + a.weight, 0);
    const failed = bp.filter((a) => a.state === "failed");
    console.log(
      `  Best Practices audits: ${passW}/${totW} weight passing` +
        (failed.length > 0 ? `, ${failed.length} failing` : ""),
    );
    for (const a of failed) {
      const dv = a.displayValue ? ` — ${a.displayValue}` : "";
      console.log(`    ✗ ${a.title} (w${a.weight})${dv}`);
    }
  }

  const top = result.median.opportunities.slice(0, 5);
  if (top.length > 0) {
    console.log("  Top opportunities:");
    for (const op of top) {
      const savings =
        op.savingsMs != null ? ` (~${Math.round(op.savingsMs)} ms)` : "";
      console.log(`    • ${op.title}${savings}`);
    }
  }
  if (result.runWarnings.length > 0) {
    console.log("  Warnings:");
    for (const w of result.runWarnings) console.log(`    ! ${w}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolve every target source into one deduped URL list, preserving order:
 * positionals, then the URL file, then whatever discovery found.
 *
 * Discovery reuses `discover()` — the same crawler the UI and the scheduler run,
 * bounds, robots.txt handling and all.
 */
async function resolveTargets(options: CliOptions): Promise<string[]> {
  const seen = new Set<string>();
  const urls: string[] = [];
  const add = (url: string): void => {
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  for (const url of options.urls) add(url);

  if (options.urlsFile !== null) {
    let text: string;
    try {
      text = await readFile(options.urlsFile, "utf8");
    } catch (error) {
      throw new CliUsageError(
        `cannot read --urls-file ${options.urlsFile}: ${messageOf(error)}`,
      );
    }
    const fromFile = parseUrlList(text);
    if (fromFile.length === 0) {
      throw new CliUsageError(`--urls-file ${options.urlsFile} contains no URLs`);
    }
    for (const url of fromFile) add(url);
  }

  if (options.crawl !== null) {
    console.error(`→ Discovering pages from ${options.crawl.url}…`);
    // Best-effort by contract: `discover` never throws, it collects warnings.
    const result = await discover(options.crawl);
    for (const warning of result.warnings) {
      console.error(`  ! ${sanitizeMessage(warning)}`);
    }
    if (result.robotsBlocked) {
      console.error("  ! robots.txt disallows crawling this seed");
    }
    console.error(
      `  found ${result.urls.length} page(s)` +
        (result.totalFound > result.urls.length
          ? ` (of ${result.totalFound}, capped at --max-pages)`
          : ""),
    );
    for (const discovered of result.urls) add(discovered.url);
  }

  return urls;
}

/* -------------------------------------------------------------------------- */
/* Batch execution                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Submitting a batch, waiting for it, and reading back the rows it archived now
 * live in `@/lib/ci/runBatch` (imported above). They were written here in Phase
 * F and moved out in Phase G, when the MCP server became a second caller: the
 * settlement rule and the "judge what was PERSISTED" rule are the CI contract
 * itself, and a second copy of either is exactly the fork Phase G forbids. The
 * verdict below stays here, because a build's exit code is this command's alone.
 */

/* -------------------------------------------------------------------------- */
/* Verdict                                                                     */
/* -------------------------------------------------------------------------- */

/** One violation as a line a human scanning a red build can act on. */
export function describeViolation(
  violation: BudgetViolation,
  page: Pick<CiPage, "errorMessage">,
): string {
  const { category, budget, score, reason } = violation;
  switch (reason) {
    case "below":
      return `${category} ${score} < ${budget}`;
    case "unscored":
      return `${category} not scored (budget ${budget})`;
    case "error":
      return `${category} not measured (budget ${budget}) — ${sanitizeMessage(page.errorMessage)}`;
  }
}

/**
 * Print the verdict to **stderr**, naming every failing page and category.
 *
 * stderr on purpose: `--reporter` owns stdout, and a red build's first line of
 * evidence must not depend on which reporter someone picked.
 */
function printVerdict(report: CiReport, budgeted: boolean): void {
  const { pages, passed, failed, errored } = report.totals;

  if (report.violations.length > 0) {
    console.error("");
    console.error(
      `✗ ${report.violations.length} budget violation(s) across ${failed} of ${pages} page(s):`,
    );
    for (const page of report.pages) {
      if (page.violations.length === 0) continue;
      console.error(`  ${displayUrl(page.url)} [${page.formFactor}]`);
      for (const violation of page.violations) {
        console.error(`      ${describeViolation(violation, page)}`);
      }
    }
    return;
  }

  // No budget failures. An audit that never ran is still a failure (see
  // `exitCodeFor`), so say which of the two green-looking states this is.
  if (errored > 0) {
    console.error("");
    console.error(`✗ ${errored} of ${pages} page(s) failed to audit:`);
    for (const page of report.pages) {
      if (page.status !== "error") continue;
      console.error(
        `  ${displayUrl(page.url)} [${page.formFactor}] — ${sanitizeMessage(page.errorMessage)}`,
      );
    }
    return;
  }

  console.error("");
  console.error(
    budgeted
      ? `✓ ${passed} of ${pages} page(s) met every budget`
      : `✓ ${passed} page(s) audited`,
  );
}

/**
 * The process exit code for a finished report.
 *
 * `report.ok` is the budget verdict and nothing here rewrites it. What this adds
 * is the CLI's own, older contract: **an audit that could not run fails.** With
 * budgets configured that changes nothing (an errored run is already a violation
 * of every bar), so it matters in exactly one case — no budgets, a crashed
 * audit — where `evaluateBudgets` correctly has nothing to judge and exiting 0
 * would report success for a run that produced no measurement at all.
 */
export function exitCodeFor(report: CiReport): number {
  // Exactly `report.ok`, and deliberately nothing else. This used to add
  // `&& totals.errored === 0`, which produced the right exit code by the wrong
  // route: `evaluateBudgets` still reported `ok: true`, so a pipeline parsing
  // the JSON read green while the process exited 1. The errored rule now lives
  // in `evaluateBudgets`, where `ok` is computed, so the two can never disagree.
  return report.ok ? EXIT_PASS : EXIT_FAIL;
}

/* -------------------------------------------------------------------------- */
/* I/O                                                                         */
/* -------------------------------------------------------------------------- */

/** Read and parse a `--config` JSON file. `resolveBudgets` validates the shape. */
async function readBudgetConfig(path: string | null): Promise<unknown> {
  if (path === null) return undefined;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new CliUsageError(`cannot read --config ${path}: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Deliberately NOT `messageOf(error)`: V8's JSON parse errors embed a
    // snippet of the file ("Unexpected token 'L', \"LH_AUDIT_B\"... is not valid
    // JSON"), so pointing `--config` at `.env` or at the session-token file
    // would print bytes of it into a CI log. `describeValue` in `budgets.ts`
    // truncates for the same reason; this was the one raw pass-through.
    throw new CliUsageError(`--config ${path} is not valid JSON.`);
  }
}

/** Write a rendered report to `--output`, or to stdout. */
async function writeReport(
  text: string,
  outputPath: string | null,
): Promise<void> {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  if (outputPath === null) {
    process.stdout.write(body);
    return;
  }
  // 0600: a report embeds every audited URL, and Phase B made those able to be
  // staging or logged-in pages. The default 0644 makes that world-readable on a
  // shared machine for no benefit. (An existing file keeps its own mode, and a
  // symlinked path is still followed — a caller-chosen path in a single-user
  // tool, noted rather than fought.)
  await writeFile(outputPath, body, { encoding: "utf8", mode: 0o600 });
  console.error(`  report written to ${outputPath}`);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

/** Report a usage problem and set the exit code a pipeline reads as "bad invocation". */
function usage(message: string): void {
  console.error(message);
  console.error("");
  console.error(USAGE);
  process.exitCode = EXIT_USAGE;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) return usage(error.message);
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  // Everything that can be rejected without launching Chrome is rejected here,
  // in the order a user would fix it: dials, then budgets, then targets.
  let auditOptions: AuditOptions;
  try {
    auditOptions = resolveAuditOptions(options.auditOptions);
  } catch (error) {
    return usage(messageOf(error));
  }

  let budgets: CiBudgets;
  try {
    budgets = resolveBudgets({
      flag: options.budget ?? undefined,
      config: await readBudgetConfig(options.configPath),
    });
  } catch (error) {
    if (error instanceof CliUsageError || error instanceof BudgetError) {
      return usage(error.message);
    }
    throw error;
  }

  // A bar on a category this run won't measure is not a silent no-op: the run
  // produces no score for it, and an unscored budgeted category is a violation
  // (decision 2 — CI does not go green on the unknown). That is right for a
  // category that was measured and came back empty, and baffling for one that
  // was never asked for, so say so before spending a minute in Chrome.
  const unmeasured = Object.keys(budgets).filter(
    (category) =>
      !(auditOptions.categories as readonly string[]).includes(category),
  );
  if (unmeasured.length > 0) {
    console.error(
      `! Budgets set for ${unmeasured.join(", ")}, which --categories does not ` +
        `run. Those will fail as unscored — add them to --categories, or budget ` +
        `only what you measure.`,
    );
  }

  let urls: string[];
  try {
    urls = await resolveTargets(options);
  } catch (error) {
    if (error instanceof CliUsageError) return usage(error.message);
    throw error;
  }
  if (urls.length === 0) {
    return usage("No URLs to audit. Pass a URL, --urls-file, or --crawl.");
  }

  const queue = getAuditQueue();
  const device = options.device ?? auditOptions.formFactor;

  // Ctrl-C cancels through the queue rather than orphaning Chrome children: the
  // batch goes terminal, the workers are killed, and the runs that DID finish
  // stay in History and still get reported below. The handler is installed from
  // `onBatchCreated` because it needs the batch id, and that is the first moment
  // one exists.
  let onInterrupt: (() => void) | null = null;

  // With a reporter in play stdout belongs to the report, so progress and the
  // per-URL detail go to stderr; without one this is the Phase-1 developer tool
  // and prints exactly what it always did.
  const quiet = options.reporter !== null;
  const outcome = await runBatchToCompletion(queue, {
    urls,
    device,
    options: auditOptions,
    concurrency: options.concurrency,
    accuracyMode: options.accuracyMode,
    onBatchCreated: (created) => {
      onInterrupt = (): void => {
        console.error("\n… cancelling batch");
        queue.cancelBatch(created.id);
      };
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onInterrupt);
    },
    onEvent: (event) => {
    if (event.type === "job-started") {
      console.error(
        `→ Auditing ${displayUrl(event.job.url)} [${event.job.device}] ` +
          `(${auditOptions.runs} run(s)) — ` +
          `${event.counts.done + event.counts.error + 1}/${event.counts.total}`,
      );
    } else if (event.type === "job-completed" && event.job.result) {
      const result = event.job.result;
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (quiet) {
        console.error(
          `  ✓ ${displayUrl(event.job.url)} [${event.job.device}] ` +
            LIGHTHOUSE_CATEGORIES.map(
              (id) => `${id} ${result.median.scores[id] ?? "—"}`,
            ).join("  "),
        );
      } else {
        printSummary(result);
      }
    } else if (event.type === "job-failed") {
      console.error(
        `✗ Audit failed for ${displayUrl(event.job.url)} [${event.job.device}]: ` +
          sanitizeMessage(event.job.error?.message),
      );
    }
    },
  });
  if (onInterrupt !== null) {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }

  const { batch: settled, rows, settledJobs, startedAt, finishedAt } = outcome;
  if (rows.length === 0) {
    // Decision 1 in action: no rows means nothing was archived, so there is
    // nothing to judge. Fail loudly rather than report a green build over an
    // empty history.
    console.error(
      settled.status === "cancelled"
        ? "✗ Batch cancelled before any run was persisted."
        : "✗ No runs were persisted for this batch — nothing to judge.",
    );
    process.exitCode = EXIT_FAIL;
    return;
  }

  // Backstop: judge every page we audited, or refuse to judge at all.
  //
  // A gate that silently scores fewer pages than it ran is the worst failure
  // this tool has — it passes a build nobody checked. That is not theoretical:
  // the queue used to mark a job `done` BEFORE awaiting its persist, so
  // `batch-completed` could fire with a row still unwritten and this read would
  // miss it (fixed in `AuditQueue.runJob`, with a regression test). The root
  // cause is gone; this stays because the consequence of it ever coming back is
  // silent, and a loud failure costs nothing.
  //
  // Cancelled batches are exempt: they are SUPPOSED to have fewer rows than
  // jobs, and the branch below reports that honestly.
  if (settled.status !== "cancelled" && rows.length < settledJobs) {
    console.error(
      `✗ Only ${rows.length} of ${settledJobs} finished run(s) reached the archive — ` +
        "refusing to judge a partial batch.",
    );
    process.exitCode = EXIT_FAIL;
    return;
  }

  const evaluation = evaluateBudgets(rows, budgets);
  const report: CiReport = {
    ok: evaluation.ok,
    batchId: settled.id,
    budgets,
    pages: evaluation.pages,
    violations: evaluation.violations,
    totals: evaluation.totals,
    startedAt,
    finishedAt,
  };

  // The verdict is printed even if the report cannot be written, and the write
  // failure is a USAGE error rather than a budget failure.
  //
  // Both halves matter (ROADMAP Phase F security review, M1). Unhandled, a bad
  // `--output` path threw an ENOENT stack trace and exited 1 — so a pipeline saw
  // a stack instead of a verdict, and read the exit code as "the site
  // regressed", after paying for the whole audit. An unwritable directory is a
  // misconfiguration, which is exactly what EXIT_USAGE exists to distinguish.
  let writeFailure: string | null = null;
  if (options.reporter !== null) {
    try {
      await writeReport(
        renderCiReport(report, options.reporter),
        options.outputPath,
      );
    } catch (error) {
      writeFailure = messageOf(error);
    }
  }

  printVerdict(report, Object.keys(budgets).length > 0);

  if (writeFailure !== null) {
    console.error(`✗ Could not write the report: ${writeFailure}`);
    // Deliberately overrides the budget verdict: the audit may have passed, but
    // the artefact the invocation asked for does not exist, so reporting success
    // would be a lie a pipeline acts on.
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (settled.status === "cancelled") {
    console.error(
      `! Batch was cancelled; ${rows.length} of ${settled.counts.total} run(s) completed.`,
    );
    process.exitCode = EXIT_FAIL;
    return;
  }
  process.exitCode = exitCodeFor(report);
}

/**
 * Run only when invoked as a script. The unit tests import the pure parsing
 * exports above from this same file (see the module docblock), and importing
 * them must not start an audit.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // A top-level catch, so no failure reaches the terminal as an unhandled
  // rejection: that prints a stack trace with absolute paths and exits 1, which
  // in a pipeline is indistinguishable from a budget failure. `main` already
  // handles everything it expects; this is for what it does not.
  void main().catch((error: unknown) => {
    console.error(`✗ ${messageOf(error)}`);
    process.exitCode = EXIT_USAGE;
  });
}
