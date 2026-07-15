import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_API_SETTINGS,
  normalizeApiSettings
} from "../../core/apiSettings";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";
import {
  addSettingsModelOptions,
  applyImportedUserPreferences,
  changeSettingsBaseUrl,
  changeSettingsProvider,
  getExportedUserPreferences,
  removeSettingsModelOption,
  selectContinueLocalApiSettings,
  toggleSettingsModelSelection
} from "./settingsDraftModel";

describe("settings draft model", () => {
  it("moves the models endpoint with a base URL while it follows the default", () => {
    const current = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      baseUrl: "https://old.example/v1",
      modelsEndpoint: "https://old.example/v1/models"
    });

    const next = changeSettingsBaseUrl(current, "https://new.example/v2/");

    assert.equal(next.baseUrl, "https://new.example/v2/");
    assert.equal(next.modelsEndpoint, "https://new.example/v2/models");
  });

  it("preserves a custom models endpoint when the base URL changes", () => {
    const current = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      baseUrl: "https://old.example/v1",
      modelsEndpoint: "https://catalog.example/models"
    });

    const next = changeSettingsBaseUrl(current, "https://new.example/v1");

    assert.equal(next.modelsEndpoint, "https://catalog.example/models");
  });

  it("applies a provider preset while preserving an ordinary API key", () => {
    const current = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      providerId: "custom",
      apiKeySource: "manual",
      apiKey: "secret",
      model: "custom-model"
    });

    const next = changeSettingsProvider(current, "openai");

    assert.equal(next.providerId, "openai");
    assert.equal(next.providerName, "OpenAI");
    assert.equal(next.baseUrl, "https://api.openai.com/v1");
    assert.equal(next.modelsEndpoint, "https://api.openai.com/v1/models");
    assert.equal(next.model, "gpt-4.1");
    assert.deepEqual(next.modelOptions, ["gpt-4.1"]);
    assert.equal(next.reasoningEffort, "none");
    assert.equal(next.apiKeySource, "manual");
    assert.equal(next.apiKey, "secret");
  });

  it("forces managed provider credentials and clears a manual key", () => {
    const current = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      apiKeySource: "manual",
      apiKey: "secret"
    });

    const next = changeSettingsProvider(current, "chathtml-cloud");

    assert.equal(next.apiKeySource, "managed");
    assert.equal(next.apiKey, "");
  });

  it("toggles fetched model selection case-insensitively", () => {
    assert.deepEqual(toggleSettingsModelSelection([], "Vendor/Model"), [
      "Vendor/Model"
    ]);
    assert.deepEqual(
      toggleSettingsModelSelection(["Vendor/Model"], "vendor/model"),
      []
    );
  });

  it("allows every saved model to be toggled and removed", () => {
    const model = "openai/gpt-5.5";
    const selected = [model, "custom/model"];
    const current = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      model,
      modelOptions: selected
    });

    assert.deepEqual(toggleSettingsModelSelection(selected, model), [
      "custom/model"
    ]);
    assert.equal(removeSettingsModelOption(current, model).modelOptions.includes(model), false);
  });

  it("adds fetched models with case-insensitive normalization", () => {
    const current = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      modelOptions: ["Vendor/Existing"]
    });

    const next = addSettingsModelOptions(current, [
      "vendor/existing",
      "Vendor/New"
    ]);

    assert.equal(
      next.modelOptions.filter(
        (model) => model.toLowerCase() === "vendor/existing"
      ).length,
      1
    );
    assert.equal(next.modelOptions.includes("Vendor/New"), true);
  });

  it("selects a fallback when the active optional model is removed", () => {
    const current = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      model: "Vendor/Active",
      modelOptions: ["Vendor/Active", "Vendor/Other"]
    });

    const next = removeSettingsModelOption(current, "Vendor/Active");

    assert.notEqual(next.model, "Vendor/Active");
    assert.equal(next.modelOptions.includes("Vendor/Active"), false);
    assert.equal(next.modelOptions.includes(next.model), true);
  });

  it("keeps managed onboarding browser-direct even when server keys exist", () => {
    const current = normalizeApiSettings({ providerId: "chathtml-cloud" });
    const runtime: RuntimeSettingsSummary = {
      api: {
        defaults: current,
        environmentKeys: [
          { name: "OPENROUTER_API_KEY", configured: false },
          { name: "OPENAI_API_KEY", configured: true }
        ]
      },
      search: {
        environmentKeys: [],
        defaultProvider: "auto",
        defaultBrowserEngine: "fetch",
        providers: [],
        browserEngines: []
      }
    };

    const next = selectContinueLocalApiSettings(current, runtime);

    assert.equal(next.providerId, "openrouter");
    assert.equal(next.apiKeySource, "manual");
    assert.equal(next.apiKey, "");
  });

  it("selects OpenRouter manual setup with guidance when no key exists", () => {
    const current = normalizeApiSettings({ providerId: "chathtml-cloud" });
    const next = selectContinueLocalApiSettings(current, null);

    assert.equal(next.providerId, "openrouter");
    assert.equal(next.apiKeySource, "manual");
    assert.equal(next.apiKey, "");
  });

  it("exports normalized preferences without unrelated provider settings", () => {
    const exported = getExportedUserPreferences(
      normalizeApiSettings({
        ...DEFAULT_API_SETTINGS,
        userPreferencePrompt: "  concise  ",
        memoryItems: [
          { id: "memory-1", text: " First " },
          { id: "memory-1", text: "duplicate" },
          { id: "memory-2", text: "" }
        ]
      })
    );

    assert.deepEqual(exported, {
      userPreferencePrompt: "concise",
      memoryItems: [
        { id: "memory-1", text: "First" },
        { id: "memory-1-2", text: "duplicate" }
      ]
    });
  });

  it("imports only preferences and preserves the current provider", () => {
    const current = normalizeApiSettings({
      ...DEFAULT_API_SETTINGS,
      providerId: "openai",
      model: "kept-model",
      apiKeySource: "manual",
      apiKey: "kept-key"
    });

    const next = applyImportedUserPreferences(current, {
      providerId: "custom",
      model: "ignored-model",
      apiKey: "ignored-key",
      userPreferencePrompt: "Imported prompt",
      memoryItems: [{ id: "imported", text: "Imported memory" }]
    });

    assert.equal(next.providerId, current.providerId);
    assert.equal(next.model, current.model);
    assert.equal(next.apiKey, current.apiKey);
    assert.equal(next.userPreferencePrompt, "Imported prompt");
    assert.deepEqual(next.memoryItems, [
      { id: "imported", text: "Imported memory" }
    ]);
  });
});
