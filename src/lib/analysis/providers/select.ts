/**
 * Which AI backend runs an analysis, decided from the environment, the choice
 * saved from Settings, and an optional per-analysis override.
 *
 * The default is `claude`, so an existing install keeps behaving exactly as it
 * did before providers existed. Everything else is opt-in:
 *
 *   LH_ANALYSIS_PROVIDER   claude | ollama | openai-compatible   (default: claude)
 *   LH_ANALYSIS_MODEL      model id for the selected provider
 *   LH_ANALYSIS_BASE_URL   OpenAI-compatible endpoint (include the vendor's /v1)
 *   LH_ANALYSIS_API_KEY    key for that endpoint
 *   OLLAMA_BASE_URL        Ollama root (default http://localhost:11434)
 *   OLLAMA_MODEL           convenience alias for LH_ANALYSIS_MODEL on Ollama
 *
 * Three tiers can name the provider, highest first: the request's override,
 * the provider + model the user clicked in Settings (kept in `app_settings` by
 * `providers/preference.ts`, so it needs no restart), then the environment.
 * Only the SELECTION is layered like this — endpoints and keys always come
 * from the environment, because nothing credential-shaped is ever stored.
 *
 * Credentials are the USER's, read from `process.env` (a local `.env`) and never
 * bundled: this module only ever records the NAME of the variable a key lives
 * in, so its output is safe to serialize to the settings UI.
 *
 * Pure — no I/O, no `process.env` access of its own (the env and the saved
 * choice are arguments) — so provider selection is fully unit-testable.
 */

import { isAnalysisProviderId } from "@/lib/analysis/providerModel";
import type { AnalysisProviderId } from "@/lib/analysis/types";
import {
  DEFAULT_OLLAMA_BASE_URL,
  ollamaOpenAiBaseUrl,
} from "@/lib/analysis/providers/ollama";
import type { ProviderSource, ResolvedProvider } from "@/lib/analysis/providers/types";

/** The subset of the environment this module reads. */
export type AnalysisEnv = Record<string, string | undefined>;

/** A per-analysis override from the request body. */
export interface ProviderOverride {
  provider?: string | null;
  model?: string | null;
}

/**
 * The choice saved from Settings: a provider and the model to run it on
 * (`""` = whatever that provider defaults to). A provider id and a model tag
 * are all it can hold — a key has no place here.
 */
export interface ProviderPreference {
  provider: AnalysisProviderId;
  model: string;
}

/** Env var holding the provider selection. */
export const PROVIDER_ENV = "LH_ANALYSIS_PROVIDER";
/** Env var holding the model id. */
export const MODEL_ENV = "LH_ANALYSIS_MODEL";
/** Env var holding a custom OpenAI-compatible base URL. */
export const BASE_URL_ENV = "LH_ANALYSIS_BASE_URL";
/** Env var holding the custom endpoint's API key. */
export const API_KEY_ENV = "LH_ANALYSIS_API_KEY";
/** Env var holding the Ollama root URL. */
export const OLLAMA_BASE_URL_ENV = "OLLAMA_BASE_URL";
/** Convenience env var for the Ollama model id. */
export const OLLAMA_MODEL_ENV = "OLLAMA_MODEL";
/** Optional key for an Ollama instance sitting behind an auth proxy. */
export const OLLAMA_API_KEY_ENV = "OLLAMA_API_KEY";
/** Longest model id accepted from a request body or saved from Settings. */
export const MAX_MODEL_ID_LENGTH = 200;
/**
 * What a model id may look like: printable ASCII, no whitespace, and never
 * starting with `-`. Every Ollama tag, Hugging Face id and vendor model id fits.
 *
 * The two exclusions are the point. Control characters and newlines would reach
 * SQLite and the analysis badge. A LEADING DASH would reach an argument vector:
 * the Claude driver hands this id to the Agent SDK, which spawns the `claude`
 * CLI with it, so `-`-prefixed text is a flag the CLI might honour rather than a
 * model to load — and the settings/analyze routes accept this id from a request
 * body. Requiring the first character to be alphanumeric closes that off.
 */
export const MODEL_ID_PATTERN = /^[0-9A-Za-z][\x21-\x7e]*$/;

/** Spellings we accept for each provider, so a reasonable guess just works. */
const PROVIDER_ALIASES: Record<string, AnalysisProviderId> = {
  claude: "claude",
  anthropic: "claude",
  ollama: "ollama",
  local: "ollama",
  "openai-compatible": "openai-compatible",
  openai: "openai-compatible",
  compatible: "openai-compatible",
  custom: "openai-compatible",
};

/** Normalize a provider spelling to an id, or `null` if it isn't one we know. */
export function normalizeProviderId(value: unknown): AnalysisProviderId | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  if (isAnalysisProviderId(key)) return key;
  // Own keys only: a plain-object index would answer "constructor" or
  // "__proto__" with something that is not a provider.
  return Object.hasOwn(PROVIDER_ALIASES, key) ? PROVIDER_ALIASES[key] : null;
}

/** Read + trim one env value, returning `undefined` for blank. */
function read(env: AnalysisEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/**
 * Resolve the provider for one analysis.
 *
 * Precedence: an explicit per-analysis override, then the choice saved from
 * Settings, then `LH_ANALYSIS_PROVIDER`, then `claude`. An unrecognized
 * override provider is rejected by the caller (the route validates it) rather
 * than silently falling back here — but an unrecognized *env* value degrades
 * to the default, so a typo in `.env` can never take AI analysis offline.
 *
 * A model id only means something next to the provider it was written for:
 * the saved choice carries its own, and `LH_ANALYSIS_MODEL` belongs to the
 * provider the environment selects. Neither follows a switch to a different
 * provider — an Ollama tag is never handed to Claude because `.env` named it.
 */
export function resolveAnalysisProvider(
  env: AnalysisEnv,
  override: ProviderOverride = {},
  preference: ProviderPreference | null = null,
): ResolvedProvider {
  const overrideId = normalizeProviderId(override.provider);
  const preferredId = preference ? normalizeProviderId(preference.provider) : null;
  const envId = normalizeProviderId(env[PROVIDER_ENV]);
  const id = overrideId ?? preferredId ?? envId ?? "claude";
  const source: ProviderSource = overrideId
    ? "override"
    : preferredId
      ? "settings"
      : envId
        ? "env"
        : "default";

  const overrideModel = override.model?.trim() || undefined;
  const preferredModel =
    preference && preferredId === id ? preference.model.trim() || undefined : undefined;
  const envModel = (envId ?? "claude") === id ? read(env, MODEL_ENV) : undefined;
  const model = overrideModel ?? preferredModel ?? envModel;

  switch (id) {
    case "ollama": {
      const ollamaModel = model ?? read(env, OLLAMA_MODEL_ENV);
      return {
        id,
        source,
        driver: "openai-compatible",
        model: ollamaModel ?? "",
        baseUrl: ollamaOpenAiBaseUrl(read(env, OLLAMA_BASE_URL_ENV)),
        apiKeyEnv: OLLAMA_API_KEY_ENV,
        canWebResearch: false,
        missing: ollamaModel
          ? null
          : `Set ${MODEL_ENV} (or ${OLLAMA_MODEL_ENV}) to an installed Ollama model, or pick one in Settings.`,
      };
    }

    case "openai-compatible": {
      const baseUrl = read(env, BASE_URL_ENV);
      const missing: string[] = [];
      if (!baseUrl) {
        missing.push(`${BASE_URL_ENV} (the endpoint's base URL, including /v1)`);
      }
      if (!model) missing.push(`${MODEL_ENV} (the model id)`);
      return {
        id,
        source,
        driver: "openai-compatible",
        model: model ?? "",
        baseUrl: baseUrl ?? null,
        apiKeyEnv: API_KEY_ENV,
        canWebResearch: false,
        missing: missing.length > 0 ? `Set ${missing.join(" and ")}.` : null,
      };
    }

    case "claude":
    default:
      return {
        id: "claude",
        source,
        driver: "claude",
        // Empty = the Claude Code default model, which is today's behaviour.
        model: model ?? "",
        baseUrl: null,
        apiKeyEnv: "ANTHROPIC_API_KEY",
        canWebResearch: true,
        // Claude auth is discovered when the agent starts (login OR api key), so
        // there is nothing to demand up front.
        missing: null,
      };
  }
}

/**
 * The API key for a resolved provider, read from the environment by name.
 * Server-only by construction — never put the return value in a response.
 */
export function readProviderApiKey(
  provider: ResolvedProvider,
  env: AnalysisEnv,
): string | undefined {
  return provider.apiKeyEnv ? read(env, provider.apiKeyEnv) : undefined;
}

/** The Ollama root URL in effect (for detection + settings copy). */
export function resolveOllamaBaseUrl(env: AnalysisEnv): string {
  return read(env, OLLAMA_BASE_URL_ENV) ?? DEFAULT_OLLAMA_BASE_URL;
}
