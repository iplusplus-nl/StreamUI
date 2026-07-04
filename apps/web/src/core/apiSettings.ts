export type ApiProviderId = "openrouter" | "openai" | "local" | "custom";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ApiKeySource = "environment" | "manual";

export type ApiSettings = {
  providerId: ApiProviderId;
  providerName: string;
  baseUrl: string;
  apiKeySource: ApiKeySource;
  apiKey: string;
  model: string;
  modelOptions: string[];
  modelsEndpoint: string;
  reasoningEffort: ReasoningEffort;
  userPreference: string;
};

export type ApiProviderPreset = {
  id: ApiProviderId;
  label: string;
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
};

export const API_SETTINGS_STORAGE_KEY = "streamui.apiSettings.v1";
export const MAX_MODEL_OPTIONS = 120;
export const MAX_MODEL_ID_LENGTH = 180;
export const MAX_USER_PREFERENCE_LENGTH = 4_000;

export const API_PROVIDER_PRESETS: ApiProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-3.1-pro-preview",
    reasoningEffort: "low"
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    reasoningEffort: "none"
  },
  {
    id: "local",
    label: "Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.1",
    reasoningEffort: "none"
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    model: "",
    reasoningEffort: "none"
  }
];

export const REASONING_EFFORT_OPTIONS: Array<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" }
];

export const API_KEY_SOURCE_OPTIONS: Array<{
  value: ApiKeySource;
  label: string;
}> = [
  { value: "environment", label: "Environment" },
  { value: "manual", label: "Manual" }
];

const DEFAULT_PRESET = API_PROVIDER_PRESETS[0];

export const DEFAULT_API_SETTINGS: ApiSettings = {
  providerId: DEFAULT_PRESET.id,
  providerName: DEFAULT_PRESET.label,
  baseUrl: DEFAULT_PRESET.baseUrl,
  apiKeySource: "environment",
  apiKey: "",
  model: DEFAULT_PRESET.model,
  modelOptions: [DEFAULT_PRESET.model],
  modelsEndpoint: getDefaultModelsEndpoint(DEFAULT_PRESET.baseUrl),
  reasoningEffort: DEFAULT_PRESET.reasoningEffort,
  userPreference: ""
};

function isProviderId(value: unknown): value is ApiProviderId {
  return API_PROVIDER_PRESETS.some((preset) => preset.id === value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.value === value);
}

function isApiKeySource(value: unknown): value is ApiKeySource {
  return API_KEY_SOURCE_OPTIONS.some((option) => option.value === value);
}

export function getDefaultModelsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized ? `${normalized}/models` : "";
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().slice(0, MAX_MODEL_ID_LENGTH);
  if (!normalized || /[\r\n]/.test(normalized)) {
    return null;
  }

  return normalized;
}

export function normalizeModelOptions(input: unknown): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  const candidates = Array.isArray(input) ? input : [];

  for (const candidate of candidates) {
    const modelId = normalizeModelId(candidate);
    if (!modelId) {
      continue;
    }

    const key = modelId.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    options.push(modelId);

    if (options.length >= MAX_MODEL_OPTIONS) {
      break;
    }
  }

  return options;
}

export function getSelectableModelOptions(settings: ApiSettings): string[] {
  return normalizeModelOptions([settings.model, ...settings.modelOptions]);
}

export function getProviderPreset(id: ApiProviderId): ApiProviderPreset {
  return (
    API_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_PRESET
  );
}

export function normalizeApiSettings(input: unknown): ApiSettings {
  const object =
    typeof input === "object" && input !== null
      ? (input as Partial<ApiSettings>)
      : {};
  const providerId = isProviderId(object.providerId)
    ? object.providerId
    : DEFAULT_API_SETTINGS.providerId;
  const preset = getProviderPreset(providerId);
  const providerName =
    typeof object.providerName === "string" && object.providerName.trim()
      ? object.providerName.trim()
      : preset.label;
  const model =
    typeof object.model === "string"
      ? (normalizeModelId(object.model) ?? "")
      : preset.model;
  const baseUrl =
    typeof object.baseUrl === "string" ? object.baseUrl.trim() : preset.baseUrl;

  return {
    providerId,
    providerName,
    baseUrl,
    apiKeySource: isApiKeySource(object.apiKeySource)
      ? object.apiKeySource
      : DEFAULT_API_SETTINGS.apiKeySource,
    apiKey: typeof object.apiKey === "string" ? object.apiKey.trim() : "",
    model,
    modelOptions: normalizeModelOptions(object.modelOptions),
    modelsEndpoint:
      typeof object.modelsEndpoint === "string"
        ? object.modelsEndpoint.trim()
        : getDefaultModelsEndpoint(baseUrl),
    reasoningEffort: isReasoningEffort(object.reasoningEffort)
      ? object.reasoningEffort
      : preset.reasoningEffort,
    userPreference:
      typeof object.userPreference === "string"
        ? object.userPreference.slice(0, MAX_USER_PREFERENCE_LENGTH)
        : ""
  };
}

export function loadApiSettings(): ApiSettings {
  if (typeof window === "undefined") {
    return DEFAULT_API_SETTINGS;
  }

  try {
    return normalizeApiSettings(
      JSON.parse(window.localStorage.getItem(API_SETTINGS_STORAGE_KEY) ?? "null")
    );
  } catch {
    return DEFAULT_API_SETTINGS;
  }
}

export function saveApiSettings(settings: ApiSettings): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    API_SETTINGS_STORAGE_KEY,
    JSON.stringify(normalizeApiSettings(settings))
  );
}

export function serializeApiSettings(settings: ApiSettings): ApiSettings {
  const normalized = normalizeApiSettings(settings);
  return {
    ...normalized,
    apiKey: normalized.apiKeySource === "manual" ? normalized.apiKey : "",
    userPreference: normalized.userPreference.trim()
  };
}

export function hasCompleteApiSettings(settings: ApiSettings): boolean {
  const normalized = normalizeApiSettings(settings);
  return Boolean(
    (normalized.apiKeySource === "environment" || normalized.apiKey.trim()) &&
      normalized.baseUrl.trim() &&
      normalized.model.trim()
  );
}

export function getApiKeyEnvironmentName(settings: ApiSettings): string {
  const normalized = normalizeApiSettings(settings);

  if (normalized.providerId === "openrouter") {
    return "OPENROUTER_API_KEY";
  }
  if (normalized.providerId === "openai") {
    return "OPENAI_API_KEY";
  }

  return "STREAMUI_API_KEY";
}
