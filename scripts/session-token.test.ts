/**
 * Tests for the start script's session-token resolution and its `.env` reader.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_TOKEN_FILE,
  readDotEnv,
  resolveSessionToken,
} from "./session-token.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lightaudit-token-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readDotEnv", () => {
  it("reads KEY=value lines, quotes, and comments", () => {
    const file = path.join(dir, ".env");
    writeFileSync(
      file,
      [
        "# comment",
        "",
        "PLAIN=value",
        'DQ="quoted value"',
        "SQ='single # not a comment'",
        "TRAIL=value # trailing comment",
        "SPACED = padded ",
        "not-a-key=ignored",
        "NOEQUALS",
      ].join("\n"),
    );

    expect(readDotEnv(file)).toEqual({
      PLAIN: "value",
      DQ: "quoted value",
      SQ: "single # not a comment",
      TRAIL: "value",
      SPACED: "padded",
    });
  });

  it("is empty when the file is missing", () => {
    expect(readDotEnv(path.join(dir, "missing"))).toEqual({});
  });
});

describe("resolveSessionToken", () => {
  const shellToken = "shell-token-abcdefghijklmnopqrstuvwxyz0123";
  const dotEnvToken = "dotenv-token-abcdefghijklmnopqrstuvwxyz012";

  it("prefers an explicit LH_SESSION_TOKEN from the shell, then .env", () => {
    expect(
      resolveSessionToken({
        env: { LH_SESSION_TOKEN: ` ${shellToken} ` },
        dotEnv: { LH_SESSION_TOKEN: dotEnvToken },
        dataDir: dir,
      }),
    ).toEqual({ token: shellToken, source: "env" });
    expect(
      resolveSessionToken({ env: {}, dotEnv: { LH_SESSION_TOKEN: dotEnvToken }, dataDir: dir }),
    ).toEqual({ token: dotEnvToken, source: "env" });
  });

  it("refuses a pinned token that is too weak to be a credential", () => {
    expect(() =>
      resolveSessionToken({ env: { LH_SESSION_TOKEN: "x" }, dotEnv: {}, dataDir: dir }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      resolveSessionToken({
        env: { LH_SESSION_TOKEN: "has whitespace inside but is otherwise long enough" },
        dotEnv: {},
        dataDir: dir,
      }),
    ).toThrow(/no whitespace/);
  });

  it("generates a strong token once and persists it privately", () => {
    const first = resolveSessionToken({ env: {}, dotEnv: {}, dataDir: dir });

    expect(first.source).toBe("generated");
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const file = path.join(dir, SESSION_TOKEN_FILE);
    expect(readFileSync(file, "utf8").trim()).toBe(first.token);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    const second = resolveSessionToken({ env: {}, dotEnv: {}, dataDir: dir });
    expect(second).toEqual({ token: first.token, source: "file" });
  });

  it("replaces a persisted token that does not look like one", () => {
    writeFileSync(path.join(dir, SESSION_TOKEN_FILE), "short\n");

    const resolved = resolveSessionToken({ env: {}, dotEnv: {}, dataDir: dir });

    expect(resolved.source).toBe("generated");
    expect(resolved.token).not.toBe("short");
  });
});
