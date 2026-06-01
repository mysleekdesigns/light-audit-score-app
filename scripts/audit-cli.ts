/**
 * Standalone Lighthouse audit runner (PRD §6 Phase 1).
 *
 *   tsx scripts/audit-cli.ts <url> [<url> ...] [options]
 *
 * Options:
 *   --runs=N                 runs to take the median of (1–5, default 3)
 *   --device=mobile|desktop  emulated form factor (alias: --form-factor)
 *   --throttling=simulated|applied
 *   --cpu=N                  CPU slowdown multiplier (1–20; omit = Lighthouse 4×)
 *   --categories=performance,accessibility,best-practices,seo
 *   --no-warm-cache          cold first-visit (default is warm = DevTools parity)
 *   --user-agent="…"         override the emulated page UA (alias: --ua)
 *   --json                   print the raw AuditResult JSON instead of a summary
 *
 * Exercises the real engine end-to-end (isolated Chrome → lighthouse() →
 * median-of-N). Used to Verify Phase 1: compare its scores to `npx lighthouse <url>`.
 */

import { runAudit } from "@/lib/lighthouse/median";
import { resolveAuditOptions } from "@/lib/lighthouse/options";
import {
  type AuditResult,
  type CategoryScores,
  type CoreWebVitals,
  LIGHTHOUSE_CATEGORIES,
  METRIC_IDS,
} from "@/lib/lighthouse/types";

interface ParsedArgs {
  urls: string[];
  json: boolean;
  options: unknown;
}

/** Parse `--key=value`, `--key value`, and `--flag` plus positional URLs. */
function parseArgs(argv: string[]): ParsedArgs {
  const urls: string[] = [];
  const raw: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      urls.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      raw[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      raw[body] = argv[i + 1];
      i += 1;
    } else {
      raw[body] = true;
    }
  }

  // Map CLI flags onto the audit options shape; resolveAuditOptions validates.
  const optionInput: Record<string, unknown> = {};
  const formFactor = raw["device"] ?? raw["form-factor"];
  if (typeof formFactor === "string") optionInput.formFactor = formFactor;
  if (typeof raw["throttling"] === "string") {
    optionInput.throttling = raw["throttling"];
  }
  if (typeof raw["runs"] === "string") {
    optionInput.runs = Number(raw["runs"]);
  }
  const cpu = raw["cpu"] ?? raw["cpu-multiplier"] ?? raw["cpu-slowdown"];
  if (typeof cpu === "string") {
    optionInput.cpuSlowdownMultiplier = Number(cpu);
  }
  // Warm cache is on by default (DevTools-panel parity). Allow opting back into
  // a strict cold first-visit: `--no-warm-cache`, `--cold`, or `--warm-cache=false`.
  if (
    raw["no-warm-cache"] === true ||
    raw["cold"] === true ||
    raw["warm-cache"] === "false"
  ) {
    optionInput.warmCache = false;
  }
  if (typeof raw["categories"] === "string") {
    optionInput.categories = raw["categories"]
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }
  // Optional emulated-UA override (parity lever for bot-sensitive sites).
  const ua = raw["user-agent"] ?? raw["ua"];
  if (typeof ua === "string") optionInput.emulatedUserAgent = ua;

  return { urls, json: raw["json"] === true, options: optionInput };
}

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

function printSummary(result: AuditResult): void {
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

async function main(): Promise<void> {
  const { urls, json, options } = parseArgs(process.argv.slice(2));

  if (urls.length === 0) {
    console.error(
      "Usage: tsx scripts/audit-cli.ts <url> [<url> ...] " +
        "[--runs=N] [--device=mobile|desktop] [--throttling=simulated|applied] " +
        "[--categories=a,b] [--json]",
    );
    process.exitCode = 1;
    return;
  }

  let resolved;
  try {
    resolved = resolveAuditOptions(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const url of urls) {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const started = Date.now();
    console.error(
      `→ Auditing ${normalized} (${resolved.runs} run(s), ${resolved.formFactor})…`,
    );
    try {
      const result = await runAudit(normalized, resolved);
      if (json) {
        // Drop the bulky raw LHR from stdout JSON; keep the parsed result.
        const { median, ...rest } = result;
        const { scores, metrics, opportunities, bestPractices } = median;
        console.log(
          JSON.stringify(
            { ...rest, median: { scores, metrics, opportunities, bestPractices } },
            null,
            2,
          ),
        );
      } else {
        printSummary(result);
        console.error(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      }
    } catch (error) {
      failures += 1;
      console.error(
        `✗ Audit failed for ${normalized}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  if (failures > 0) process.exitCode = 1;
}

void main();
