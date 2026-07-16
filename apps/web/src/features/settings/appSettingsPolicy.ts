import {
  getApiKeyEnvironmentName,
  getDefaultModelsEndpoint,
  getProviderModelCatalog,
  getProviderPreset,
  normalizeApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import {
  getEnvironmentKeyStatus,
  type RuntimeSettingsSummary
} from "../../core/runtimeSettings";

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

function hasConfiguredProviderKey(
  settings: ApiSettings,
  runtimeSettings: RuntimeSettingsSummary
): boolean {
  if (settings.apiKeySource === "managed") {
    return true;
  }
  if (settings.apiKeySource === "manual") {
    return Boolean(settings.apiKey.trim());
  }
  return Boolean(
    getEnvironmentKeyStatus(
      runtimeSettings.api.environmentKeys,
      getApiKeyEnvironmentName(settings)
    )?.configured
  );
}

export function resolveAccountLoginApiSettings(
  current: ApiSettings,
  runtimeSettings: RuntimeSettingsSummary
): ApiSettings {
  const normalized = coerceApiSettingsForRuntime(current, runtimeSettings);
  if (
    !runtimeSettings.cloud?.enabled ||
    !runtimeSettings.cloud.managedProviderEnabled ||
    hasConfiguredProviderKey(normalized, runtimeSettings)
  ) {
    return normalized;
  }

  const managedPreset = getProviderPreset("chathtml-cloud");
  return normalizeApiSettings({
    ...normalized,
    providerId: managedPreset.id,
    providerName: managedPreset.label,
    baseUrl: managedPreset.baseUrl,
    apiKeySource: "managed",
    apiKey: "",
    model: managedPreset.model,
    modelOptions: getProviderModelCatalog(managedPreset.id),
    modelsEndpoint: getDefaultModelsEndpoint(managedPreset.baseUrl),
    reasoningEffort: managedPreset.reasoningEffort
  });
}
