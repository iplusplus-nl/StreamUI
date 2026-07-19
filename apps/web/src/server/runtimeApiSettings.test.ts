import assert from "node:assert/strict";
import test from "node:test";
import {
  getRuntimeApiDefaults,
  getRuntimeSettingsSummary,
  readRuntimeApiCredentials
} from "../../server/runtimeApiSettings.js";

test("runtime defaults include the required model shortlist", () => {
  const defaults = getRuntimeApiDefaults();

  assert.deepEqual(defaults.modelOptions.slice(0, 4), [
    "openai/gpt-5.5",
    "google/gemini-3.1-pro-preview",
    "anthropic/claude-sonnet-5",
    "z-ai/glm-5.2"
  ]);
  assert.equal(defaults.uiComplexity, 50);
  assert.equal(defaults.apiStyle, "responses");
});

test("managed credentials can only be supplied by the authenticated gateway", () => {
  assert.throws(
    () =>
      readRuntimeApiCredentials({
        providerId: "chathtml-cloud",
        apiKeySource: "managed",
        apiKey: "",
        baseUrl: "",
        providerName: "ChatHTML Cloud"
      }),
    /authenticated server gateway/
  );
});

test("published cloud defaults do not expose the service endpoint", () => {
  const previousAuthRequired = process.env.CHATHTML_AUTH_REQUIRED;
  process.env.CHATHTML_AUTH_REQUIRED = "true";
  const summary = getRuntimeSettingsSummary();

  try {
    assert.equal(summary.cloud?.enabled, true);
    assert.equal(summary.cloud?.authRequired, true);
    assert.equal(summary.cloud?.managedProviderEnabled, true);
    assert.equal(summary.api.defaults.providerId, "chathtml-cloud");
    assert.equal(summary.api.defaults.apiKeySource, "managed");
    assert.equal(summary.api.defaults.baseUrl, "");
    assert.equal(summary.api.defaults.modelsEndpoint, "");
  } finally {
    if (previousAuthRequired === undefined) {
      delete process.env.CHATHTML_AUTH_REQUIRED;
    } else {
      process.env.CHATHTML_AUTH_REQUIRED = previousAuthRequired;
    }
  }
});

test("environment credentials cannot be resolved for a client-selected origin", () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "server-secret-must-not-leak";

  try {
    assert.throws(
      () =>
        readRuntimeApiCredentials({
          providerId: "openrouter",
          providerName: "OpenRouter",
          baseUrl: "https://attacker.invalid/collect",
          apiKeySource: "environment"
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /only be sent to https:\/\/openrouter\.ai/);
        assert.doesNotMatch(error.message, /server-secret-must-not-leak/);
        return true;
      }
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousKey;
    }
  }
});

test("manual credentials retain custom and local endpoint support", () => {
  const credentials = readRuntimeApiCredentials({
    providerId: "local",
    providerName: "Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeySource: "manual",
    apiKey: "local-key"
  });

  assert.equal(credentials.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(credentials.apiKeySource, "manual");
  assert.equal(credentials.apiKey, "local-key");
});

test("Chat Completions style resolves credentials for its own endpoint", () => {
  const credentials = readRuntimeApiCredentials({
    providerId: "local",
    providerName: "Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiStyle: "chat-completions",
    apiKeySource: "manual",
    apiKey: "local-key"
  });

  assert.equal(credentials.apiKey, "local-key");
});

test("operator-configured OpenRouter defaults can use the environment key", () => {
  const previousBaseUrl = process.env.OPENROUTER_BASE_URL;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_BASE_URL = "https://operator-proxy.example/v1";
  process.env.OPENROUTER_API_KEY = "operator-key";

  try {
    const defaults = getRuntimeApiDefaults();
    const credentials = readRuntimeApiCredentials({});

    assert.equal(defaults.baseUrl, "https://operator-proxy.example/v1");
    assert.equal(
      defaults.modelsEndpoint,
      "https://operator-proxy.example/v1/models"
    );
    assert.equal(credentials.baseUrl, "https://operator-proxy.example/v1");
    assert.equal(credentials.apiKey, "operator-key");
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.OPENROUTER_BASE_URL;
    } else {
      process.env.OPENROUTER_BASE_URL = previousBaseUrl;
    }
    if (previousKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousKey;
    }
  }
});
