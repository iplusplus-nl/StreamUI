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

export type ApiStyle = "responses" | "chat-completions";

export type ApiSettings = {
  providerId: ApiProviderId;
  providerName: string;
  baseUrl: string;
  apiStyle: ApiStyle;
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

export type ApiMemorySettings = Pick<
  ApiSettings,
  "userPreferencePrompt" | "memoryItems"
>;

export type ApiSettingsStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

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
  apiStyle?: ApiStyle;
  apiKeySource?: ApiKeySource;
};

export const API_SETTINGS_STORAGE_KEY = "streamui.apiSettings.v1";
export const LOCAL_API_MEMORY_STORAGE_KEY = "streamui.apiMemory.local.v1";
export const ACCOUNT_API_MEMORY_STORAGE_PREFIX =
  "streamui.apiMemory.account.v1.";
const MANUAL_API_KEY_SESSION_STORAGE_KEY = "chathtml.manualApiKey.session.v1";
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

export const OPENROUTER_MODEL_OPTIONS = [
  "openai/gpt-5.5",
  "google/gemini-3.1-pro-preview",
  "anthropic/claude-sonnet-5",
  "z-ai/glm-5.2"
] as const;

/**
 * Kept as a compatibility export for code that still refers to the original
 * OpenRouter shortlist. These models are defaults, not mandatory selections.
 */
export const REQUIRED_MODEL_OPTIONS = OPENROUTER_MODEL_OPTIONS;

const PROVIDER_MODEL_CATALOGS: Record<ApiProviderId, readonly string[]> = {
  openrouter: OPENROUTER_MODEL_OPTIONS,
  "chathtml-cloud": OPENROUTER_MODEL_OPTIONS,
  openai: ["gpt-4.1"],
  local: ["llama3.1"],
  custom: []
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
  { value: "high", label: "High" }
];

export const API_KEY_SOURCE_OPTIONS: Array<{
  value: ApiKeySource;
  label: string;
}> = [
  { value: "environment", label: "Environment" },
  { value: "manual", label: "Manual" }
];

export const API_STYLE_OPTIONS: Array<{
  value: ApiStyle;
  label: string;
  description: string;
}> = [
  {
    value: "responses",
    label: "Responses",
    description: "Use the /responses API"
  },
  {
    value: "chat-completions",
    label: "Chat Completions",
    description: "Use the widely supported /chat/completions API"
  }
];

const DEFAULT_PRESET = API_PROVIDER_PRESETS[0];

export const DEFAULT_API_SETTINGS: ApiSettings = {
  providerId: DEFAULT_PRESET.id,
  providerName: DEFAULT_PRESET.label,
  baseUrl: DEFAULT_PRESET.baseUrl,
  apiStyle: DEFAULT_PRESET.apiStyle ?? "responses",
  apiKeySource: "environment",
  apiKey: "",
  model: DEFAULT_PRESET.model,
  modelOptions: [...OPENROUTER_MODEL_OPTIONS],
  modelsEndpoint: getDefaultModelsEndpoint(DEFAULT_PRESET.baseUrl),
  reasoningEffort: DEFAULT_PRESET.reasoningEffort,
  uiComplexity: DEFAULT_UI_COMPLEXITY,
  userPreferencePrompt: "",
  memoryItems: []
};

function isProviderId(value: unknown): value is ApiProviderId {
  return API_PROVIDER_PRESETS.some((preset) => preset.id === value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some((option) => option.value === value);
}

function normalizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort
): ReasoningEffort {
  if (value === "xhigh") {
    return "high";
  }

  return isReasoningEffort(value) ? value : fallback;
}

export function providerSupportsReasoning(providerId: ApiProviderId): boolean {
  return providerId === "openrouter" || providerId === "chathtml-cloud";
}

export function getProviderModelCatalog(
  providerId: ApiProviderId
): string[] {
  return [...PROVIDER_MODEL_CATALOGS[providerId]];
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

export function normalizeApiStyle(value: unknown): ApiStyle {
  return value === "chat-completions" ? "chat-completions" : "responses";
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

export function normalizeModelIdForProvider(
  value: unknown,
  providerId: ApiProviderId
): string | null {
  const modelId = normalizeModelId(value);
  if (!modelId || providerId !== "openai") {
    return modelId;
  }

  const directModelId = modelId.replace(/^openai\//i, "");
  return directModelId && !directModelId.includes("/") ? directModelId : null;
}

export function normalizeModelOptions(
  input: unknown,
  providerId: ApiProviderId = DEFAULT_PRESET.id
): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  const candidates = Array.isArray(input) ? input : [];

  for (const candidate of candidates) {
    const modelId = normalizeModelIdForProvider(candidate, providerId);
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
  return normalizeModelOptions(
    [settings.model, ...settings.modelOptions],
    settings.providerId
  );
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
      ? (normalizeModelIdForProvider(object.model, providerId) ?? preset.model)
      : preset.model;
  const baseUrl =
    typeof object.baseUrl === "string" ? object.baseUrl.trim() : preset.baseUrl;

  return {
    providerId,
    providerName,
    baseUrl,
    apiStyle: normalizeApiStyle(object.apiStyle),
    apiKeySource: normalizeApiKeySourceForPreset(
      object.apiKeySource,
      preset
    ),
    apiKey: typeof object.apiKey === "string" ? object.apiKey.trim() : "",
    model,
    modelOptions: normalizeModelOptions(
      Array.isArray(object.modelOptions)
        ? object.modelOptions
        : getProviderModelCatalog(providerId),
      providerId
    ),
    modelsEndpoint:
      typeof object.modelsEndpoint === "string"
        ? object.modelsEndpoint.trim()
        : getDefaultModelsEndpoint(baseUrl),
    reasoningEffort: providerSupportsReasoning(providerId)
      ? normalizeReasoningEffort(object.reasoningEffort, preset.reasoningEffort)
      : "none",
    uiComplexity: normalizeUiComplexity(object.uiComplexity),
    userPreferencePrompt,
    memoryItems
  };
}

function apiMemoryStorageKey(ownerId: string | null): string {
  return ownerId
    ? `${ACCOUNT_API_MEMORY_STORAGE_PREFIX}${encodeURIComponent(ownerId)}`
    : LOCAL_API_MEMORY_STORAGE_KEY;
}

function emptyApiMemorySettings(): ApiMemorySettings {
  return {
    userPreferencePrompt: "",
    memoryItems: []
  };
}

function apiMemorySettingsFrom(input: unknown): ApiMemorySettings {
  const normalized = normalizeApiSettings(input);
  return {
    userPreferencePrompt: normalized.userPreferencePrompt,
    memoryItems: normalized.memoryItems
  };
}

export function loadApiMemorySettings(
  ownerId: string | null,
  storage: ApiSettingsStorage
): ApiMemorySettings {
  try {
    const scoped = storage.getItem(apiMemoryStorageKey(ownerId));
    if (scoped !== null) {
      return apiMemorySettingsFrom(JSON.parse(scoped));
    }

    if (ownerId !== null) {
      return emptyApiMemorySettings();
    }

    // Memory used to live in the global settings record. It may safely migrate
    // only into the browser-local scope because its account owner is unknown.
    const legacy = storage.getItem(API_SETTINGS_STORAGE_KEY);
    return legacy === null
      ? emptyApiMemorySettings()
      : apiMemorySettingsFrom(JSON.parse(legacy));
  } catch {
    return emptyApiMemorySettings();
  }
}

export function saveApiMemorySettings(
  ownerId: string | null,
  settings: ApiMemorySettings,
  storage: ApiSettingsStorage
): void {
  const normalized = apiMemorySettingsFrom(settings);
  storage.setItem(apiMemoryStorageKey(ownerId), JSON.stringify(normalized));
}

function settingsWithoutMemory(settings: ApiSettings): Omit<
  ApiSettings,
  "userPreferencePrompt" | "memoryItems"
> {
  const { userPreferencePrompt: _prompt, memoryItems: _memoryItems, ...shared } =
    settings;
  return shared;
}

export function loadApiSettingsFromStorage(
  ownerId: string | null,
  localStorage: ApiSettingsStorage,
  sessionStorage: ApiSettingsStorage
): ApiSettings {
  try {
    const persisted = normalizeApiSettings(
      JSON.parse(localStorage.getItem(API_SETTINGS_STORAGE_KEY) ?? "null")
    );
    const sessionKey =
      sessionStorage.getItem(MANUAL_API_KEY_SESSION_STORAGE_KEY) ??
      (persisted.apiKeySource === "manual" ? persisted.apiKey : "");
    const memory = loadApiMemorySettings(ownerId, localStorage);
    if (persisted.apiKey) {
      if (persisted.apiKeySource === "manual" && sessionKey) {
        sessionStorage.setItem(MANUAL_API_KEY_SESSION_STORAGE_KEY, sessionKey);
      }
      localStorage.setItem(
        API_SETTINGS_STORAGE_KEY,
        JSON.stringify({ ...settingsWithoutMemory(persisted), apiKey: "" })
      );
    }
    return normalizeApiSettings({
      ...persisted,
      ...memory,
      apiKey: sessionKey
    });
  } catch {
    return DEFAULT_API_SETTINGS;
  }
}

export function loadApiSettings(ownerId: string | null = null): ApiSettings {
  if (typeof window === "undefined") {
    return DEFAULT_API_SETTINGS;
  }

  return loadApiSettingsFromStorage(
    ownerId,
    window.localStorage,
    window.sessionStorage
  );
}

export function hasSavedApiSettings(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(API_SETTINGS_STORAGE_KEY) !== null;
}

export function saveApiSettingsToStorage(
  settings: ApiSettings,
  ownerId: string | null,
  localStorage: ApiSettingsStorage,
  sessionStorage: ApiSettingsStorage
): void {
  const normalized = normalizeApiSettings(settings);
  localStorage.setItem(
    API_SETTINGS_STORAGE_KEY,
    JSON.stringify({ ...settingsWithoutMemory(normalized), apiKey: "" })
  );
  saveApiMemorySettings(ownerId, normalized, localStorage);
  if (normalized.apiKeySource === "manual" && normalized.apiKey) {
    sessionStorage.setItem(
      MANUAL_API_KEY_SESSION_STORAGE_KEY,
      normalized.apiKey
    );
  } else {
    sessionStorage.removeItem(MANUAL_API_KEY_SESSION_STORAGE_KEY);
  }
}

export function saveApiSettings(
  settings: ApiSettings,
  ownerId: string | null = null
): void {
  if (typeof window === "undefined") {
    return;
  }

  saveApiSettingsToStorage(
    settings,
    ownerId,
    window.localStorage,
    window.sessionStorage
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
