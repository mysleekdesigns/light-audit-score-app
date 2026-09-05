/**
 * Unit tests for the CrawlForge research-server integration.
 *
 * The contract: CrawlForge is the one NAMED research server, and it is opt-in.
 * It is only launched when the user has switched it on in Settings AND
 * CrawlForge's own setup file exists (the server authenticates itself from it).
 * When active it takes precedence over a server declared in an MCP config;
 * otherwise resolution falls through to that config exactly as before.
 * LightAudit Score never reads or forwards a key — it existence-checks the setup file
 * and reports booleans.
 *
 * Every probe is pointed at temp dirs: the preference store (`LH_DATA_DIR`),
 * the MCP config (`cwd`), and CrawlForge's home-dir setup file (`homeDir`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CRAWLFORGE_PROMPT_GUIDANCE,
  crawlforgeDeclaration,
  crawlforgeSetupOnDisk,
  crawlforgeStatus,
  isCrawlforgeEnabled,
  resolveCrawlforgeVersion,
  setCrawlforgeEnabled,
} from "@/lib/analysis/providers/crawlforge";
import {
  hasResearchMcpConfig,
  loadResearchMcpConfig,
  researchLaunchConfig,
  researchStatus,
  resolveResearchServer,
} from "@/lib/analysis/providers/researchMcp";
import {
  CRAWLFORGE_PACKAGE_NAME,
  CRAWLFORGE_PACKAGE_VERSION,
  CRAWLFORGE_VERSION_ENV,
  crawlforgePackageSpec,
} from "@/lib/analysis/researchStatus";
import { resetDbForTests } from "@/lib/db/client";

/** The spec the pinned default produces. */
const CRAWLFORGE_PACKAGE = crawlforgePackageSpec(CRAWLFORGE_PACKAGE_VERSION);

const ENV_KEYS = [
  "LH_DATA_DIR",
  "LH_DB_PATH",
  "LH_RESEARCH_MCP_CONFIG",
  "LH_RESEARCH_MCP_SERVER",
  "CRAWLFORGE_API_KEY",
  CRAWLFORGE_VERSION_ENV,
] as const;

let saved: Record<string, string | undefined>;
/** Working dir (holds `.mcp.json`) AND data dir (holds the preference DB). */
let dir: string;
/** A stand-in home dir, empty unless a test writes CrawlForge's setup file. */
let home: string;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(path.join(tmpdir(), "lightaudit-crawlforge-"));
  home = mkdtempSync(path.join(tmpdir(), "lightaudit-home-"));
  process.env.LH_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(() => {
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Create CrawlForge's own setup file under the stand-in home dir. */
function writeSetupFile(): void {
  mkdirSync(path.join(home, ".crawlforge"), { recursive: true });
  // Contents are irrelevant: LightAudit Score checks existence only, never reads it.
  writeFileSync(path.join(home, ".crawlforge", "config.json"), "{}");
}

/** Declare a generic research server in `dir/.mcp.json`. */
function writeConfig(command = "declared-server"): void {
  writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { research: { command } } }),
  );
}

/**
 * Resolution options that keep the CrawlForge probe on the temp home dir.
 * A function, because `home` is minted per test.
 */
const probe = () => ({ crawlforge: { homeDir: home } });

describe("crawlforgeSetupOnDisk", () => {
  it("is false on a clean machine", () => {
    expect(crawlforgeSetupOnDisk(home)).toBe(false);
  });

  it("detects CrawlForge's setup file without reading it", () => {
    writeSetupFile();

    expect(crawlforgeSetupOnDisk(home)).toBe(true);
  });
});

describe("the CrawlForge switch", () => {
  it("is off until the user turns it on, and persists across reads", () => {
    expect(isCrawlforgeEnabled()).toBe(false);

    setCrawlforgeEnabled(true);
    expect(isCrawlforgeEnabled()).toBe(true);

    setCrawlforgeEnabled(false);
    expect(isCrawlforgeEnabled()).toBe(false);
  });

  it("is only ACTIVE when enabled and the setup file exists", () => {
    expect(crawlforgeStatus({ homeDir: home, enabled: false, env: {} })).toEqual({
      enabled: false,
      setupOnDisk: false,
      available: false,
      active: false,
      version: CRAWLFORGE_PACKAGE_VERSION,
    });
    expect(crawlforgeStatus({ homeDir: home, enabled: true })).toMatchObject({
      enabled: true,
      available: false,
      active: false,
    });

    writeSetupFile();
    expect(crawlforgeStatus({ homeDir: home, enabled: false })).toMatchObject({
      available: true,
      active: false,
    });
    expect(crawlforgeStatus({ homeDir: home, enabled: true })).toMatchObject({
      setupOnDisk: true,
      available: true,
      active: true,
    });
  });
});

describe("crawlforgeDeclaration", () => {
  it("launches an exact, pinned version through npx, preferring the local cache", () => {
    expect(CRAWLFORGE_PACKAGE).toBe(`${CRAWLFORGE_PACKAGE_NAME}@${CRAWLFORGE_PACKAGE_VERSION}`);
    expect(CRAWLFORGE_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

    expect(crawlforgeDeclaration("darwin")).toMatchObject({
      command: "npx",
      args: ["-y", "--prefer-offline", CRAWLFORGE_PACKAGE],
    });
  });

  it("goes through cmd on Windows, where npx is a .cmd shim", () => {
    expect(crawlforgeDeclaration("win32")).toMatchObject({
      command: "cmd",
      args: ["/c", "npx", "-y", "--prefer-offline", CRAWLFORGE_PACKAGE],
    });
  });

  it("lets LH_CRAWLFORGE_VERSION move the pin — exact releases only", () => {
    expect(resolveCrawlforgeVersion({})).toBe(CRAWLFORGE_PACKAGE_VERSION);
    expect(resolveCrawlforgeVersion({ [CRAWLFORGE_VERSION_ENV]: " 5.7.1 " })).toBe("5.7.1");
    // Ranges, tags, and URLs are ignored rather than handed to npx.
    for (const bad of ["^5.7.0", "latest", "5.7", "github:x/y", "5.7.1 --foo"]) {
      expect(resolveCrawlforgeVersion({ [CRAWLFORGE_VERSION_ENV]: bad }), bad).toBe(
        CRAWLFORGE_PACKAGE_VERSION,
      );
    }

    expect(crawlforgeDeclaration("linux", "5.7.1").args).toEqual([
      "-y",
      "--prefer-offline",
      `${CRAWLFORGE_PACKAGE_NAME}@5.7.1`,
    ]);
  });

  it("declares no credential — only the stdio-mode flag", () => {
    expect(crawlforgeDeclaration("linux").declaredEnv).toEqual({
      CRAWLFORGE_MCP_STDIO: "true",
    });
  });
});

describe("resolveResearchServer precedence", () => {
  it("resolves nothing on a clean install", () => {
    expect(resolveResearchServer(dir, probe())).toBeNull();
    expect(hasResearchMcpConfig(dir, probe())).toBe(false);
  });

  it("uses CrawlForge when it is switched on and set up", () => {
    writeSetupFile();
    setCrawlforgeEnabled(true);

    const server = resolveResearchServer(dir, probe());

    expect(server?.source).toBe("crawlforge");
    expect(server?.promptGuidance).toBe(CRAWLFORGE_PROMPT_GUIDANCE);
    // Tool denials are fully qualified under the research server name; the
    // search + read tools a citation search needs stay available.
    expect(server?.disallowedTools).toContain("mcp__research__crawl_deep");
    expect(server?.disallowedTools).toContain("mcp__research__deep_research");
    expect(server?.disallowedTools).not.toContain("mcp__research__search_web");
    expect(server?.disallowedTools).not.toContain("mcp__research__scrape");
  });

  it("takes precedence over a declared config when active", () => {
    writeConfig();
    writeSetupFile();
    setCrawlforgeEnabled(true);

    expect(resolveResearchServer(dir, probe())?.source).toBe("crawlforge");
  });

  it("falls through to the declared config when switched off", () => {
    writeConfig();
    writeSetupFile();

    const server = resolveResearchServer(dir, probe());

    expect(server?.source).toBe("config");
    expect(server?.declaration.command).toBe("declared-server");
    expect(server?.disallowedTools).toEqual([]);
    expect(server?.promptGuidance).toBeNull();
  });

  it("falls through when switched on but not set up", () => {
    // Enabling with nothing to authenticate would launch a server whose every
    // tool errors — so the switch alone changes nothing.
    writeConfig();
    setCrawlforgeEnabled(true);

    expect(resolveResearchServer(dir, probe())?.source).toBe("config");

    const empty = path.join(dir, "no-config-here");
    mkdirSync(empty);
    expect(resolveResearchServer(empty, probe())).toBeNull();
  });
});

describe("researchLaunchConfig for CrawlForge", () => {
  it("never carries a key, even when one is in LightAudit Score's environment", () => {
    // The SDK puts this config on the `claude` command line; a forwarded key
    // would be readable from the process list for the whole analysis.
    setCrawlforgeEnabled(true);
    writeSetupFile();
    process.env.CRAWLFORGE_API_KEY = "cf-in-lightaudit-env";

    const server = resolveResearchServer(dir, probe());
    expect(server).not.toBeNull();

    const config = researchLaunchConfig(server!);
    expect(config.env).toEqual({ CRAWLFORGE_MCP_STDIO: "true" });
    expect(JSON.stringify(config)).not.toContain("cf-in-lightaudit-env");
  });

  it("produces a stdio config the driver can launch", () => {
    setCrawlforgeEnabled(true);
    writeSetupFile();

    const config = loadResearchMcpConfig(dir, probe());

    expect(config).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "--prefer-offline", CRAWLFORGE_PACKAGE],
      alwaysLoad: true,
    });
  });

  it("launches the overridden version when LH_CRAWLFORGE_VERSION is set", () => {
    setCrawlforgeEnabled(true);
    writeSetupFile();
    process.env[CRAWLFORGE_VERSION_ENV] = "5.7.1";

    const server = resolveResearchServer(dir, probe());

    expect(server?.declaration.args).toContain(`${CRAWLFORGE_PACKAGE_NAME}@5.7.1`);
    expect(researchStatus(dir, probe()).crawlforge.version).toBe("5.7.1");
  });
});

describe("researchStatus", () => {
  it("reports booleans and a source, never a command or env", () => {
    writeConfig();
    writeSetupFile();
    setCrawlforgeEnabled(true);

    const status = researchStatus(dir, probe());

    expect(status).toEqual({
      configured: true,
      source: "crawlforge",
      configDeclared: true,
      crawlforge: {
        enabled: true,
        setupOnDisk: true,
        available: true,
        active: true,
        version: CRAWLFORGE_PACKAGE_VERSION,
      },
    });
    expect(JSON.stringify(status)).not.toContain("declared-server");
    expect(JSON.stringify(status)).not.toContain("npx");
  });

  it("says a config is declared even when it is not the one in use", () => {
    writeConfig();

    expect(researchStatus(dir, probe())).toMatchObject({
      configured: true,
      source: "config",
      configDeclared: true,
      crawlforge: { enabled: false, active: false },
    });
  });
});
