import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_API_SETTINGS,
  DEFAULT_UI_COMPLEXITY,
  ACCOUNT_API_MEMORY_STORAGE_PREFIX,
  API_SETTINGS_STORAGE_KEY,
  LOCAL_API_MEMORY_STORAGE_KEY,
  MAX_MEMORY_ITEM_TEXT_LENGTH,
  MAX_USER_PREFERENCE_PROMPT_LENGTH,
  REQUIRED_MODEL_OPTIONS,
  createMemoryItemId,
  getDefaultModelsEndpoint,
  getProviderModelCatalog,
  getSelectableModelOptions,
  getUiComplexityLevel,
  hasCompleteApiSettings,
  loadApiSettingsFromStorage,
  normalizeApiSettings,
  normalizeModelIdForProvider,
  normalizeMemoryItems,
  normalizeUiComplexity,
  providerSupportsReasoning,
  saveApiSettingsToStorage,
  type ApiSettingsStorage,
  serializeApiSettings
} from "./apiSettings";

function memoryStorage(
  initial: Record<string, string> = {}
): ApiSettingsStorage & { entries(): Record<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    entries: () => Object.fromEntries(values)
  };
}

describe("apiSettings", () => {
  it("defaults user memory settings to an empty prompt and table", () => {
    assert.equal(DEFAULT_API_SETTINGS.userPreferencePrompt, "");
    assert.equal(DEFAULT_API_SETTINGS.uiComplexity, DEFAULT_UI_COMPLEXITY);
    assert.equal(normalizeApiSettings(null).userPreferencePrompt, "");
    assert.equal(normalizeApiSettings(null).uiComplexity, DEFAULT_UI_COMPLEXITY);
    assert.deepEqual(normalizeApiSettings(null).memoryItems, []);
  });

  it("keeps memory in separate storage for every account", () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    saveApiSettingsToStorage(
      {
        ...DEFAULT_API_SETTINGS,
        userPreferencePrompt: "Account A preferences",
        memoryItems: [{ id: "a", text: "Account A memory" }]
      },
      "user/a",
      localStorage,
      sessionStorage
    );
    saveApiSettingsToStorage(
      {
        ...DEFAULT_API_SETTINGS,
        userPreferencePrompt: "Account B preferences",
        memoryItems: [{ id: "b", text: "Account B memory" }]
      },
      "user/b",
      localStorage,
      sessionStorage
    );

    const accountA = loadApiSettingsFromStorage(
      "user/a",
      localStorage,
      sessionStorage
    );
    const accountB = loadApiSettingsFromStorage(
      "user/b",
      localStorage,
      sessionStorage
    );
    const anonymous = loadApiSettingsFromStorage(
      null,
      localStorage,
      sessionStorage
    );

    assert.equal(accountA.userPreferencePrompt, "Account A preferences");
    assert.deepEqual(accountA.memoryItems, [
      { id: "a", text: "Account A memory" }
    ]);
    assert.equal(accountB.userPreferencePrompt, "Account B preferences");
    assert.deepEqual(accountB.memoryItems, [
      { id: "b", text: "Account B memory" }
    ]);
    assert.equal(anonymous.userPreferencePrompt, "");
    assert.deepEqual(anonymous.memoryItems, []);
    assert.ok(
      localStorage.entries()[
        `${ACCOUNT_API_MEMORY_STORAGE_PREFIX}${encodeURIComponent("user/a")}`
      ]
    );
    assert.ok(
      localStorage.entries()[
        `${ACCOUNT_API_MEMORY_STORAGE_PREFIX}${encodeURIComponent("user/b")}`
      ]
    );
  });

  it("does not leave memory in globally shared API settings", () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    saveApiSettingsToStorage(
      {
        ...DEFAULT_API_SETTINGS,
        userPreferencePrompt: "Private preference",
        memoryItems: [{ id: "private", text: "Private memory" }]
      },
      "account-1",
      localStorage,
      sessionStorage
    );

    const shared = JSON.parse(
      localStorage.entries()[API_SETTINGS_STORAGE_KEY]
    ) as Record<string, unknown>;
    assert.equal("userPreferencePrompt" in shared, false);
    assert.equal("memoryItems" in shared, false);
  });

  it("migrates legacy global memory only to the local browser scope", () => {
    const legacy = {
      ...DEFAULT_API_SETTINGS,
      userPreferencePrompt: "Unowned legacy preference",
      memoryItems: [{ id: "legacy", text: "Unowned legacy memory" }]
    };
    const localStorage = memoryStorage({
      [API_SETTINGS_STORAGE_KEY]: JSON.stringify(legacy)
    });
    const sessionStorage = memoryStorage();

    const account = loadApiSettingsFromStorage(
      "account-1",
      localStorage,
      sessionStorage
    );
    const local = loadApiSettingsFromStorage(
      null,
      localStorage,
      sessionStorage
    );

    assert.equal(account.userPreferencePrompt, "");
    assert.deepEqual(account.memoryItems, []);
    assert.equal(local.userPreferencePrompt, "Unowned legacy preference");
    assert.deepEqual(local.memoryItems, [
      { id: "legacy", text: "Unowned legacy memory" }
    ]);
    saveApiSettingsToStorage(
      local,
      null,
      localStorage,
      sessionStorage
    );
    assert.match(
      localStorage.getItem(LOCAL_API_MEMORY_STORAGE_KEY) ?? "",
      /Unowned legacy memory/
    );
  });

  it("derives the default models endpoint from the base URL", () => {
    assert.equal(
      getDefaultModelsEndpoint("https://api.example.com/v1/"),
      "https://api.example.com/v1/models"
    );
  });

  it("keeps OpenRouter as the open-source default provider", () => {
    assert.equal(DEFAULT_API_SETTINGS.providerId, "openrouter");
    assert.equal(DEFAULT_API_SETTINGS.apiStyle, "responses");
    assert.equal(DEFAULT_API_SETTINGS.apiKeySource, "environment");
  });

  it("supports Responses and Chat Completions API styles", () => {
    assert.equal(
      normalizeApiSettings({ apiStyle: "responses" }).apiStyle,
      "responses"
    );
    assert.equal(
      normalizeApiSettings({ apiStyle: "chat-completions" }).apiStyle,
      "chat-completions"
    );
    assert.equal(
      normalizeApiSettings({ apiStyle: "legacy" }).apiStyle,
      "responses"
    );
  });

  it("uses an OpenRouter shortlist by default without forcing it after edits", () => {
    assert.deepEqual(DEFAULT_API_SETTINGS.modelOptions, REQUIRED_MODEL_OPTIONS);
    assert.deepEqual(
      normalizeApiSettings({ modelOptions: [] }).modelOptions,
      []
    );
  });

  it("provides provider-compatible starter catalogs", () => {
    assert.deepEqual(getProviderModelCatalog("openrouter"), REQUIRED_MODEL_OPTIONS);
    assert.deepEqual(getProviderModelCatalog("openai"), ["gpt-4.1"]);
    assert.deepEqual(getProviderModelCatalog("local"), ["llama3.1"]);
    assert.deepEqual(getProviderModelCatalog("custom"), []);
  });

  it("supports ChatHTML Cloud as a managed provider preset", () => {
    const normalized = normalizeApiSettings({
      providerId: "chathtml-cloud",
      apiKeySource: "manual",
      apiKey: "should-not-be-used"
    });
    const serialized = serializeApiSettings(normalized);

    assert.equal(normalized.providerId, "chathtml-cloud");
    assert.equal(normalized.apiKeySource, "managed");
    assert.equal(normalized.baseUrl, "");
    assert.equal(normalized.modelsEndpoint, "");
    assert.equal(hasCompleteApiSettings(normalized), true);
    assert.equal(serialized.apiKey, "");
  });

  it("keeps the active model in selectable UI options", () => {
    const normalized = normalizeApiSettings({
      providerId: "openrouter",
      model: "anthropic/claude-sonnet-4",
      modelOptions: ["openai/gpt-4.1", "anthropic/claude-sonnet-4"]
    });

    assert.deepEqual(getSelectableModelOptions(normalized), [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1"
    ]);
  });

  it("normalizes direct OpenAI IDs and excludes vendor-qualified models", () => {
    const normalized = normalizeApiSettings({
      providerId: "openai",
      model: "openai/gpt-5.5",
      modelOptions: [
        "openai/gpt-5.5",
        "google/gemini-custom",
        "ANTHROPIC/CLAUDE-CUSTOM",
        "z-ai/glm-custom",
        "gpt-4o"
      ]
    });

    assert.deepEqual(getSelectableModelOptions(normalized), [
      "gpt-5.5",
      "gpt-4o"
    ]);
    assert.equal(normalized.model, "gpt-5.5");
    assert.equal(normalizeModelIdForProvider("openai/gpt-4.1", "openai"), "gpt-4.1");
    assert.equal(normalizeModelIdForProvider("google/gemini-pro", "openai"), null);
  });

  it("keeps only the active OpenRouter model selectable after the list is cleared", () => {
    const normalized = normalizeApiSettings({
      providerId: "openrouter",
      model: "vendor/active-model",
      modelOptions: []
    });

    assert.deepEqual(getSelectableModelOptions(normalized), ["vendor/active-model"]);
  });

  it("does not inject OpenRouter models into local and custom providers", () => {
    const local = normalizeApiSettings({
      providerId: "local",
      model: "my-local-model",
      modelOptions: []
    });
    const custom = normalizeApiSettings({
      providerId: "custom",
      model: "deployment-42",
      modelOptions: []
    });

    assert.deepEqual(getSelectableModelOptions(local), ["my-local-model"]);
    assert.deepEqual(getSelectableModelOptions(custom), ["deployment-42"]);
  });

  it("deduplicates model options case-insensitively", () => {
    const normalized = normalizeApiSettings({
      providerId: "openrouter",
      model: "openai/gpt-5.5",
      modelOptions: ["OpenAI/GPT-5.5", "google/gemini-pro"]
    });

    assert.deepEqual(getSelectableModelOptions(normalized), [
      "openai/gpt-5.5",
      "google/gemini-pro"
    ]);
  });

  it("hides unsupported reasoning and migrates xhigh to high", () => {
    assert.equal(providerSupportsReasoning("openrouter"), true);
    assert.equal(providerSupportsReasoning("openai"), false);
    assert.equal(
      normalizeApiSettings({ providerId: "openrouter", reasoningEffort: "xhigh" })
        .reasoningEffort,
      "high"
    );
    assert.equal(
      normalizeApiSettings({ providerId: "custom", reasoningEffort: "high" })
        .reasoningEffort,
      "none"
    );
  });

  it("normalizes UI complexity as a clamped integer", () => {
    assert.equal(normalizeUiComplexity("73.8"), 74);
    assert.equal(normalizeUiComplexity(-20), 0);
    assert.equal(normalizeUiComplexity(120), 100);
    assert.equal(normalizeUiComplexity("nope", 35), 35);
    assert.equal(normalizeApiSettings({ uiComplexity: "88" }).uiComplexity, 88);
  });

  it("maps UI complexity values onto five display levels", () => {
    assert.equal(getUiComplexityLevel(0).label, "Minimal");
    assert.equal(getUiComplexityLevel(20).label, "Minimal");
    assert.equal(getUiComplexityLevel(21).label, "Simple");
    assert.equal(getUiComplexityLevel(41).label, "Balanced");
    assert.equal(getUiComplexityLevel(66).label, "Rich");
    assert.equal(getUiComplexityLevel(86).label, "Elaborate");
    assert.equal(getUiComplexityLevel(100).label, "Elaborate");
  });

  it("preserves the new user preference prompt while normalizing settings", () => {
    const normalized = normalizeApiSettings({
      providerId: "openrouter",
      userPreferencePrompt: "  Always answer in concise Chinese.  "
    });

    assert.equal(
      normalized.userPreferencePrompt,
      "  Always answer in concise Chinese.  "
    );
  });

  it("trims user preference prompt only for request serialization", () => {
    const serialized = serializeApiSettings({
      ...DEFAULT_API_SETTINGS,
      userPreferencePrompt: "  Prefer compact answers.  "
    });

    assert.equal(serialized.userPreferencePrompt, "Prefer compact answers.");
  });

  it("caps user preference prompt length", () => {
    const oversizedPreference = "x".repeat(
      MAX_USER_PREFERENCE_PROMPT_LENGTH + 1
    );
    const normalized = normalizeApiSettings({
      userPreferencePrompt: oversizedPreference
    });

    assert.equal(
      normalized.userPreferencePrompt.length,
      MAX_USER_PREFERENCE_PROMPT_LENGTH
    );
  });

  it("migrates legacy structured preferences into prompt and memory items", () => {
    const normalized = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      userPreferences: {
        responseTone: "  Warm and direct.  ",
        interfaceStyle: "Use dense controls.",
        defaultTechnicalPreferences: "Prefer TypeScript.",
        longTermMemory: "- User ships small increments.\n- Likes concise plans."
      }
    });

    assert.equal(
      normalized.userPreferencePrompt,
      [
        "Response tone: Warm and direct.",
        "Interface style: Use dense controls.",
        "Default technical preferences: Prefer TypeScript."
      ].join("\n")
    );
    assert.deepEqual(
      normalized.memoryItems.map((item) => item.text),
      ["User ships small increments.", "Likes concise plans."]
    );
  });

  it("migrates legacy userPreference into the prompt", () => {
    const normalized = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      userPreference: "  Prefer compact answers.  "
    });

    assert.equal(normalized.userPreferencePrompt, "Prefer compact answers.");
    assert.deepEqual(normalized.memoryItems, []);
  });

  it("serializes memory settings with trimmed prompt and normalized items", () => {
    const serialized = serializeApiSettings({
      ...DEFAULT_API_SETTINGS,
      userPreferencePrompt: "  Warm.  ",
      memoryItems: [
        { id: "one", text: "  Likes concise plans.  " },
        { id: "two", text: "" }
      ]
    });

    assert.equal(serialized.userPreferencePrompt, "Warm.");
    assert.deepEqual(serialized.memoryItems, [
      { id: "one", text: "Likes concise plans." }
    ]);
  });

  it("normalizes memory items by dropping empty text, capping text, and deduping ids", () => {
    const oversizedMemory = "x".repeat(MAX_MEMORY_ITEM_TEXT_LENGTH + 1);
    const normalized = normalizeMemoryItems([
      { id: "same", text: "  First  " },
      { id: "same", text: oversizedMemory },
      { id: "empty", text: "   " }
    ]);

    assert.deepEqual(
      normalized.map((item) => item.id),
      ["same", "same-2"]
    );
    assert.equal(normalized[0].text, "First");
    assert.equal(normalized[1].text.length, MAX_MEMORY_ITEM_TEXT_LENGTH);
  });

  it("creates deterministic memory item ids when inputs are injected", () => {
    assert.equal(createMemoryItemId(123, () => 0.5), "memory-3f-i");
  });

  it("omits manual API key when environment key source is selected", () => {
    const serialized = serializeApiSettings({
      ...DEFAULT_API_SETTINGS,
      apiKeySource: "environment",
      apiKey: "secret",
      userPreferencePrompt: "Use a warmer tone."
    });

    assert.equal(serialized.apiKey, "");
    assert.equal(serialized.userPreferencePrompt, "Use a warmer tone.");
  });
});
