/**
 * `check_budget` — judge one archived run against a bar (ROADMAP Phase G).
 *
 * The Phase-F assertion, made callable: hand it a run and some bars and it says
 * pass or fail, with the same rules that decide a pipeline's exit code. It
 * **never audits**. That separation is the point rather than an omission —
 * composing `audit_url` → `runId` → `check_budget` lets an agent judge the run
 * it just took *and* re-judge a month-old baseline against a new bar without
 * paying for Chrome twice.
 *
 * ## Reuse, don't fork
 *
 * `resolveBudgets` and `evaluateBudgets` are imported, not reimplemented. They
 * carry three rules that a second copy would silently get wrong (see
 * `src/lib/ci/budgets.ts` and `src/lib/ci/types.ts`):
 *
 *  1. **The flag is the floor, the config is the exception list.** `budget: 90`
 *     with `budgets: { performance: 70 }` means "90 everywhere, except
 *     performance only has to reach 70". This is INVERTED from the usual
 *     convention where an explicit flag beats a config file, and the tool
 *     description says so out loud — a model that assumes the ordinary
 *     precedence would read a passing build as a failing one.
 *  2. **A run that could not be measured FAILS.** An errored run violates every
 *     budgeted category; a `done` run missing a budgeted category's score
 *     violates that one. CI's job is to refuse to go green on the unknown, and
 *     this is deliberately the opposite of the alert core's rule, where a
 *     missing score is silence.
 *  3. **Only budgeted categories are judged.** A category with no bar is
 *     reported and never fails.
 *
 * ## A failing budget is not a tool failure
 *
 * `ok: false` comes back as an ordinary result with `isError` unset. The bar was
 * checked and the answer is "no", which is exactly what was asked; flagging it
 * as an error would tell the agent to retry the call rather than to fix the
 * page. Only a bad argument or a run that does not exist is an
 * {@link McpToolError} — those are things the caller can actually correct.
 */

import { BudgetError, evaluateBudgets, resolveBudgets } from "@/lib/ci/budgets";
import type { CiBudgets, CiPage, ViolationReason } from "@/lib/ci/types";
import {
  getHistoryRow,
  listHistory,
  type HistoryRow,
} from "@/lib/db/persistence";
import {
  LIGHTHOUSE_CATEGORIES,
  type FormFactor,
  type LighthouseCategory,
} from "@/lib/lighthouse/types";
import {
  optionalInteger,
  optionalNumberRecord,
  optionalString,
  rejectUnknownArgs,
} from "@/lib/mcp/args";
import {
  McpToolError,
  jsonResult,
  type McpTool,
  type McpToolResult,
} from "@/lib/mcp/types";
import { safeText } from "@/lib/text/displaySafe";
import { auditUrlKey } from "@/lib/urls/normalizeAuditUrl";

/** The arguments this tool accepts; `rejectUnknownArgs` enforces the list. */
const CHECK_BUDGET_ARGS = ["runId", "url", "budget", "budgets"] as const;

/** A Lighthouse score, and therefore a bar, is 0–100. */
const MIN_BUDGET = 0;
const MAX_BUDGET = 100;

/** Longest run id accepted. Ids are nanoids (21 chars); this is slack, not a shape check. */
const MAX_RUN_ID_CHARS = 128;

/** Longest URL echoed into a payload. Matches the CI reporters' own URL budget. */
const MAX_URL_CHARS = 300;

/** Longest failure message echoed into the summary sentence. @see MAX_URL_CHARS */
const MAX_ERROR_CHARS = 400;

/** One budgeted category this run missed. */
export interface CheckBudgetViolation {
  category: LighthouseCategory;
  /** The measured score, or `null` when there was none to measure. */
  score: number | null;
  /** The bar it had to clear. */
  budget: number;
  /** `"below"` scored under the bar · `"unscored"` no score · `"error"` the run failed. */
  reason: ViolationReason;
}

/** The verdict on one archived run. */
export interface CheckBudgetPayload {
  /** `true` only when every budgeted category cleared its bar AND the run succeeded. */
  ok: boolean;
  runId: string;
  url: string;
  device: FormFactor;
  status: "done" | "error";
  /** The bars actually applied, after flag + per-category resolution. */
  budgets: CiBudgets;
  /** Median category scores, 0–100. A category that was not scored is ABSENT. */
  scores: Partial<Record<LighthouseCategory, number>>;
  /** Every miss, in canonical category order. Empty when `ok` is true. */
  violations: CheckBudgetViolation[];
  /** One sentence a person could paste into a commit message. */
  summary: string;
}

/**
 * Scores in canonical category order, absent where there is no number.
 *
 * The same projection `./audit-url` applies, and for the same reason: a
 * `HistoryRow` carries all five keys with `null` standing for three different
 * kinds of "not scored", and spending tokens on five nulls says nothing the
 * `violations` list does not already say better (`reason: "unscored"` names the
 * budgeted ones, which are the only ones that matter here).
 */
function projectScores(
  scores: HistoryRow["scores"],
): Partial<Record<LighthouseCategory, number>> {
  const out: Partial<Record<LighthouseCategory, number>> = {};
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const value = scores[category];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[category] = value;
    }
  }
  return out;
}

/** One miss as a phrase, e.g. `performance 71 < 90`. */
function describeViolation(violation: CheckBudgetViolation): string {
  switch (violation.reason) {
    case "below":
      return `${violation.category} ${violation.score} < ${violation.budget}`;
    case "unscored":
      return `${violation.category} not scored (bar ${violation.budget})`;
    case "error":
      return `${violation.category} not measured (bar ${violation.budget})`;
  }
}

/**
 * The verdict as one sentence.
 *
 * Worth the tokens because it is the part a model quotes back to a person: the
 * structured fields answer "what", and this answers "so?". It deliberately does
 * NOT repeat the URL — that is already a field, and echoing untrusted text twice
 * is twice the surface for no extra information.
 *
 * Exported because it is pure, and because "an errored run reads as a failure,
 * not as a pass with nothing to report" is a property worth pinning in a test.
 */
export function summarizeVerdict(page: CiPage, budgets: CiBudgets): string {
  const budgeted = Object.keys(budgets).length;
  const noun = budgeted === 1 ? "category" : "categories";

  if (page.status === "error") {
    // Every budgeted category is already a violation with `reason: "error"`, so
    // listing them would be five copies of one fact. The failure text is what
    // the caller can act on.
    return (
      `Failed: the run itself errored, so nothing was measured and all ${budgeted} ` +
      `budgeted ${noun} count as missed — ` +
      safeText(page.errorMessage ?? "unknown error", MAX_ERROR_CHARS)
    );
  }

  if (page.violations.length === 0) {
    return `Passed: all ${budgeted} budgeted ${noun} met their bar.`;
  }

  const detail = page.violations
    .map((violation) =>
      describeViolation({
        category: violation.category,
        score: violation.score,
        budget: violation.budget,
        reason: violation.reason,
      }),
    )
    .join(", ");
  return (
    `Failed: ${page.violations.length} of ${budgeted} budgeted ${noun} ` +
    `missed their bar — ${detail}.`
  );
}

/**
 * The most recent archived run for a page.
 *
 * Matched on `auditUrlKey` rather than on the stored string, so a lookup does
 * not miss because one caller wrote a trailing slash and another did not, and
 * against BOTH `url` and `finalUrl` so `example.com` finds the run that
 * redirected to `www.example.com`. `listHistory()` is newest-first, so the first
 * hit is the answer.
 *
 * This branch does read the whole archive, unlike the `runId` one: the match is
 * on a NORMALISED key (`auditUrlKey`), which SQLite has no index for, so there
 * is nothing to push down into the query. `.find` stops at the first hit but
 * `listHistory()` has already mapped every row by then. Accepted rather than
 * fixed (Phase G security review, L-d): an agent that repeats a judgement uses
 * `runId`, which is now a single-row read, and a URL lookup is what a caller
 * does once before it has an id.
 */
function findLatestRunForKey(key: string): HistoryRow | undefined {
  return listHistory().find(
    (row) =>
      auditUrlKey(row.url) === key ||
      (row.finalUrl !== null && auditUrlKey(row.finalUrl) === key),
  );
}

const DESCRIPTION = `Judge an already-archived Lighthouse run against score budgets. Pass or fail, with the same \
rules a CI pipeline's exit code uses. It never audits anything, so it is instant and free.

Name the run either by "runId" (from audit_url or get_history) or by "url" (judges that page's \
most recent archived run) — exactly one of the two.

PRECEDENCE IS INVERTED from the usual convention, deliberately: "budget" is a FLOOR applied to \
every category, and "budgets" is the per-category exception list layered on top. So \
budget: 90 with budgets: {"performance": 70} means "90 everywhere, except performance only has \
to reach 70". Supply at least one of them.

Only budgeted categories are judged; a category with no bar is reported and never fails. \
A run that could not be measured FAILS: an errored run misses every budgeted category, and a \
run carrying no score for a budgeted category misses that one. Refusing to go green on the \
unknown is the whole job.

A failing budget is a normal answer — ok: false, not a tool error. Only a bad argument or a \
run that is not in the archive is an error.`;

export const checkBudgetTool: McpTool = {
  name: "check_budget",
  title: "Check a run against score budgets",
  description: DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      runId: {
        type: "string",
        description:
          "The archived run to judge, as returned by audit_url or get_history. Use this OR url, not both.",
      },
      url: {
        type: "string",
        description:
          "Judge the most recent archived run for this page. Matches a trailing slash either way, and matches the URL a run redirected to. Use this OR runId, not both.",
      },
      budget: {
        type: "integer",
        minimum: MIN_BUDGET,
        maximum: MAX_BUDGET,
        description:
          "A single bar applied to EVERY category — the floor. Combine with budgets to except individual categories from it.",
      },
      budgets: {
        type: "object",
        additionalProperties: { type: "number" },
        description:
          'Per-category bars, e.g. {"performance": 70, "seo": 100}. Layered on top of budget, so these win where both apply. An unknown category name is an error, never a silent skip.',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    // Reads SQLite and nothing else: no Chrome, no network, no writes. An agent
    // that knows this can re-judge a run against a dozen different bars for
    // free, which is most of why the tool is separate from `audit_url`.
    readOnlyHint: true,
    openWorldHint: false,
  },

  async handler(args: Record<string, unknown>): Promise<McpToolResult> {
    rejectUnknownArgs(args, CHECK_BUDGET_ARGS);

    const runId = optionalString(args, "runId", MAX_RUN_ID_CHARS);
    const rawUrl = optionalString(args, "url");
    // Two messages rather than one, because the two mistakes need different
    // corrections: one caller forgot to say which run, the other said it twice.
    if (runId === undefined && rawUrl === undefined) {
      throw new McpToolError(
        'Name the run to judge: pass "runId" (from audit_url or get_history), or "url" to judge that page\'s most recent archived run.',
      );
    }
    if (runId !== undefined && rawUrl !== undefined) {
      throw new McpToolError(
        'Pass "runId" or "url", not both — "url" already means "the most recent archived run for that page".',
      );
    }

    const budget = optionalInteger(args, "budget", {
      min: MIN_BUDGET,
      max: MAX_BUDGET,
    });
    const budgets = optionalNumberRecord(args, "budgets");
    if (budget === undefined && budgets === undefined) {
      throw new McpToolError(
        'Pass "budget" (one bar for every category) and/or "budgets" (per-category bars). With neither there is nothing to check.',
      );
    }

    let resolved: CiBudgets;
    try {
      // `String(budget)` because `resolveBudgets` takes the flag as the raw text
      // a CLI saw; the integer has already been validated by `optionalInteger`,
      // so this only ever produces a decimal string the parser accepts.
      resolved = resolveBudgets({
        flag: budget === undefined ? undefined : String(budget),
        config: budgets,
      });
    } catch (error) {
      // `BudgetError`'s messages already name the offending value AND what would
      // have been accepted — they were written to be the only thing visible in a
      // CI log, which is the same job they do here.
      if (error instanceof BudgetError) throw new McpToolError(error.message);
      throw error;
    }

    // Reachable only via `budgets: {}` with no `budget`. Judging nothing and
    // answering `ok: true` would be a false green of exactly the kind the budget
    // rules exist to prevent, so it is a rejection rather than a trivial pass.
    if (Object.keys(resolved).length === 0) {
      throw new McpToolError(
        'No bars to check against: "budgets" was empty and no "budget" was given. Name at least one category, or pass a blanket "budget".',
      );
    }

    let row: HistoryRow | undefined;
    if (runId !== undefined) {
      // One indexed row, not the whole archive (Phase G security review, L-d).
      // This tool advertises itself as instant and free and carries
      // `readOnlyHint`, so an agent re-judges the same run against a dozen bars
      // without hesitating; each of those used to be a full-table read plus a
      // JSON.parse per row.
      row = getHistoryRow(runId);
      if (!row) {
        throw new McpToolError(
          "No archived run has that id. Run ids come from audit_url or get_history and are not URLs — pass the page's address as \"url\" if that is what you have.",
        );
      }
    } else {
      const key = auditUrlKey(rawUrl as string);
      if (key === null) {
        throw new McpToolError(
          '"url" must be an http or https address, e.g. "https://example.com/pricing".',
        );
      }
      row = findLatestRunForKey(key);
      if (!row) {
        throw new McpToolError(
          "That page has no archived runs. Audit it first with audit_url, or call get_history to see what has been audited.",
        );
      }
    }

    const verdict = evaluateBudgets([row], resolved);
    const page = verdict.pages[0];

    const violations: CheckBudgetViolation[] = page.violations.map(
      (violation) => ({
        category: violation.category,
        score: violation.score,
        budget: violation.budget,
        reason: violation.reason,
      }),
    );

    const payload: CheckBudgetPayload = {
      ok: verdict.ok,
      runId: page.runId,
      url: safeText(page.url, MAX_URL_CHARS),
      device: page.formFactor,
      status: page.status,
      budgets: resolved,
      scores: projectScores(page.scores),
      violations,
      summary: summarizeVerdict(page, resolved),
    };

    // No `isError`, whatever the verdict: the bar was checked and the answer is
    // the answer. See the module docblock.
    return jsonResult({ ...payload });
  },
};
