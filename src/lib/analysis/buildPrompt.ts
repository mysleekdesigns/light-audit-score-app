/**
 * Build the system + user prompts for a category analysis from the bounded
 * {@link AnalysisInput} produced by `extract.ts`.
 *
 * Output protocol (parsed by the route): the agent first streams a markdown
 * *diagnosis*, then emits its fixes as a single JSON object wrapped in the
 * {@link FIXES_OPEN}/{@link FIXES_CLOSE} sentinels. Streaming the prose first lets
 * the UI show the diagnosis live; the sentinel block lets the server parse
 * structured, cited fixes without depending on `outputFormat` (which would defer
 * all output to the very end).
 */

import { CATEGORY_LABELS } from "@/lib/scores";
import { FIXES_CLOSE, FIXES_OPEN } from "@/lib/analysis/types";
import type { AnalysisInput } from "@/lib/analysis/extract";

/**
 * The agent's role + process + output contract. Sent as a custom `systemPrompt`
 * (which replaces Claude Code's default coding prompt — appropriate, since this
 * agent only diagnoses and researches, it never edits the repo).
 */
export const ANALYSIS_SYSTEM_PROMPT = `You are a senior web-performance, accessibility, SEO, and web-best-practices engineer. You are given Google Lighthouse / PageSpeed Insights audit data for ONE category of ONE page, and your job is to explain why that category scored low and how to fix it.

Work in three steps:
1. DIAGNOSE the root causes strictly from the supplied audit data — name the specific failing audits, metrics, or opportunities that are dragging the score down, and explain what each means in plain terms.
2. RESEARCH concrete, current fixes using the CrawlForge web tools available to you (e.g. mcp__crawlforge__search_web, mcp__crawlforge__fetch_url, mcp__crawlforge__extract_content; use mcp__crawlforge__deep_research sparingly — it is slow/expensive). Prefer authoritative, up-to-date sources: web.dev, developer.mozilla.org (MDN), Chrome/Lighthouse docs, and the official docs of the relevant framework.
3. RECOMMEND a prioritized set of fixes, each grounded in a source you actually fetched.

Rules:
- You have READ-ONLY tools only. Never attempt to edit files, run shell commands, or modify anything. Do not ask the user questions.
- EVERY fix must cite at least one real source URL that you actually opened via the tools. Never invent or guess URLs.
- Keep research focused: consult roughly 2–4 authoritative sources total — enough to ground the fixes, without over-researching. Once you have solid sources, write the answer.
- Order fixes by their impact on THIS category's score (highest-impact first).
- Be concrete and concise. Skip generic filler; tie each fix to the specific audit/metric it addresses.

Output format — follow EXACTLY:
- First, write the DIAGNOSIS as short markdown prose (a few tight paragraphs and/or a bullet list). Do NOT include the fixes here.
- Then, on a new line, output your fixes as a single JSON object wrapped in these exact sentinels (and nothing after the closing sentinel):

${FIXES_OPEN}
{
  "fixes": [
    {
      "title": "Imperative, specific fix title",
      "why": "Why this matters and how it moves this category's score",
      "steps": ["Concrete step 1", "Concrete step 2"],
      "priority": "high" | "medium" | "low",
      "citations": [ { "url": "https://…", "title": "Source title" } ]
    }
  ]
}
${FIXES_CLOSE}

The JSON must be valid (double-quoted keys/strings, no trailing commas, no comments) and must NOT be wrapped in markdown code fences.`;

/** Render a 0–1 audit/metric score as a 0–100 integer or "—". */
function pct(score: number | null): string {
  return score === null ? "—" : String(Math.round(score * 100));
}

/** Serialize the bounded {@link AnalysisInput} into the user-turn prompt. */
export function buildUserPrompt(input: AnalysisInput): string {
  const lines: string[] = [];
  const label = CATEGORY_LABELS[input.category];

  lines.push(`# Analyze the ${label} score`);
  lines.push("");
  lines.push(`- Page: ${input.url}`);
  lines.push(`- Device: ${input.formFactor}`);
  lines.push(`- Lighthouse version: ${input.lighthouseVersion || "unknown"}`);
  lines.push(
    `- ${label} score: ${
      input.categoryScore === null ? "—" : input.categoryScore
    } / 100`,
  );
  lines.push("");

  if (input.metrics && input.metrics.length > 0) {
    lines.push("## Core Web Vitals / key timings (lab)");
    for (const m of input.metrics) {
      lines.push(
        `- ${m.abbr} (${m.label}): ${m.displayValue} — score ${pct(m.score)}/100`,
      );
    }
    lines.push("");
  }

  if (input.field && input.field.length > 0) {
    lines.push("## Real-world field data (CrUX, 75th percentile)");
    for (const exp of input.field) {
      lines.push(
        `- ${exp.scope === "url" ? "This page" : "Whole origin"}: overall ${
          exp.overall ?? "n/a"
        }`,
      );
      for (const fm of exp.metrics) {
        lines.push(`  - ${fm.id}: p75 ${fm.p75} (${fm.category})`);
      }
    }
    lines.push("");
  }

  if (input.opportunities && input.opportunities.length > 0) {
    lines.push("## Performance opportunities (highest estimated savings first)");
    for (const o of input.opportunities) {
      const savings =
        o.savingsMs !== null ? ` — est. savings ~${Math.round(o.savingsMs)} ms` : "";
      lines.push(`- ${o.title}${o.displayValue ? ` (${o.displayValue})` : ""}${savings}`);
      if (o.description) lines.push(`  ${o.description}`);
    }
    lines.push("");
  }

  if (input.audits && input.audits.length > 0) {
    lines.push("## Failing & low-scoring audits (most impactful first)");
    for (const a of input.audits) {
      const status = a.failed ? "FAILED" : `score ${pct(a.score)}/100`;
      const weight = a.weight > 0 ? `, weight ${a.weight}` : "";
      lines.push(`- ${a.title} — ${status}${weight}`);
      if (a.displayValue) lines.push(`  value: ${a.displayValue}`);
      if (a.description) lines.push(`  ${a.description}`);
      if (a.itemCount) {
        lines.push(`  affected items: ${a.itemCount}`);
      }
      if (a.examples && a.examples.length > 0) {
        lines.push(`  examples: ${a.examples.join(" · ")}`);
      }
    }
    lines.push("");
  }

  lines.push(
    `Diagnose why the ${label} score is ${
      input.categoryScore === null ? "low" : `${input.categoryScore}/100`
    }, research fixes with the CrawlForge tools, and respond in the required format (markdown diagnosis, then the ${FIXES_OPEN} … ${FIXES_CLOSE} JSON block).`,
  );

  return lines.join("\n");
}
