/**
 * Tests for the environment the audit worker — and therefore Chrome — receives
 * (ROADMAP Phase G security re-review, M3).
 *
 * Two failure modes, pulling in opposite directions, and both are here. Forward
 * too much and a provider key from the coding agent that launched the MCP server
 * ends up in the environment of a browser rendering a page a model chose.
 * Forward too little and Chrome does not launch at all — a loud failure, but a
 * baffling one, so the positive cases matter as much as the negative ones.
 */

import { describe, expect, it } from "vitest";

import { PASSTHROUGH_VAR, filterWorkerEnv } from "@/lib/queue/workerEnv";

describe("filterWorkerEnv", () => {
  it("drops the secrets a coding agent's environment carries", () => {
    const filtered = filterWorkerEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-secret",
      OPENAI_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_TOKEN: "ghp_secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/path/to/key.json",
      NPM_TOKEN: "npm_secret",
    });
    expect(Object.keys(filtered)).toEqual(["PATH"]);
  });

  it("keeps what a fork and Chrome actually need", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/Users/x",
      TMPDIR: "/tmp/x",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      CHROME_PATH: "/Applications/Chrome",
      DISPLAY: ":0",
      HTTPS_PROXY: "http://proxy.internal:3128",
    };
    expect(filterWorkerEnv(source)).toEqual(source);
  });

  it("passes the whole LH_ namespace, including the worker's own channel", () => {
    // The worker reads its input, its output path, the data directory and its
    // host-scoped `.env` credentials from here — this is the one prefix where a
    // secret legitimately travels by environment, because the user set it for
    // this tool rather than it merely being in the shell.
    const filtered = filterWorkerEnv({
      LH_AUDIT_INPUT: "{}",
      LH_AUDIT_OUTPUT: "/tmp/out.json",
      LH_DATA_DIR: "/data",
      LH_AUDIT_BASIC_AUTH: "user:pass",
      LH_AUDIT_CREDENTIAL_HOSTS: "staging.example.com",
    });
    expect(Object.keys(filtered).sort()).toEqual([
      "LH_AUDIT_BASIC_AUTH",
      "LH_AUDIT_CREDENTIAL_HOSTS",
      "LH_AUDIT_INPUT",
      "LH_AUDIT_OUTPUT",
      "LH_DATA_DIR",
    ]);
  });

  it("never forwards NODE_OPTIONS", () => {
    // It can inject a module into the child, which is the one thing an
    // allow-list must not do on someone else's behalf.
    const filtered = filterWorkerEnv({
      PATH: "/usr/bin",
      NODE_OPTIONS: "--require /tmp/evil.js",
      NODE_ENV: "production",
    });
    expect(filtered.NODE_OPTIONS).toBeUndefined();
    expect(filtered.NODE_ENV).toBe("production");
  });

  it("honours the passthrough escape hatch", () => {
    const filtered = filterWorkerEnv({
      PATH: "/usr/bin",
      SOME_SITE_SPECIFIC_VAR: "needed",
      STILL_SECRET: "no",
      [PASSTHROUGH_VAR]: "SOME_SITE_SPECIFIC_VAR",
    });
    expect(filtered.SOME_SITE_SPECIFIC_VAR).toBe("needed");
    expect(filtered.STILL_SECRET).toBeUndefined();
  });

  it("tolerates a messy passthrough list", () => {
    const filtered = filterWorkerEnv({
      A_VAR: "1",
      B_VAR: "2",
      [PASSTHROUGH_VAR]: " A_VAR , , B_VAR ,",
    });
    expect(filtered.A_VAR).toBe("1");
    expect(filtered.B_VAR).toBe("2");
  });

  it("matches allowed names case-insensitively, for Windows", () => {
    // Node preserves whatever case the parent used, and Windows treats the names
    // as case-insensitive, so `Path` must not be dropped for its spelling.
    const filtered = filterWorkerEnv({ Path: "C:\\Windows", SystemRoot: "C:\\Windows" });
    expect(filtered.Path).toBe("C:\\Windows");
    expect(filtered.SystemRoot).toBe("C:\\Windows");
  });

  it("skips undefined values rather than forwarding empty keys", () => {
    const filtered = filterWorkerEnv({ PATH: "/usr/bin", HOME: undefined });
    expect("HOME" in filtered).toBe(false);
  });
});
