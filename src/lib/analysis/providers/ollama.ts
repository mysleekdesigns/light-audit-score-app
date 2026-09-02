/**
 * Ollama detection.
 *
 * Ollama exposes two surfaces we care about: its native `/api/tags` endpoint,
 * which lists the models the user has actually pulled, and an OpenAI-compatible
 * `/v1` endpoint, which the shared OpenAI-compatible driver talks to. So Ollama
 * needs no driver of its own — only discovery, which is what this module does:
 * "is it running, and which models are installed?" for the settings picker.
 *
 * The parsing half is pure and unit-tested; the probe half is a short, bounded
 * fetch to a host the user chose. Nothing here needs (or accepts) a credential.
 */

import { isRecord } from "@/lib/lighthouse/parseLhr";
import type { OllamaModel } from "@/lib/analysis/providerStatus";

export type { OllamaModel };

/** Where Ollama listens out of the box. */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/** How long to wait on a detection probe before calling Ollama "not running". */
const PROBE_TIMEOUT_MS = 2_000;

/** Result of a detection probe. */
export interface OllamaProbe {
  running: boolean;
  /** Normalized root URL that was probed. */
  baseUrl: string;
  models: OllamaModel[];
  /** Short reason when `running` is false. */
  error?: string;
}

/**
 * Normalize a user-supplied Ollama URL to its ROOT (no trailing slash, no `/v1`).
 * Users reasonably paste either form, and `/api/tags` lives off the root while
 * chat completions live under `/v1` — so we store the root and derive both.
 */
export function normalizeOllamaBaseUrl(raw?: string | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_OLLAMA_BASE_URL;
  let url = trimmed.replace(/\/+$/, "");
  if (/\/v1$/i.test(url)) url = url.slice(0, -3).replace(/\/+$/, "");
  return url || DEFAULT_OLLAMA_BASE_URL;
}

/** The OpenAI-compatible endpoint for an Ollama root URL. */
export function ollamaOpenAiBaseUrl(raw?: string | null): string {
  return `${normalizeOllamaBaseUrl(raw)}/v1`;
}

/**
 * Project an `/api/tags` payload into {@link OllamaModel}[]. Pure and defensive:
 * unknown or malformed entries are dropped rather than throwing, and models are
 * sorted by name so the picker is stable.
 */
export function parseOllamaTags(payload: unknown): OllamaModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  const models: OllamaModel[] = [];
  for (const entry of payload.models) {
    if (!isRecord(entry)) continue;
    const name =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : typeof entry.model === "string" && entry.model.trim()
          ? entry.model.trim()
          : null;
    if (!name) continue;
    const details = isRecord(entry.details) ? entry.details : undefined;
    models.push({
      name,
      parameterSize:
        typeof details?.parameter_size === "string" ? details.parameter_size : undefined,
      quantization:
        typeof details?.quantization_level === "string"
          ? details.quantization_level
          : undefined,
      sizeBytes: typeof entry.size === "number" ? entry.size : undefined,
    });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}

/**
 * Probe an Ollama instance: is it up, and what is installed? Never throws — a
 * refused connection is simply `running: false`, because "Ollama isn't running"
 * is a normal state the settings UI explains, not an error.
 */
export async function probeOllama(
  rawBaseUrl?: string | null,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OllamaProbe> {
  const baseUrl = normalizeOllamaBaseUrl(rawBaseUrl);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return { running: false, baseUrl, models: [], error: `HTTP ${response.status}` };
    }
    const payload = (await response.json()) as unknown;
    return { running: true, baseUrl, models: parseOllamaTags(payload) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { running: false, baseUrl, models: [], error: message };
  }
}
