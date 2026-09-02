/**
 * Encode / decode the `analyses.model` column, which records BOTH the provider
 * and the model that produced an analysis: `"<provider>/<model>"`.
 *
 * The column already existed (it held a bare model id), so rather than migrate
 * the schema we prefix it. Decoding only treats the first segment as a provider
 * when it is a known {@link AnalysisProviderId}, which keeps two things working:
 *  - rows written before providers existed (`"claude-sonnet-4-5"`), and
 *  - model ids that legitimately contain slashes (`"hf.co/user/model"`).
 *
 * Pure and import-light so client components can badge a result without pulling
 * any server code in.
 */

import {
  ANALYSIS_PROVIDER_IDS,
  ANALYSIS_PROVIDER_LABELS,
  type AnalysisProviderId,
} from "@/lib/analysis/types";

/** A decoded `analyses.model` value. */
export interface ProviderModel {
  /** The provider, or `null` when the value carries no recognizable prefix. */
  provider: AnalysisProviderId | null;
  /** The model id on its own (may be empty when the driver never reported one). */
  model: string;
}

/** Whether `value` is one of the known provider ids. */
export function isAnalysisProviderId(value: unknown): value is AnalysisProviderId {
  return (
    typeof value === "string" &&
    (ANALYSIS_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/** Encode a provider + model for the `analyses.model` column. */
export function formatProviderModel(
  provider: AnalysisProviderId,
  model: string,
): string {
  const trimmed = model.trim();
  return trimmed ? `${provider}/${trimmed}` : provider;
}

/** Decode an `analyses.model` value into its provider and model parts. */
export function parseProviderModel(value: string): ProviderModel {
  const trimmed = value.trim();
  if (!trimmed) return { provider: null, model: "" };

  const slash = trimmed.indexOf("/");
  const head = slash === -1 ? trimmed : trimmed.slice(0, slash);
  if (!isAnalysisProviderId(head)) return { provider: null, model: trimmed };

  return { provider: head, model: slash === -1 ? "" : trimmed.slice(slash + 1) };
}

/** Human label for a decoded value's provider (falls back to "AI"). */
export function providerLabel(provider: AnalysisProviderId | null): string {
  return provider ? ANALYSIS_PROVIDER_LABELS[provider] : "AI";
}
