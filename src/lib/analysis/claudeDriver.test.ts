/**
 * Unit tests for the Claude driver's grounding gate.
 *
 * A citation is a claim that the agent opened a page. The driver may only keep
 * one when the research tools were demonstrably in its hands, because anything
 * it returns otherwise is invented — and `runAnalysis` promotes citations to
 * `sources`, which the analyze route persists to SQLite. So the gate is built on
 * positive evidence (a declared server the SDK reports as `connected`), and
 * every path that lacks that evidence must strip citations AND say why.
 *
 * The Agent SDK is mocked: this is about the driver's own bookkeeping.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FIXES_CLOSE, FIXES_OPEN } from "@/lib/analysis/types";
import type { ResolvedProvider } from "@/lib/analysis/providers/types";

const sdkQuery = vi.fn();
const loadConfig = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdkQuery }));
vi.mock("@/lib/analysis/providers/researchMcp", () => ({
  RESEARCH_MCP_NAME: "research",
  loadResearchMcpConfig: loadConfig,
  hasResearchMcpConfig: vi.fn(),
}));

const { claudeDriver } = await import("@/lib/analysis/providers/claude");

/** A finished response carrying one fix that cites a source. */
const FINAL_TEXT = `Some diagnosis prose.

${FIXES_OPEN}
{"fixes":[{"title":"Compress the hero image","why":"LCP","steps":["Use AVIF"],"priority":"high","citations":[{"url":"https://web.dev/lcp","title":"LCP"}]}]}
${FIXES_CLOSE}`;

const PROVIDER: ResolvedProvider = {
  id: "claude",
  driver: "claude",
  model: "",
  baseUrl: null,
  apiKeyEnv: "ANTHROPIC_API_KEY",
  canWebResearch: true,
  missing: null,
};

/** Drive the SDK mock with an init frame carrying `mcpServers`, then a result. */
function mockSession(mcpServers: Array<{ name: string; status: string }>): void {
  sdkQuery.mockImplementation(() =>
    (async function* () {
      yield {
        type: "system",
        subtype: "init",
        model: "claude-test",
        apiKeySource: "oauth",
        mcp_servers: mcpServers,
      };
      yield { type: "result", subtype: "success", result: FINAL_TEXT, num_turns: 2 };
    })(),
  );
}

/** Run the driver at a given tier and hand back its result. */
function run(webResearch: boolean) {
  return claudeDriver.run({
    provider: PROVIDER,
    systemPrompt: "system",
    userPrompt: "user",
    webResearch,
    onEvent: () => {},
  });
}

beforeEach(() => {
  sdkQuery.mockReset();
  loadConfig.mockReset();
});

describe("claudeDriver grounding gate", () => {
  it("keeps citations when a declared server actually connected", async () => {
    loadConfig.mockReturnValue({ type: "stdio", command: "server" });
    mockSession([{ name: "research", status: "connected" }]);

    const result = await run(true);

    expect(result.fixes[0].citations).toEqual([
      { url: "https://web.dev/lcp", title: "LCP" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("strips citations and explains when no server is configured", async () => {
    loadConfig.mockReturnValue(null);
    mockSession([]);

    const result = await run(false);

    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0].citations).toEqual([]);
    expect(result.warnings[0]).toContain("No research MCP server configured");
  });

  it("strips citations when a declared server failed to connect", async () => {
    loadConfig.mockReturnValue({ type: "stdio", command: "server" });
    mockSession([{ name: "research", status: "failed" }]);

    const result = await run(true);

    expect(result.fixes[0].citations).toEqual([]);
    expect(result.warnings[0]).toContain("status: failed");
  });

  it("strips citations when the SDK never lists the declared server", async () => {
    // The absence of a failure is not evidence of success: an unlisted server is
    // a server whose tools the agent never held.
    loadConfig.mockReturnValue({ type: "stdio", command: "server" });
    mockSession([{ name: "something-else", status: "connected" }]);

    const result = await run(true);

    expect(result.fixes[0].citations).toEqual([]);
    expect(result.warnings[0]).toContain("status: not reported");
  });

  it("strips citations when the engine prompted at the data-only tier", async () => {
    // A config that appeared between the engine's read and the driver's: the
    // model was told it had no tools, so any URL in its output is invented.
    loadConfig.mockReturnValue({ type: "stdio", command: "server" });
    mockSession([{ name: "research", status: "connected" }]);

    const result = await run(false);

    expect(result.fixes[0].citations).toEqual([]);
    // And the warning must not blame a connection we just read as connected.
    expect(result.warnings[0]).toContain("configured after this analysis started");
    expect(result.warnings[0]).not.toContain("did not connect");
  });

  it("still explains itself when the session never reports its MCP state", async () => {
    // No init frame at all: citations are stripped, so the reason has to be
    // stated or the record looks identical to a researched run.
    loadConfig.mockReturnValue({ type: "stdio", command: "server" });
    sdkQuery.mockImplementation(() =>
      (async function* () {
        yield { type: "result", subtype: "success", result: FINAL_TEXT };
      })(),
    );

    const result = await run(true);

    expect(result.fixes[0].citations).toEqual([]);
    expect(result.warnings[0]).toContain("Web research was unavailable");
  });

  it("warns once when a session reports init twice", async () => {
    loadConfig.mockReturnValue(null);
    sdkQuery.mockImplementation(() =>
      (async function* () {
        yield { type: "system", subtype: "init", mcp_servers: [] };
        yield { type: "system", subtype: "init", mcp_servers: [] };
        yield { type: "result", subtype: "success", result: FINAL_TEXT };
      })(),
    );

    const result = await run(false);

    expect(result.warnings).toHaveLength(1);
  });

  it("scrubs a URL out of an SDK-authored failure message", async () => {
    loadConfig.mockReturnValue(null);
    sdkQuery.mockImplementation(() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "error_during_execution",
          errors: ["spawn failed for https://someone:hunter2@research.example.com/mcp"],
        };
      })(),
    );

    await expect(run(false)).rejects.toThrow(/research\.example\.com/);
    await expect(run(false)).rejects.not.toThrow(/hunter2/);
  });

  it("clamps an unexpected status string rather than passing it through", async () => {
    loadConfig.mockReturnValue({ type: "stdio", command: "server" });
    mockSession([
      { name: "research", status: "FAILED <b>x</b> " + "y".repeat(80) },
    ]);

    const result = await run(true);

    expect(result.warnings[0]).not.toContain("<b>");
    expect(result.warnings[0]).toMatch(/status: [a-z0-9 _-]{1,32}\)/);
  });
});
