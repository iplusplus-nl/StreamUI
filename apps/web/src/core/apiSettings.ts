export type ApiProviderId =
  | "openrouter"
  | "chathtml-cloud"
  | "openai"
  | "local"
  | "custom";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ApiKeySource = "environment" | "manual" | "managed";

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
  uiComplexity: number;
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
  apiKeySource?: ApiKeySource;
};

export const API_SETTINGS_STORAGE_KEY = "streamui.apiSettings.v1";
export const MAX_MODEL_OPTIONS = 120;
export const MAX_MODEL_ID_LENGTH = 180;
export const MAX_USER_PREFERENCE_PROMPT_LENGTH = 4_000;
export const MAX_MEMORY_ITEMS = 80;
export const MAX_MEMORY_ITEM_ID_LENGTH = 80;
export const MAX_MEMORY_ITEM_TEXT_LENGTH = 800;
export const UI_COMPLEXITY_MIN = 0;
export const UI_COMPLEXITY_MAX = 100;
export const DEFAULT_UI_COMPLEXITY = 50;
export const UI_COMPLEXITY_LEVEL_OPTIONS = [
  { value: 10, max: 20, label: "Minimal" },
  { value: 30, max: 40, label: "Simple" },
  { value: 50, max: 65, label: "Balanced" },
  { value: 75, max: 85, label: "Rich" },
  { value: 90, max: 100, label: "Elaborate" }
] as const;

export const REQUIRED_MODEL_OPTIONS = [
  "openai/gpt-5.5",
  "google/gemini-3.1-pro-preview",
  "anthropic/claude-sonnet-5",
  "z-ai/glm-5.2"
] as const;

export const API_PROVIDER_PRESETS: ApiProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-3.1-pro-preview",
    reasoningEffort: "low"
  },
  {
    id: "chathtml-cloud",
    label: "ChatHTML Cloud",
    baseUrl: "",
    model: "google/gemini-3.1-pro-preview",
    reasoningEffort: "low",
    apiKeySource: "managed"
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
  modelOptions: [...REQUIRED_MODEL_OPTIONS],
  modelsEndpoint: getDefaultModelsEndpoint(DEFAULT_PRESET.baseUrl),
  reasoningEffort: DEFAULT_PRESET.reasoningEffort,
  uiComplexity: DEFAULT_UI_COMPLEXITY,
  userPreferencePrompt: "",
  memoryItems: []
};

const REQUIRED_MODEL_OPTION_KEYS = new Set(
  REQUIRED_MODEL_OPTIONS.map((model) => model.toLowerCase())
);

const OPENAI_INCOMPATIBLE_MODEL_PREFIXES = [
  "google/",
  "anthropic/",
  "z-ai/"
] as const;

function isProviderId(value: unknown): value is ApiProviderId {
  return API_PROVIDER_PRESETS.some((preset) => preset.id === value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.value === value);
}

export function normalizeUiComplexity(
  value: unknown,
  fallback = DEFAULT_UI_COMPLEXITY
): number {
  const numericValue =
    typeof value === "string" && value.trim()
      ? Number(value)
      : typeof value === "number"
        ? value
        : fallback;

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(
    UI_COMPLEXITY_MAX,
    Math.max(UI_COMPLEXITY_MIN, Math.round(numericValue))
  );
}

export function getUiComplexityLevel(value: unknown) {
  const normalized = normalizeUiComplexity(value);

  return (
    UI_COMPLEXITY_LEVEL_OPTIONS.find((option) => normalized <= option.max) ??
    UI_COMPLEXITY_LEVEL_OPTIONS[UI_COMPLEXITY_LEVEL_OPTIONS.length - 1]
  );
}

function isApiKeySource(value: unknown): value is ApiKeySource {
  return (
    value === "managed" ||
    API_KEY_SOURCE_OPTIONS.some((option) => option.value === value)
  );
}

function normalizeApiKeySourceForPreset(
  value: unknown,
  preset: ApiProviderPreset
): ApiKeySource {
  if (preset.apiKeySource === "managed") {
    return "managed";
  }

  if (isApiKeySource(value) && value !== "managed") {
    return value;
  }

  return preset.apiKeySource ?? DEFAULT_API_SETTINGS.apiKeySource;
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

  for (const modelId of REQUIRED_MODEL_OPTIONS) {
    seen.add(modelId.toLowerCase());
    options.push(modelId);
  }

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

export function isRequiredModelOption(modelId: string): boolean {
  return REQUIRED_MODEL_OPTION_KEYS.has(modelId.trim().toLowerCase());
}

export function getSelectableModelOptions(settings: ApiSettings): string[] {
  const options = normalizeModelOptions([
    settings.model,
    ...settings.modelOptions
  ]);

  if (settings.providerId !== "openai") {
    return options;
  }

  return options.filter((modelId) => {
    const normalizedModelId = modelId.trim().toLowerCase();
    return !OPENAI_INCOMPATIBLE_MODEL_PREFIXES.some((prefix) =>
      normalizedModelId.startsWith(prefix)
    );
  });
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
    apiKeySource: normalizeApiKeySourceForPreset(
      object.apiKeySource,
      preset
    ),
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
    uiComplexity: normalizeUiComplexity(object.uiComplexity),
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
    (normalized.apiKeySource === "managed" ||
      normalized.apiKeySource === "environment" ||
      normalized.apiKey.trim()) &&
      (normalized.apiKeySource === "managed" || normalized.baseUrl.trim()) &&
      normalized.model.trim()
  );
}

export function getApiKeyEnvironmentName(settings: ApiSettings): string {
  const normalized = normalizeApiSettings(settings);

  if (normalized.providerId === "chathtml-cloud") {
    return "CHATHTML_CLOUD_API_KEY";
  }
  if (normalized.providerId === "openrouter") {
    return "OPENROUTER_API_KEY";
  }
  if (normalized.providerId === "openai") {
    return "OPENAI_API_KEY";
  }

  return "STREAMUI_API_KEY";
}
