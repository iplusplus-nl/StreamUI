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
  userPreferencePrompt: string;
  memoryItems: MemoryItem[];
};

export type MemoryItem = {
  id: string;
  text: string;
};

type LegacyUserPreferences = {
  responseTone: string;
  interfaceStyle: string;
  defaultTechnicalPreferences: string;
  longTermMemory: string;
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
export const MAX_USER_PREFERENCE_PROMPT_LENGTH = 4_000;
export const MAX_MEMORY_ITEMS = 80;
export const MAX_MEMORY_ITEM_ID_LENGTH = 80;
export const MAX_MEMORY_ITEM_TEXT_LENGTH = 800;

const DEFAULT_LEGACY_USER_PREFERENCES: LegacyUserPreferences = {
  responseTone: "",
  interfaceStyle: "",
  defaultTechnicalPreferences: "",
  longTermMemory: ""
};

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
  userPreferencePrompt: "",
  memoryItems: []
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

function normalizeUserPreferencePrompt(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, MAX_USER_PREFERENCE_PROMPT_LENGTH)
    : "";
}

function normalizeLegacyPreferenceField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasLegacyUserPreferenceContent(
  preferences: LegacyUserPreferences
): boolean {
  return Boolean(
    preferences.responseTone ||
      preferences.interfaceStyle ||
      preferences.defaultTechnicalPreferences ||
      preferences.longTermMemory
  );
}

function normalizeLegacyUserPreferences(
  input: unknown,
  legacyUserPreference = ""
): LegacyUserPreferences {
  const object =
    typeof input === "object" && input !== null
      ? (input as Partial<LegacyUserPreferences>)
      : {};
  const preferences = {
    responseTone: normalizeLegacyPreferenceField(object.responseTone),
    interfaceStyle: normalizeLegacyPreferenceField(object.interfaceStyle),
    defaultTechnicalPreferences: normalizeLegacyPreferenceField(
      object.defaultTechnicalPreferences
    ),
    longTermMemory: normalizeLegacyPreferenceField(object.longTermMemory)
  };

  if (!hasLegacyUserPreferenceContent(preferences) && legacyUserPreference) {
    return {
      ...preferences,
      responseTone: legacyUserPreference.trim()
    };
  }

  return preferences;
}

function formatLegacyUserPreferencePrompt(
  preferences: LegacyUserPreferences
): string {
  const entries = [
    ["Response tone", preferences.responseTone],
    ["Interface style", preferences.interfaceStyle],
    ["Default technical preferences", preferences.defaultTechnicalPreferences]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  if (!entries.length) {
    return "";
  }

  if (entries.length === 1 && entries[0][0] === "Response tone") {
    return entries[0][1];
  }

  return entries.map(([label, value]) => `${label}: ${value}`).join("\n");
}

function legacyMemoryText(value: string): string[] {
  const lines = value
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);

  return lines.length ? lines : value.trim() ? [value.trim()] : [];
}

function normalizeMemoryItemId(value: unknown, fallbackIndex: number): string {
  const normalized =
    typeof value === "string"
      ? value.trim().slice(0, MAX_MEMORY_ITEM_ID_LENGTH)
      : "";

  return normalized || `memory-${fallbackIndex + 1}`;
}

function uniqueMemoryItemId(
  id: string,
  seenIds: Set<string>,
  fallbackIndex: number
): string {
  let candidate = id;
  let suffix = 2;

  while (seenIds.has(candidate.toLowerCase())) {
    const suffixText = `-${suffix}`;
    candidate = `${id.slice(
      0,
      Math.max(1, MAX_MEMORY_ITEM_ID_LENGTH - suffixText.length)
    )}${suffixText}`;
    suffix += 1;
  }

  seenIds.add(candidate.toLowerCase());
  return candidate || `memory-${fallbackIndex + 1}`;
}

function normalizeMemoryText(value: unknown): string {
  return typeof value === "string"
    ? value.trim().slice(0, MAX_MEMORY_ITEM_TEXT_LENGTH)
    : "";
}

export function createMemoryItemId(
  now = Date.now(),
  random = Math.random
): string {
  const randomPart = random().toString(36).slice(2, 8) || "item";
  return `memory-${now.toString(36)}-${randomPart}`.slice(
    0,
    MAX_MEMORY_ITEM_ID_LENGTH
  );
}

export function normalizeMemoryItems(input: unknown): MemoryItem[] {
  const candidates = Array.isArray(input) ? input : [];
  const seenIds = new Set<string>();
  const items: MemoryItem[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const object =
      typeof candidate === "object" && candidate !== null
        ? (candidate as Partial<MemoryItem>)
        : {};
    const text = normalizeMemoryText(
      typeof candidate === "string" ? candidate : object.text
    );
    if (!text) {
      continue;
    }

    const id = uniqueMemoryItemId(
      normalizeMemoryItemId(object.id, index),
      seenIds,
      index
    );
    items.push({ id, text });

    if (items.length >= MAX_MEMORY_ITEMS) {
      break;
    }
  }

  return items;
}

export function normalizeApiSettings(input: unknown): ApiSettings {
  const object =
    typeof input === "object" && input !== null
      ? (input as Partial<ApiSettings> & {
          userPreference?: unknown;
          userPreferences?: unknown;
        })
      : {};
  const legacyUserPreference =
    typeof object.userPreference === "string"
      ? object.userPreference.slice(0, MAX_USER_PREFERENCE_PROMPT_LENGTH)
      : "";
  const legacyUserPreferences = normalizeLegacyUserPreferences(
    object.userPreferences,
    legacyUserPreference
  );
  const legacyUserPreferencePrompt = formatLegacyUserPreferencePrompt(
    legacyUserPreferences
  ).slice(0, MAX_USER_PREFERENCE_PROMPT_LENGTH);
  const normalizedUserPreferencePrompt =
    typeof object.userPreferencePrompt === "string"
      ? normalizeUserPreferencePrompt(object.userPreferencePrompt)
      : "";
  const userPreferencePrompt =
    normalizedUserPreferencePrompt.trim() || !legacyUserPreferencePrompt
      ? normalizedUserPreferencePrompt
      : legacyUserPreferencePrompt;
  const normalizedMemoryItems = Array.isArray(object.memoryItems)
    ? normalizeMemoryItems(object.memoryItems)
    : [];
  const legacyMemoryItems = normalizeMemoryItems(
    legacyMemoryText(legacyUserPreferences.longTermMemory)
  );
  const memoryItems =
    normalizedMemoryItems.length || !legacyMemoryItems.length
      ? normalizedMemoryItems
      : legacyMemoryItems;
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
    userPreferencePrompt,
    memoryItems
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

export function hasSavedApiSettings(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(API_SETTINGS_STORAGE_KEY) !== null;
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
    userPreferencePrompt: normalized.userPreferencePrompt.trim(),
    memoryItems: normalizeMemoryItems(normalized.memoryItems)
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
