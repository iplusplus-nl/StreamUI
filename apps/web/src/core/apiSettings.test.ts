import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_API_SETTINGS,
  MAX_MEMORY_ITEM_TEXT_LENGTH,
  MAX_USER_PREFERENCE_PROMPT_LENGTH,
  createMemoryItemId,
  getDefaultModelsEndpoint,
  getSelectableModelOptions,
  normalizeApiSettings,
  normalizeMemoryItems,
  serializeApiSettings
} from "./apiSettings";

describe("apiSettings", () => {
  it("defaults user memory settings to an empty prompt and table", () => {
    assert.equal(DEFAULT_API_SETTINGS.userPreferencePrompt, "");
    assert.equal(normalizeApiSettings(null).userPreferencePrompt, "");
    assert.deepEqual(normalizeApiSettings(null).memoryItems, []);
  });

  it("derives the default models endpoint from the base URL", () => {
    assert.equal(
      getDefaultModelsEndpoint("https://api.example.com/v1/"),
      "https://api.example.com/v1/models"
    );
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

  it("deduplicates model options case-insensitively", () => {
    const normalized = normalizeApiSettings({
      providerId: "openrouter",
      model: "openai/gpt-4.1",
      modelOptions: ["OpenAI/GPT-4.1", "google/gemini-pro"]
    });

    assert.deepEqual(getSelectableModelOptions(normalized), [
      "openai/gpt-4.1",
      "google/gemini-pro"
    ]);
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
