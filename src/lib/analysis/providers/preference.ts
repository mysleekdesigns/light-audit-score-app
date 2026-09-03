/**
 * The analysis provider the user picked in Settings — the one thing the AI
 * provider panel writes.
 *
 * Provider selection lives in `.env` (`LH_ANALYSIS_PROVIDER` + `LH_ANALYSIS_MODEL`),
 * which takes an edit and a restart. Clicking an installed Ollama model in
 * Settings is the no-restart alternative: the provider + model pair is saved
 * here, in `app_settings`, and {@link resolveConfiguredProvider} layers it over
 * the environment for every analysis until the user clears it.
 *
 * What is stored is a provider id and a model tag — never an endpoint and
 * never a key. Those stay in the environment, so this keeps `app_settings` as
 * credential-free as the CrawlForge switch does. The value reuses the
 * `analyses.model` encoding (`"<provider>/<model>"`), so a saved choice reads
 * the same way a finished analysis is badged.
 *
 * Server-only: touches the preference store.
 */

import { formatProviderModel, parseProviderModel } from "@/lib/analysis/providerModel";
import {
  type AnalysisEnv,
  type ProviderOverride,
  type ProviderPreference,
  resolveAnalysisProvider,
} from "@/lib/analysis/providers/select";
import type { ResolvedProvider } from "@/lib/analysis/providers/types";
import { deleteAppSetting, getAppSetting, setAppSetting } from "@/lib/db/settings";

/** The `app_settings` key holding the saved provider + model. */
export const PROVIDER_PREFERENCE_SETTING = "analysis.provider";

/**
 * The saved choice, or `null` when the user has not made one — or the stored
 * value is unreadable, which degrades to "not set" rather than to a crash.
 */
export function getProviderPreference(): ProviderPreference | null {
  const raw = getAppSetting(PROVIDER_PREFERENCE_SETTING);
  if (raw === null) return null;
  const { provider, model } = parseProviderModel(raw);
  return provider ? { provider, model } : null;
}

/** Save the choice. Throws if the write fails, so the route can say so. */
export function setProviderPreference(preference: ProviderPreference): void {
  setAppSetting(
    PROVIDER_PREFERENCE_SETTING,
    formatProviderModel(preference.provider, preference.model),
  );
}

/** Forget the choice so the environment decides again. Throws if the delete fails. */
export function clearProviderPreference(): void {
  deleteAppSetting(PROVIDER_PREFERENCE_SETTING);
}

/**
 * Resolve the provider an analysis would use right now: the saved choice
 * layered over `env`, under any per-request override. The one call both the
 * engine and the settings endpoint make, so what Settings shows is what runs.
 */
export function resolveConfiguredProvider(
  override: ProviderOverride = {},
  env: AnalysisEnv = process.env,
): ResolvedProvider {
  return resolveAnalysisProvider(env, override, getProviderPreference());
}
