/**
 * Unit tests for `loadResearchMcpConfig` — how the analysis engine finds the
 * research MCP server it drives for web-grounded fixes.
 *
 * The contract under test is that the research server is a SEPARATE application
 * the user installs and configures: LightAudit reads a standard MCP config,
 * launches what it declares, and never sources a credential of its own. When
 * nothing is configured, resolution returns null and the analysis degrades to a
 * data-only diagnosis rather than failing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadResearchMcpConfig } from "@/lib/analysis/runAnalysis";

/** Env vars this module reads — saved and restored around every test. */
const ENV_KEYS = [
  "LH_RESEARCH_MCP_CONFIG",
  "LH_RESEARCH_MCP_SERVER",
  "RESEARCH_TOKEN",
] as const;

let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(path.join(tmpdir(), "lightaudit-research-"));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Write an MCP config declaring `servers` into `dir` (default filename). */
function writeConfig(servers: Record<string, unknown>, file = ".mcp.json") {
  const target = path.join(dir, file);
  writeFileSync(target, JSON.stringify({ mcpServers: servers }));
  return target;
}

describe("loadResearchMcpConfig", () => {
  it("returns null when no config file exists", () => {
    expect(loadResearchMcpConfig(dir)).toBeNull();
  });

  it("picks the server conventionally named 'research'", () => {
    writeConfig({
      research: { command: "my-research-server", args: ["--stdio"] },
      other: { command: "unrelated" },
    });

    const config = loadResearchMcpConfig(dir);

    expect(config).toMatchObject({
      type: "stdio",
      command: "my-research-server",
      args: ["--stdio"],
    });
    // alwaysLoad keeps the research tools in the prompt AND blocks startup until
    // the stdio server connects — without it the agent races the server and the
    // fixes come back ungrounded.
    expect(config?.alwaysLoad).toBe(true);
  });

  it("uses the only server when there is exactly one and none is named 'research'", () => {
    writeConfig({ anything: { command: "solo-server" } });

    expect(loadResearchMcpConfig(dir)).toMatchObject({ command: "solo-server" });
  });

  it("refuses to guess between several servers when none is named 'research'", () => {
    writeConfig({ alpha: { command: "a" }, beta: { command: "b" } });

    expect(loadResearchMcpConfig(dir)).toBeNull();
  });

  it("honours an explicit server name from LH_RESEARCH_MCP_SERVER", () => {
    writeConfig({
      research: { command: "would-be-default" },
      chosen: { command: "explicitly-picked" },
    });
    process.env.LH_RESEARCH_MCP_SERVER = "chosen";

    expect(loadResearchMcpConfig(dir)).toMatchObject({ command: "explicitly-picked" });
  });

  it("reads a config from LH_RESEARCH_MCP_CONFIG outside the working directory", () => {
    const elsewhere = writeConfig({ research: { command: "external" } }, "custom.json");
    process.env.LH_RESEARCH_MCP_CONFIG = elsewhere;

    // A different cwd with no .mcp.json — resolution must come from the env path.
    const otherDir = mkdtempSync(path.join(tmpdir(), "lightaudit-empty-"));
    try {
      expect(loadResearchMcpConfig(otherDir)).toMatchObject({ command: "external" });
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("overlays declared env values from process.env, keeping the literal otherwise", () => {
    writeConfig({
      research: {
        command: "s",
        env: { RESEARCH_TOKEN: "from-file", OTHER: "literal" },
      },
    });
    process.env.RESEARCH_TOKEN = "from-environment";

    expect(loadResearchMcpConfig(dir)?.env).toEqual({
      RESEARCH_TOKEN: "from-environment",
      OTHER: "literal",
    });
  });

  it("returns null when the named server declares no command", () => {
    writeConfig({ research: { args: ["--stdio"] } });

    expect(loadResearchMcpConfig(dir)).toBeNull();
  });

  it("returns null when the requested server name is absent", () => {
    writeConfig({ research: { command: "s" } });
    process.env.LH_RESEARCH_MCP_SERVER = "missing";

    expect(loadResearchMcpConfig(dir)).toBeNull();
  });

  it("tolerates a malformed config rather than throwing", () => {
    writeFileSync(path.join(dir, ".mcp.json"), "{ not json");

    expect(loadResearchMcpConfig(dir)).toBeNull();
  });

  it("returns null for a config with no mcpServers block", () => {
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ somethingElse: true }));

    expect(loadResearchMcpConfig(dir)).toBeNull();
  });
});
