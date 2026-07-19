import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertProviderCredentialEndpointTrusted,
  createProviderAuthorizationHeaders,
  isTrustedEnvironmentCredentialEndpoint
} from "./providerEndpointTrust.js";

const openRouterEnvironment = {
  apiKeySource: "environment" as const,
  apiKeyEnvironmentName: "OPENROUTER_API_KEY"
};

describe("provider endpoint credential trust", () => {
  it("accepts only the canonical OpenRouter and OpenAI resource paths", () => {
    assert.equal(
      isTrustedEnvironmentCredentialEndpoint(
        openRouterEnvironment,
        "https://openrouter.ai/api/v1/responses",
        "responses"
      ),
      true
    );
    assert.equal(
      isTrustedEnvironmentCredentialEndpoint(
        openRouterEnvironment,
        "https://openrouter.ai/api/v1/chat/completions",
        "chat-completions"
      ),
      true
    );
    assert.equal(
      isTrustedEnvironmentCredentialEndpoint(
        openRouterEnvironment,
        "https://openrouter.ai/api/v1/models?limit=100",
        "models"
      ),
      true
    );
    assert.equal(
      isTrustedEnvironmentCredentialEndpoint(
        {
          apiKeySource: "environment",
          apiKeyEnvironmentName: "OPENAI_API_KEY"
        },
        "https://api.openai.com/v1/responses",
        "responses"
      ),
      true
    );
  });

  it("rejects attacker origins, lookalikes, protocol downgrades, and alternate paths", () => {
    const rejected = [
      "https://attacker.invalid/api/v1/responses",
      "https://openrouter.ai.attacker.invalid/api/v1/responses",
      "http://openrouter.ai/api/v1/responses",
      "https://openrouter.ai/api/v1/models",
      "https://openrouter.ai/api/v1/responses/",
      "https://user@openrouter.ai/api/v1/responses",
      "https://openrouter.ai/api/v1/%72esponses"
    ];

    for (const endpoint of rejected) {
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          openRouterEnvironment,
          endpoint,
          "responses"
        ),
        false,
        endpoint
      );
    }
  });

  it("does not grant an unknown environment variable a client-selected endpoint", () => {
    assert.throws(
      () =>
        assertProviderCredentialEndpointTrusted(
          {
            apiKeySource: "environment",
            apiKeyEnvironmentName: "STREAMUI_API_KEY"
          },
          "https://custom.example/v1/responses",
          "responses"
        ),
      /manual API key for custom or local endpoints/
    );
  });

  it("preserves manual BYO credentials for custom and local endpoints", () => {
    assert.deepEqual(
      createProviderAuthorizationHeaders(
        {
          apiKeySource: "manual",
          apiKeyEnvironmentName: "STREAMUI_API_KEY",
          apiKey: "manual-secret"
        },
        "http://127.0.0.1:11434/v1/responses",
        "responses"
      ),
      { Authorization: "Bearer manual-secret" }
    );
  });

  it("trusts only the exact operator-configured OpenRouter endpoints", () => {
    const previousBaseUrl = process.env.OPENROUTER_BASE_URL;
    const previousModelsEndpoint = process.env.OPENROUTER_MODELS_ENDPOINT;
    process.env.OPENROUTER_BASE_URL = "https://operator-proxy.example/v1";
    process.env.OPENROUTER_MODELS_ENDPOINT =
      "https://models-proxy.example/catalog?tenant=one";
    try {
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          openRouterEnvironment,
          "https://operator-proxy.example/v1/responses",
          "responses"
        ),
        true
      );
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          openRouterEnvironment,
          "https://models-proxy.example/catalog?tenant=one",
          "models"
        ),
        true
      );
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          openRouterEnvironment,
          "https://models-proxy.example/catalog?tenant=attacker",
          "models"
        ),
        false
      );
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          openRouterEnvironment,
          "https://openrouter.ai/api/v1/responses",
          "responses"
        ),
        false
      );
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          openRouterEnvironment,
          "https://openrouter.ai/api/v1/models",
          "models"
        ),
        false
      );
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          openRouterEnvironment,
          "https://attacker.invalid/v1/responses",
          "responses"
        ),
        false
      );
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.OPENROUTER_BASE_URL;
      } else {
        process.env.OPENROUTER_BASE_URL = previousBaseUrl;
      }
      if (previousModelsEndpoint === undefined) {
        delete process.env.OPENROUTER_MODELS_ENDPOINT;
      } else {
        process.env.OPENROUTER_MODELS_ENDPOINT = previousModelsEndpoint;
      }
    }
  });

  it("requires an explicit server endpoint before using STREAMUI_API_KEY", () => {
    const previousBaseUrl = process.env.STREAMUI_API_BASE_URL;
    process.env.STREAMUI_API_BASE_URL = "http://127.0.0.1:11434/v1";
    try {
      const credentials = {
        apiKeySource: "environment" as const,
        apiKeyEnvironmentName: "STREAMUI_API_KEY"
      };
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          credentials,
          "http://127.0.0.1:11434/v1/responses",
          "responses"
        ),
        true
      );
      assert.equal(
        isTrustedEnvironmentCredentialEndpoint(
          credentials,
          "http://127.0.0.1:11435/v1/responses",
          "responses"
        ),
        false
      );
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.STREAMUI_API_BASE_URL;
      } else {
        process.env.STREAMUI_API_BASE_URL = previousBaseUrl;
      }
    }
  });
});
