import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";
import { chatSession, sourceAssistant } from "./artifactEditControllerTestHarness";
import { resolveArtifactEditRequestSettings } from "./useArtifactEditController";

function runtimeSettings(
  managedProviderEnabled: boolean
): RuntimeSettingsSummary {
  return {
    api: {
      defaults: normalizeApiSettings({
        providerId: "openrouter",
        apiKeySource: "environment",
        model: "runtime-default"
      }),
      environmentKeys: []
    },
    cloud: {
      enabled: managedProviderEnabled,
      authRequired: managedProviderEnabled,
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

describe("artifact edit request settings", () => {
  it("uses the target session model, reasoning, and UI complexity", () => {
    const current = normalizeApiSettings({
      providerId: "openrouter",
      apiKeySource: "manual",
      apiKey: "secret",
      model: "global-model",
      reasoningEffort: "low",
      uiComplexity: 20
    });
    const session = chatSession("session", sourceAssistant(), {
      model: "session-model",
      reasoningEffort: "high",
      uiComplexity: 88
    });

    const result = resolveArtifactEditRequestSettings(
      session,
      current,
      runtimeSettings(false),
      false,
      false
    );
    const serialized = result.apiSettings as Partial<ApiSettings>;

    assert.equal(serialized.model, "session-model");
    assert.equal(serialized.reasoningEffort, "high");
    assert.equal(serialized.uiComplexity, 88);
    assert.equal(serialized.apiKey, "secret");
    assert.equal(result.managed, false);
    assert.equal(result.requiresAuthentication, false);
  });

  it("requires authentication only for an available managed provider", () => {
    const managed = normalizeApiSettings({
      providerId: "chathtml-cloud",
      apiKeySource: "managed",
      model: "managed-model"
    });
    const session = chatSession("session", sourceAssistant());

    const unauthenticated = resolveArtifactEditRequestSettings(
      session,
      managed,
      runtimeSettings(true),
      true,
      false
    );
    assert.equal(unauthenticated.managed, true);
    assert.equal(unauthenticated.requiresAuthentication, true);

    const authenticated = resolveArtifactEditRequestSettings(
      session,
      managed,
      runtimeSettings(true),
      true,
      true
    );
    assert.equal(authenticated.managed, true);
    assert.equal(authenticated.requiresAuthentication, false);

    const unavailable = resolveArtifactEditRequestSettings(
      session,
      managed,
      runtimeSettings(false),
      true,
      false
    );
    assert.equal(unavailable.managed, false);
    assert.equal(unavailable.requiresAuthentication, false);
  });
});
