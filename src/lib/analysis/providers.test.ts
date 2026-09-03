/**
 * Unit tests for the pure half of the provider seam: which AI backend a given
 * environment selects, how a provider + model round-trips through the
 * `analyses.model` column, and how an Ollama `/api/tags` payload is read.
 *
 * Nothing here touches the network — `probeOllama` is deliberately not tested,
 * since that needs a live Ollama.
 */

import { describe, expect, it } from "vitest";

import {
  formatProviderModel,
  isAnalysisProviderId,
  parseProviderModel,
  providerLabel,
} from "@/lib/analysis/providerModel";
import {
  DEFAULT_OLLAMA_BASE_URL,
  normalizeOllamaBaseUrl,
  ollamaOpenAiBaseUrl,
  parseOllamaTags,
} from "@/lib/analysis/providers/ollama";
import {
  normalizeProviderId,
  readProviderApiKey,
  resolveAnalysisProvider,
  resolveOllamaBaseUrl,
} from "@/lib/analysis/providers/select";

describe("resolveAnalysisProvider", () => {
  it("defaults to Claude so an existing install is unchanged", () => {
    const provider = resolveAnalysisProvider({});

    expect(provider).toMatchObject({
      id: "claude",
      driver: "claude",
      model: "",
      baseUrl: null,
      canWebResearch: true,
      missing: null,
    });
  });

  it("selects Ollama and points the OpenAI-compatible driver at /v1", () => {
    const provider = resolveAnalysisProvider({
      LH_ANALYSIS_PROVIDER: "ollama",
      LH_ANALYSIS_MODEL: "llama3.1:8b",
    });

    expect(provider).toMatchObject({
      id: "ollama",
      driver: "openai-compatible",
      model: "llama3.1:8b",
      baseUrl: `${DEFAULT_OLLAMA_BASE_URL}/v1`,
      canWebResearch: false,
      missing: null,
    });
  });

  it("honours a custom OLLAMA_BASE_URL and OLLAMA_MODEL", () => {
    const provider = resolveAnalysisProvider({
      LH_ANALYSIS_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://192.168.1.10:11434/",
      OLLAMA_MODEL: "qwen2.5-coder:14b",
    });

    expect(provider.baseUrl).toBe("http://192.168.1.10:11434/v1");
    expect(provider.model).toBe("qwen2.5-coder:14b");
  });

  it("prefers LH_ANALYSIS_MODEL over the OLLAMA_MODEL alias", () => {
    const provider = resolveAnalysisProvider({
      LH_ANALYSIS_PROVIDER: "ollama",
      LH_ANALYSIS_MODEL: "winner",
      OLLAMA_MODEL: "loser",
    });

    expect(provider.model).toBe("winner");
  });

  it("reports what Ollama is still missing instead of half-running", () => {
    const provider = resolveAnalysisProvider({ LH_ANALYSIS_PROVIDER: "ollama" });

    expect(provider.model).toBe("");
    expect(provider.missing).toMatch(/LH_ANALYSIS_MODEL/);
  });

  it("resolves an arbitrary OpenAI-compatible endpoint", () => {
    const provider = resolveAnalysisProvider({
      LH_ANALYSIS_PROVIDER: "openai-compatible",
      LH_ANALYSIS_BASE_URL: "https://openrouter.ai/api/v1",
      LH_ANALYSIS_MODEL: "meta-llama/llama-3.1-70b-instruct",
    });

    expect(provider).toMatchObject({
      id: "openai-compatible",
      driver: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "LH_ANALYSIS_API_KEY",
      canWebResearch: false,
      missing: null,
    });
  });

  it("names both missing settings for a custom endpoint", () => {
    const provider = resolveAnalysisProvider({ LH_ANALYSIS_PROVIDER: "custom" });

    expect(provider.id).toBe("openai-compatible");
    expect(provider.missing).toMatch(/LH_ANALYSIS_BASE_URL/);
    expect(provider.missing).toMatch(/LH_ANALYSIS_MODEL/);
  });

  it("lets a per-analysis override win over the environment", () => {
    const provider = resolveAnalysisProvider(
      { LH_ANALYSIS_PROVIDER: "claude" },
      { provider: "ollama", model: "phi4" },
    );

    expect(provider.id).toBe("ollama");
    expect(provider.model).toBe("phi4");
  });

  it("falls back to Claude when the env names a provider we don't know", () => {
    // A typo in .env must never take AI analysis offline.
    expect(resolveAnalysisProvider({ LH_ANALYSIS_PROVIDER: "llamma" }).id).toBe("claude");
  });

  it("records the API key's env var NAME, never a key", () => {
    const env = {
      LH_ANALYSIS_PROVIDER: "openai-compatible",
      LH_ANALYSIS_BASE_URL: "https://api.example.com/v1",
      LH_ANALYSIS_MODEL: "gpt-4o-mini",
      LH_ANALYSIS_API_KEY: "sk-not-a-real-key",
    };
    const provider = resolveAnalysisProvider(env);

    expect(JSON.stringify(provider)).not.toContain("sk-not-a-real-key");
    expect(readProviderApiKey(provider, env)).toBe("sk-not-a-real-key");
    expect(readProviderApiKey(provider, {})).toBeUndefined();
  });

  it("reads the Ollama root URL for detection", () => {
    expect(resolveOllamaBaseUrl({})).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(resolveOllamaBaseUrl({ OLLAMA_BASE_URL: "http://box:1234" })).toBe(
      "http://box:1234",
    );
  });
});

describe("the choice saved from Settings", () => {
  it("beats the environment's selection", () => {
    const provider = resolveAnalysisProvider(
      { LH_ANALYSIS_PROVIDER: "claude", LH_ANALYSIS_MODEL: "claude-opus-5" },
      {},
      { provider: "ollama", model: "qwen2.5-coder:14b" },
    );

    expect(provider).toMatchObject({
      id: "ollama",
      model: "qwen2.5-coder:14b",
      source: "settings",
      missing: null,
    });
  });

  it("loses to a per-analysis override", () => {
    const provider = resolveAnalysisProvider(
      {},
      { provider: "claude" },
      { provider: "ollama", model: "phi4" },
    );

    expect(provider).toMatchObject({ id: "claude", model: "", source: "override" });
  });

  it("supplies the model when an override names the same provider without one", () => {
    const provider = resolveAnalysisProvider(
      {},
      { provider: "ollama" },
      { provider: "ollama", model: "phi4" },
    );

    expect(provider.model).toBe("phi4");
  });

  it("never hands one provider's model to another", () => {
    // LH_ANALYSIS_MODEL belongs to the provider .env selects — Ollama here — so
    // it must not follow a switch to Claude, which has a default of its own…
    const toClaude = resolveAnalysisProvider(
      { LH_ANALYSIS_PROVIDER: "ollama", LH_ANALYSIS_MODEL: "qwen2.5-coder:14b" },
      {},
      { provider: "claude", model: "" },
    );
    expect(toClaude).toMatchObject({ id: "claude", model: "", source: "settings" });

    // …and a Claude model id must not be handed to Ollama by an override either.
    const toOllama = resolveAnalysisProvider(
      { LH_ANALYSIS_MODEL: "claude-opus-5" },
      { provider: "ollama" },
    );
    expect(toOllama.model).toBe("");
    expect(toOllama.missing).toMatch(/LH_ANALYSIS_MODEL/);
  });

  it("lets an empty saved model fall through to one pinned for the same provider", () => {
    const provider = resolveAnalysisProvider(
      { LH_ANALYSIS_MODEL: "claude-opus-5" },
      {},
      { provider: "claude", model: "" },
    );

    expect(provider.model).toBe("claude-opus-5");
  });

  it("reports which tier made the selection", () => {
    expect(resolveAnalysisProvider({}).source).toBe("default");
    expect(resolveAnalysisProvider({ LH_ANALYSIS_PROVIDER: "ollama" }).source).toBe("env");
    // A typo in .env selects nothing, so it is the default that is running.
    expect(resolveAnalysisProvider({ LH_ANALYSIS_PROVIDER: "llamma" }).source).toBe(
      "default",
    );
  });
});

describe("normalizeProviderId", () => {
  it("accepts the canonical ids and common spellings", () => {
    expect(normalizeProviderId("claude")).toBe("claude");
    expect(normalizeProviderId("Anthropic")).toBe("claude");
    expect(normalizeProviderId(" OLLAMA ")).toBe("ollama");
    expect(normalizeProviderId("local")).toBe("ollama");
    expect(normalizeProviderId("openai")).toBe("openai-compatible");
    expect(normalizeProviderId("custom")).toBe("openai-compatible");
  });

  it("rejects anything else", () => {
    expect(normalizeProviderId("")).toBeNull();
    expect(normalizeProviderId("gemini")).toBeNull();
    // Inherited object keys are not providers.
    expect(normalizeProviderId("constructor")).toBeNull();
    expect(normalizeProviderId("__proto__")).toBeNull();
    expect(normalizeProviderId("toString")).toBeNull();
    expect(normalizeProviderId(42)).toBeNull();
    expect(normalizeProviderId(null)).toBeNull();
  });
});

describe("provider/model encoding", () => {
  it("round-trips a provider and model", () => {
    const encoded = formatProviderModel("ollama", "llama3.1:8b");
    expect(encoded).toBe("ollama/llama3.1:8b");
    expect(parseProviderModel(encoded)).toEqual({
      provider: "ollama",
      model: "llama3.1:8b",
    });
  });

  it("keeps slashes inside a model id", () => {
    const encoded = formatProviderModel(
      "openai-compatible",
      "meta-llama/llama-3.1-70b",
    );
    expect(parseProviderModel(encoded)).toEqual({
      provider: "openai-compatible",
      model: "meta-llama/llama-3.1-70b",
    });
  });

  it("reads a bare model id written before providers existed", () => {
    expect(parseProviderModel("claude-sonnet-4-5")).toEqual({
      provider: null,
      model: "claude-sonnet-4-5",
    });
  });

  it("does not mistake a slashed model id for a provider prefix", () => {
    expect(parseProviderModel("hf.co/user/model")).toEqual({
      provider: null,
      model: "hf.co/user/model",
    });
  });

  it("handles a provider with no model and an empty value", () => {
    expect(formatProviderModel("claude", "  ")).toBe("claude");
    expect(parseProviderModel("claude")).toEqual({ provider: "claude", model: "" });
    expect(parseProviderModel("")).toEqual({ provider: null, model: "" });
  });

  it("labels providers, falling back for unknown values", () => {
    expect(providerLabel("ollama")).toBe("Ollama");
    expect(providerLabel(null)).toBe("AI");
    expect(isAnalysisProviderId("ollama")).toBe(true);
    expect(isAnalysisProviderId("gemini")).toBe(false);
  });
});

describe("Ollama URL handling", () => {
  it("normalizes to the root, tolerating /v1 and trailing slashes", () => {
    expect(normalizeOllamaBaseUrl("http://localhost:11434/v1")).toBe(
      "http://localhost:11434",
    );
    expect(normalizeOllamaBaseUrl("http://localhost:11434/")).toBe(
      "http://localhost:11434",
    );
    expect(normalizeOllamaBaseUrl("  ")).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(normalizeOllamaBaseUrl(null)).toBe(DEFAULT_OLLAMA_BASE_URL);
  });

  it("derives the OpenAI-compatible endpoint from either form", () => {
    expect(ollamaOpenAiBaseUrl("http://localhost:11434")).toBe(
      "http://localhost:11434/v1",
    );
    expect(ollamaOpenAiBaseUrl("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434/v1",
    );
  });
});

describe("parseOllamaTags", () => {
  it("projects a real /api/tags payload and sorts by name", () => {
    const models = parseOllamaTags({
      models: [
        {
          name: "qwen2.5-coder:14b",
          model: "qwen2.5-coder:14b",
          size: 9_000_000_000,
          details: { parameter_size: "14.8B", quantization_level: "Q4_K_M" },
        },
        {
          name: "llama3.1:8b",
          size: 4_920_753_328,
          details: { parameter_size: "8.0B", quantization_level: "Q4_0" },
        },
      ],
    });

    expect(models.map((m) => m.name)).toEqual(["llama3.1:8b", "qwen2.5-coder:14b"]);
    expect(models[0]).toEqual({
      name: "llama3.1:8b",
      parameterSize: "8.0B",
      quantization: "Q4_0",
      sizeBytes: 4_920_753_328,
    });
  });

  it("falls back to `model` when `name` is absent", () => {
    expect(parseOllamaTags({ models: [{ model: "phi4:latest" }] })).toEqual([
      { name: "phi4:latest", parameterSize: undefined, quantization: undefined, sizeBytes: undefined },
    ]);
  });

  it("drops malformed entries rather than throwing", () => {
    expect(
      parseOllamaTags({ models: [null, 7, {}, { name: "   " }, { name: "ok:1b" }] }),
    ).toHaveLength(1);
  });

  it("returns [] for anything that isn't a tags payload", () => {
    expect(parseOllamaTags(null)).toEqual([]);
    expect(parseOllamaTags({})).toEqual([]);
    expect(parseOllamaTags({ models: "nope" })).toEqual([]);
  });
});
