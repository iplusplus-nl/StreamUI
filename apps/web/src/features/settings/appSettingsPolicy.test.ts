import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";
import {
  coerceApiSettingsForRuntime,
  resolveRuntimeApiSettings
} from "./appSettingsPolicy";

function runtimeSettings({
  defaults = normalizeApiSettings({
    providerId: "openrouter",
    apiKeySource: "environment",
    model: "server-default"
  }),
  cloudEnabled = false,
  managedProviderEnabled = false
}: {
  defaults?: ApiSettings;
  cloudEnabled?: boolean;
  managedProviderEnabled?: boolean;
} = {}): RuntimeSettingsSummary {
  return {
    api: { defaults, environmentKeys: [] },
    cloud: {
      enabled: cloudEnabled,
      authRequired: cloudEnabled,
      billingEnabled: false,
      managedProviderEnabled,
      brandName: "ChatHTML"
    },
    search: {
      environmentKeys: [],
      defaultProvider: "auto",
      defaultBrowserEngine: "fetch",
      providers: [],
      browserEngines: []
    }
  };
}

function managedSettings(): ApiSettings {
  return normalizeApiSettings({
    providerId: "chathtml-cloud",
    apiKeySource: "managed",
    model: "user-model",
    modelOptions: ["user-option"],
    reasoningEffort: "high",
    uiComplexity: 82,
    userPreferencePrompt: "Keep this preference.",
    memoryItems: [{ id: "memory-1", text: "Keep this memory." }]
  });
}

describe("app settings policy", () => {
  it("uses runtime defaults when no local API settings were saved", () => {
    const defaults = normalizeApiSettings({
      providerId: "openai-compatible",
      apiKeySource: "manual",
      apiKey: "runtime-key",
      model: "runtime-model"
    });
    const current = normalizeApiSettings({ model: "local-default" });

    assert.deepEqual(
      resolveRuntimeApiSettings(
        current,
        runtimeSettings({ defaults }),
        false
      ),
      defaults
    );
  });

  it("falls back from an unavailable managed provider while preserving choices", () => {
    const current = managedSettings();
    const coerced = coerceApiSettingsForRuntime(current, runtimeSettings());

    assert.equal(coerced.providerId, "openrouter");
    assert.equal(coerced.apiKeySource, "environment");
    assert.equal(coerced.model, "user-model");
    assert.equal(coerced.modelOptions.includes("user-option"), true);
    assert.equal(coerced.reasoningEffort, "high");
    assert.equal(coerced.uiComplexity, 82);
    assert.equal(coerced.userPreferencePrompt, "Keep this preference.");
    assert.deepEqual(coerced.memoryItems, [
      { id: "memory-1", text: "Keep this memory." }
    ]);
  });

  it("keeps managed settings when the runtime enables that provider", () => {
    const current = managedSettings();
    assert.deepEqual(
      coerceApiSettingsForRuntime(
        current,
        runtimeSettings({
          cloudEnabled: true,
          managedProviderEnabled: true
        })
      ),
      current
    );
  });

  it("normalizes but otherwise keeps ordinary provider settings", () => {
    const current = normalizeApiSettings({
      providerId: "openrouter",
      apiKeySource: "manual",
      apiKey: "key",
      model: "ordinary-model"
    });
    assert.deepEqual(
      coerceApiSettingsForRuntime(current, runtimeSettings()),
      current
    );
  });

  it("coerces saved settings through the runtime policy", () => {
    const resolved = resolveRuntimeApiSettings(
      managedSettings(),
      runtimeSettings(),
      true
    );
    assert.equal(resolved.providerId, "openrouter");
    assert.equal(resolved.model, "user-model");
  });
});
