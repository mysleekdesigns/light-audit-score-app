/**
 * Round-trip tests for the provider choice saved from Settings, and for how it
 * layers over the environment when the engine resolves a provider.
 *
 * Hermetic like the other DB tests: `LH_DATA_DIR` points at a temp dir and the
 * lazy client is reset between cases, so the real migrations run against a
 * throwaway SQLite file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROVIDER_PREFERENCE_SETTING,
  clearProviderPreference,
  getProviderPreference,
  resolveConfiguredProvider,
  setProviderPreference,
} from "@/lib/analysis/providers/preference";
import { resetDbForTests } from "@/lib/db/client";
import { getAppSetting, setAppSetting } from "@/lib/db/settings";

let dir: string;
let savedDataDir: string | undefined;
let savedDbPath: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.LH_DATA_DIR;
  savedDbPath = process.env.LH_DB_PATH;
  dir = mkdtempSync(path.join(tmpdir(), "lightaudit-provider-pref-"));
  process.env.LH_DATA_DIR = dir;
  delete process.env.LH_DB_PATH;
  resetDbForTests();
});

afterEach(() => {
  resetDbForTests();
  if (savedDataDir === undefined) delete process.env.LH_DATA_DIR;
  else process.env.LH_DATA_DIR = savedDataDir;
  if (savedDbPath === undefined) delete process.env.LH_DB_PATH;
  else process.env.LH_DB_PATH = savedDbPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("the saved provider choice", () => {
  it("is unset until the user picks something", () => {
    expect(getProviderPreference()).toBeNull();
  });

  it("round-trips a provider and model in the analyses.model encoding", () => {
    setProviderPreference({ provider: "ollama", model: "qwen2.5-coder:14b" });

    expect(getAppSetting(PROVIDER_PREFERENCE_SETTING)).toBe("ollama/qwen2.5-coder:14b");
    expect(getProviderPreference()).toEqual({
      provider: "ollama",
      model: "qwen2.5-coder:14b",
    });
  });

  it("keeps a slash inside the model tag", () => {
    setProviderPreference({ provider: "ollama", model: "hf.co/user/model:Q4_K_M" });

    expect(getProviderPreference()).toEqual({
      provider: "ollama",
      model: "hf.co/user/model:Q4_K_M",
    });
  });

  it("clears back to unset, and clearing twice is harmless", () => {
    setProviderPreference({ provider: "claude", model: "" });
    expect(getProviderPreference()).toEqual({ provider: "claude", model: "" });

    clearProviderPreference();
    expect(getProviderPreference()).toBeNull();
    expect(() => clearProviderPreference()).not.toThrow();
  });

  it("treats a value it does not recognise as unset", () => {
    setAppSetting(PROVIDER_PREFERENCE_SETTING, "gemini/flash");

    expect(getProviderPreference()).toBeNull();
  });
});

describe("resolveConfiguredProvider", () => {
  it("uses the environment when nothing is saved", () => {
    const provider = resolveConfiguredProvider(
      {},
      { LH_ANALYSIS_PROVIDER: "ollama", OLLAMA_MODEL: "phi4" },
    );

    expect(provider).toMatchObject({ id: "ollama", model: "phi4", source: "env" });
  });

  it("layers the saved choice over the environment", () => {
    setProviderPreference({ provider: "ollama", model: "qwen2.5-coder:14b" });

    const provider = resolveConfiguredProvider({}, { LH_ANALYSIS_PROVIDER: "claude" });

    expect(provider).toMatchObject({
      id: "ollama",
      model: "qwen2.5-coder:14b",
      source: "settings",
      missing: null,
    });
  });

  it("still lets a per-analysis override win", () => {
    setProviderPreference({ provider: "ollama", model: "phi4" });

    const provider = resolveConfiguredProvider({ provider: "claude" }, {});

    expect(provider).toMatchObject({ id: "claude", source: "override" });
  });
});
