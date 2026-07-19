import type { ApiKeySource } from "./runtimeApiSettings.js";

export type ProviderEndpointKind =
  | "models"
  | "responses"
  | "chat-completions";

export type ProviderCredentialIdentity = {
  apiKeySource: ApiKeySource;
  apiKeyEnvironmentName: string;
};

type TrustedProviderEndpointPolicy = {
  label: string;
  origin: string;
  paths: Record<ProviderEndpointKind, string>;
};

type ConfiguredProviderEndpointPolicy = {
  baseEnvironmentNames: readonly string[];
  modelsEnvironmentNames: readonly string[];
  chatCompletionsEnvironmentNames: readonly string[];
};

const TRUSTED_ENVIRONMENT_ENDPOINTS: Readonly<
  Record<string, TrustedProviderEndpointPolicy>
> = Object.freeze({
  OPENROUTER_API_KEY: {
    label: "OpenRouter",
    origin: "https://openrouter.ai",
    paths: {
      models: "/api/v1/models",
      responses: "/api/v1/responses",
      "chat-completions": "/api/v1/chat/completions"
    }
  },
  OPENAI_API_KEY: {
    label: "OpenAI",
    origin: "https://api.openai.com",
    paths: {
      models: "/v1/models",
      responses: "/v1/responses",
      "chat-completions": "/v1/chat/completions"
    }
  }
});

const CONFIGURED_ENVIRONMENT_ENDPOINTS: Readonly<
  Record<string, ConfiguredProviderEndpointPolicy>
> = Object.freeze({
  OPENROUTER_API_KEY: {
    baseEnvironmentNames: ["OPENROUTER_BASE_URL", "OPENROUTER_API_BASE_URL"],
    modelsEnvironmentNames: ["OPENROUTER_MODELS_ENDPOINT"],
    chatCompletionsEnvironmentNames: [
      "OPENROUTER_CHAT_COMPLETIONS_ENDPOINT"
    ]
  },
  OPENAI_API_KEY: {
    baseEnvironmentNames: ["OPENAI_BASE_URL", "OPENAI_API_BASE_URL"],
    modelsEnvironmentNames: ["OPENAI_MODELS_ENDPOINT"],
    chatCompletionsEnvironmentNames: ["OPENAI_CHAT_COMPLETIONS_ENDPOINT"]
  },
  STREAMUI_API_KEY: {
    baseEnvironmentNames: ["STREAMUI_API_BASE_URL", "STREAMUI_BASE_URL"],
    modelsEnvironmentNames: ["STREAMUI_MODELS_ENDPOINT"],
    chatCompletionsEnvironmentNames: [
      "STREAMUI_CHAT_COMPLETIONS_ENDPOINT"
    ]
  }
});

function parseHttpEndpoint(endpoint: string): URL | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    return null;
  }

  return url;
}

function firstConfiguredEnvironmentValue(names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function appendProviderResource(baseUrl: string, resource: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${resource}`;
}

function endpointResource(kind: ProviderEndpointKind): string {
  return kind === "chat-completions" ? "chat/completions" : kind;
}

function configuredTrustedEndpoint(
  apiKeyEnvironmentName: string,
  kind: ProviderEndpointKind
): string | undefined {
  const policy = CONFIGURED_ENVIRONMENT_ENDPOINTS[apiKeyEnvironmentName];
  if (!policy) {
    return undefined;
  }

  if (kind === "models") {
    const modelsEndpoint = firstConfiguredEnvironmentValue(
      policy.modelsEnvironmentNames
    );
    if (modelsEndpoint) {
      return modelsEndpoint;
    }
  }
  if (kind === "chat-completions") {
    const chatCompletionsEndpoint = firstConfiguredEnvironmentValue(
      policy.chatCompletionsEnvironmentNames
    );
    if (chatCompletionsEndpoint) {
      return chatCompletionsEndpoint;
    }
  }

  const baseUrl = firstConfiguredEnvironmentValue(policy.baseEnvironmentNames);
  return baseUrl
    ? appendProviderResource(baseUrl, endpointResource(kind))
    : undefined;
}

function endpointsMatch(
  actualValue: string,
  expectedValue: string,
  allowAdditionalQuery: boolean
): boolean {
  const actual = parseHttpEndpoint(actualValue);
  const expected = parseHttpEndpoint(expectedValue);
  if (!actual || !expected) {
    return false;
  }

  return (
    actual.origin === expected.origin &&
    actual.pathname === expected.pathname &&
    (allowAdditionalQuery || actual.search === expected.search)
  );
}

export function isTrustedEnvironmentCredentialEndpoint(
  credentials: ProviderCredentialIdentity,
  endpoint: string,
  kind: ProviderEndpointKind
): boolean {
  if (credentials.apiKeySource === "manual") {
    return true;
  }

  const configuredEndpoint = configuredTrustedEndpoint(
    credentials.apiKeyEnvironmentName,
    kind
  );
  const policy =
    TRUSTED_ENVIRONMENT_ENDPOINTS[credentials.apiKeyEnvironmentName];
  const canonicalEndpoint = policy
    ? `${policy.origin}${policy.paths[kind]}`
    : undefined;
  if (
    configuredEndpoint &&
    (!canonicalEndpoint ||
      !endpointsMatch(configuredEndpoint, canonicalEndpoint, false))
  ) {
    return endpointsMatch(endpoint, configuredEndpoint, false);
  }

  return Boolean(
    canonicalEndpoint && endpointsMatch(endpoint, canonicalEndpoint, true)
  );
}

export function assertProviderCredentialEndpointTrusted(
  credentials: ProviderCredentialIdentity,
  endpoint: string,
  kind: ProviderEndpointKind
): void {
  if (isTrustedEnvironmentCredentialEndpoint(credentials, endpoint, kind)) {
    return;
  }

  const policy =
    TRUSTED_ENVIRONMENT_ENDPOINTS[credentials.apiKeyEnvironmentName];
  const configuredEndpoint = configuredTrustedEndpoint(
    credentials.apiKeyEnvironmentName,
    kind
  );
  const expected = configuredEndpoint
    ? configuredEndpoint
    : policy
      ? `${policy.origin}${policy.paths[kind]}`
      : "a server-approved provider endpoint";
  const label = policy?.label ?? "server-managed";
  throw new Error(
    `API settings invalid: ${label} environment credentials may only be sent to ${expected}. Use a manual API key for custom or local endpoints.`
  );
}

export function createProviderAuthorizationHeaders(
  credentials: ProviderCredentialIdentity & { apiKey: string },
  endpoint: string,
  kind: ProviderEndpointKind
): { Authorization: string } {
  assertProviderCredentialEndpointTrusted(credentials, endpoint, kind);
  return {
    Authorization: `Bearer ${credentials.apiKey}`
  };
}
