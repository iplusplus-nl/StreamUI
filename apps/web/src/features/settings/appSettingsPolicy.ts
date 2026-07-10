import {
  normalizeApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";

export function coerceApiSettingsForRuntime(
  settings: ApiSettings,
  runtimeSettings: RuntimeSettingsSummary | null
): ApiSettings {
  const normalized = normalizeApiSettings(settings);
  const managedProviderEnabled = Boolean(
    runtimeSettings?.cloud?.enabled &&
      runtimeSettings.cloud.managedProviderEnabled
  );

  if (normalized.apiKeySource !== "managed" || managedProviderEnabled) {
    return normalized;
  }

  const defaults = normalizeApiSettings(runtimeSettings?.api.defaults);
  return normalizeApiSettings({
    ...defaults,
    model: normalized.model || defaults.model,
    modelOptions: normalized.modelOptions.length
      ? normalized.modelOptions
      : defaults.modelOptions,
    reasoningEffort: normalized.reasoningEffort,
    uiComplexity: normalized.uiComplexity,
    userPreferencePrompt: normalized.userPreferencePrompt,
    memoryItems: normalized.memoryItems
  });
}

export function resolveRuntimeApiSettings(
  current: ApiSettings,
  runtimeSettings: RuntimeSettingsSummary,
  hadSavedApiSettings: boolean
): ApiSettings {
  return hadSavedApiSettings
    ? coerceApiSettingsForRuntime(current, runtimeSettings)
    : normalizeApiSettings(runtimeSettings.api.defaults);
}
