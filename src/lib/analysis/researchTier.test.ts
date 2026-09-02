/**
 * Unit tests for how `runAnalysis` resolves the analysis CAPABILITY TIER.
 *
 * The tier is not a property of the provider alone. Claude *supports* web
 * research, but only through a research MCP server the user installs and
 * declares themselves — so an install with no server has a researching provider
 * and no research. Prompting it as a researcher anyway is what makes the agent
 * apologise mid-diagnosis ("I was unable to reach external web-research tools…")
 * or cite a URL it never opened. These tests pin the rule that the tier takes
 * BOTH halves, and that the driver is told which tier it was prompted at.
 *
 * The drivers are mocked: this is about prompt selection, not SDK behaviour.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighthouseResult } from "@/lib/lighthouse/types";
import type { DriverRunArgs } from "@/lib/analysis/providers/types";

const claudeRun = vi.fn();
const openAiRun = vi.fn();
const hasResearch = vi.fn();

vi.mock("@/lib/analysis/providers/claude", () => ({
  claudeDriver: { driver: "claude", run: claudeRun },
}));
vi.mock("@/lib/analysis/providers/openaiCompatible", () => ({
  openAiCompatibleDriver: { driver: "openai-compatible", run: openAiRun },
}));
vi.mock("@/lib/analysis/providers/researchMcp", () => ({
  hasResearchMcpConfig: hasResearch,
  loadResearchMcpConfig: vi.fn(() => null),
}));

const { runAnalysis } = await import("@/lib/analysis/runAnalysis");

/** The smallest LHR that produces a usable analysis input. */
const LHR: LighthouseResult = {
  requestedUrl: "https://example.com/",
  finalDisplayedUrl: "https://example.com/",
  lighthouseVersion: "13.0.0",
  fetchTime: "2026-01-01T00:00:00.000Z",
  configSettings: { formFactor: "mobile" },
  categories: {
    seo: {
      id: "seo",
      score: 0.6,
      auditRefs: [{ id: "document-title", weight: 1 }],
    },
  },
  audits: {
    "document-title": {
      id: "document-title",
      title: "Document has a `<title>` element",
      score: 0,
      scoreDisplayMode: "binary",
    },
  },
};

/** Env vars provider selection reads — reset around every test. */
const ENV_KEYS = [
  "LH_ANALYSIS_PROVIDER",
  "LH_ANALYSIS_MODEL",
  "LH_ANALYSIS_BASE_URL",
  "OLLAMA_MODEL",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  claudeRun.mockReset();
  openAiRun.mockReset();
  hasResearch.mockReset();
  const result = { diagnosis: "d", fixes: [], model: "m", warnings: [] };
  claudeRun.mockResolvedValue(result);
  openAiRun.mockResolvedValue(result);
});

/** Run one analysis and hand back the args the driver was called with. */
async function runAndCapture(run: typeof claudeRun): Promise<DriverRunArgs> {
  await runAnalysis({
    runId: "run-1",
    category: "seo",
    lhr: LHR,
    formFactor: "mobile",
    onEvent: () => {},
  });
  expect(run).toHaveBeenCalledTimes(1);
  return run.mock.calls[0][0] as DriverRunArgs;
}

describe("runAnalysis capability tier", () => {
  it("prompts Claude as a researcher when a research server is configured", async () => {
    process.env.LH_ANALYSIS_PROVIDER = "claude";
    hasResearch.mockReturnValue(true);

    const args = await runAndCapture(claudeRun);

    expect(args.webResearch).toBe(true);
    expect(args.systemPrompt).toContain("mcp__research__");
    expect(args.userPrompt).toContain("research fixes with the available research tools");
  });

  it("drops Claude to the data-only tier when no research server is configured", async () => {
    process.env.LH_ANALYSIS_PROVIDER = "claude";
    hasResearch.mockReturnValue(false);

    const args = await runAndCapture(claudeRun);

    expect(args.webResearch).toBe(false);
    // The honest analyst prompt: no tools promised, and no URLs invited.
    expect(args.systemPrompt).toContain("You have NO tools and NO web access");
    expect(args.systemPrompt).not.toContain("mcp__research__");
    expect(args.userPrompt).toContain('empty "citations" arrays');
  });

  it("never asks about research for a provider that cannot do it", async () => {
    process.env.LH_ANALYSIS_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "llama3.1:8b";

    const args = await runAndCapture(openAiRun);

    expect(args.webResearch).toBe(false);
    // Short-circuited: a provider with no research capability must not pay for a
    // config read to learn what it already knows.
    expect(hasResearch).not.toHaveBeenCalled();
  });
});
