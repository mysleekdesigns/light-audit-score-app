/**
 * The four tools this server exposes (ROADMAP Phase G).
 *
 * Small on purpose. The plan's line is "keep the tool surface small and the
 * payloads compact", and the reason is economic: every tool description is in
 * the model's context for the whole session whether it calls one or not, and
 * every result is paid for again. Four tools cover the loop the phase is
 * actually about —
 *
 *   audit_url ──▶ runId ──┬──▶ check_budget   (does it clear the bar?)
 *                         └──▶ compare_runs   (what changed since <baseline>?)
 *         get_history ────────▶ the baseline run ids to compare against
 *
 * — and anything further (waterfalls, filmstrips, AI analysis) is a screen in
 * the app, where a person can look at it for free.
 *
 * `createTools()` is a function rather than a constant so the tool list is built
 * after the entry point has anchored the process to the project root; a module
 * constant would freeze in whatever order imports happened to run.
 */

import { auditUrlTool } from "@/lib/mcp/tools/audit-url";
import { checkBudgetTool } from "@/lib/mcp/tools/check-budget";
import { compareRunsTool } from "@/lib/mcp/tools/compare-runs";
import { getHistoryTool } from "@/lib/mcp/tools/get-history";
import type { McpTool } from "@/lib/mcp/types";

/**
 * Ordered as an agent meets them: run one, look at the archive, then the two
 * tools that turn a pair of ids into an answer. `tools/list` preserves this
 * order, and a model reading the list top-down should find the workflow in it.
 */
export function createTools(): McpTool[] {
  return [auditUrlTool, getHistoryTool, compareRunsTool, checkBudgetTool];
}
