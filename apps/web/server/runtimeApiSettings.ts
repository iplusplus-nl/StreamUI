import type { Request, Response } from "express";
import { isAuthenticationRequired } from "./chatHtmlService.js";
import { createRequire } from "node:module";
import {
  assertProviderCredentialEndpointTrusted,
  type ProviderEndpointKind
} from "./providerEndpointTrust.js";

export type ApiKeySource = "environment" | "manual" | "managed";

export type ApiStyle = "responses" | "chat-completions";

export type RuntimeReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type RuntimeApiCredentials = {
  providerName: string;
  baseUrl: string;
  apiKeySource: ApiKeySource;
  apiKeyEnvironmentName: string;
  apiKey: string;
};

export type RuntimeApiCredentialDescriptor = Omit<
  RuntimeApiCredentials,
  "apiKey"
> & {
  manualApiKey: string;
};

export type RuntimeApiCredentialTarget = {
  endpoint: string;
  kind: ProviderEndpointKind;
};

export type RuntimeMemoryItem = {
  id: string;
  text: string;
};

export type RuntimeApiDefaults = {
  providerId: "openrouter" | "chathtml-cloud";
  providerName: "OpenRouter" | "ChatHTML Cloud";
  baseUrl: string;
  apiStyle: ApiStyle;
  apiKeySource: "environment" | "managed";
  apiKey: "";
  model: string;
  modelOptions: string[];
  modelsEndpoint: string;
  reasoningEffort: RuntimeReasoningEffort;
  uiComplexity: number;
  userPreferencePrompt: "";
  memoryItems: RuntimeMemoryItem[];
};

export type EnvironmentKeyStatus = {
  name: string;
  configured: boolean;
};

export type RuntimeSearchProviderStatus = {
  provider: "brave" | "tavily" | "serper" | "duckduckgo";
  label: string;
  requiresApiKey: boolean;
  environmentKeyName?: string;
  configured: boolean;
  fallback: boolean;
};

export type RuntimeSearchBrowserStatus = {
  engine: "fetch" | "playwright";
  label: string;
  available: boolean;
  activeByDefault: boolean;
  detail: string;
};

export type RuntimeSettingsSummary = {
  api: {
    defaults: RuntimeApiDefaults;
    environmentKeys: EnvironmentKeyStatus[];
  };
  cloud?: {
    enabled: boolean;
    authRequired: boolean;
    billingEnabled: boolean;
    managedProviderEnabled: boolean;
    brandName: string;
  };
  search: {
    environmentKeys: EnvironmentKeyStatus[];
    defaultProvider: "auto" | "brave" | "tavily" | "serper" | "duckduckgo" | "none";
    defaultBrowserEngine: "fetch" | "playwright";
    providers: RuntimeSearchProviderStatus[];
    browserEngines: RuntimeSearchBrowserStatus[];
  };
};

const require = createRequire(import.meta.url);

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-pro-preview";
const DEFAULT_OPENROUTER_REASONING: RuntimeReasoningEffort = "low";
const DEFAULT_UI_COMPLEXITY = 50;
const REQUIRED_OPENROUTER_MODEL_OPTIONS = [
  "openai/gpt-5.5",
  "google/gemini-3.1-pro-preview",
  "anthropic/claude-sonnet-5",
  "z-ai/glm-5.2"
] as const;

const API_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "STREAMUI_API_KEY"
];

const SEARCH_ENV_KEYS = [
  "BRAVE_SEARCH_API_KEY",
  "TAVILY_API_KEY",
  "SERPER_API_KEY"
];

const SEARCH_PROVIDER_LABELS: Array<{
  provider: RuntimeSearchProviderStatus["provider"];
  label: string;
  environmentKeyName?: string;
  requiresApiKey: boolean;
  fallback: boolean;
}> = [
  {
    provider: "brave",
    label: "Brave",
    environmentKeyName: "BRAVE_SEARCH_API_KEY",
    requiresApiKey: true,
    fallback: false
  },
  {
    provider: "tavily",
    label: "Tavily",
    environmentKeyName: "TAVILY_API_KEY",
    requiresApiKey: true,
    fallback: false
  },
  {
    provider: "serper",
    label: "Serper",
    environmentKeyName: "SERPER_API_KEY",
    requiresApiKey: true,
    fallback: false
  },
  {
    provider: "duckduckgo",
    label: "DuckDuckGo",
    requiresApiKey: false,
    fallback: true
  }
];

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function envString(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function hasEnvValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function environmentKeyStatus(names: string[]): EnvironmentKeyStatus[] {
  return names.map((name) => ({
    name,
    configured: hasEnvValue(name)
  }));
}

function normalizeSearchProvider(
  value: unknown
): RuntimeSettingsSummary["search"]["defaultProvider"] {
  if (
    value === "auto" ||
    value === "brave" ||
    value === "tavily" ||
    value === "serper" ||
    value === "duckduckgo" ||
    value === "none"
  ) {
    return value;
  }

  return "auto";
}

function normalizeBrowserEngine(
  value: unknown
): RuntimeSettingsSummary["search"]["defaultBrowserEngine"] {
  return value === "playwright" ? "playwright" : "fetch";
}

function packageAvailable(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function searchProviderStatus(): RuntimeSearchProviderStatus[] {
  return SEARCH_PROVIDER_LABELS.map((provider) => {
    const configured = provider.environmentKeyName
      ? hasEnvValue(provider.environmentKeyName)
      : true;

    return {
      provider: provider.provider,
      label: provider.label,
      requiresApiKey: provider.requiresApiKey,
      ...(provider.environmentKeyName
        ? { environmentKeyName: provider.environmentKeyName }
        : {}),
      configured,
      fallback: provider.fallback
    };
  });
}

function browserEngineStatus(
  defaultBrowserEngine: RuntimeSettingsSummary["search"]["defaultBrowserEngine"]
): RuntimeSearchBrowserStatus[] {
  const playwrightAvailable = packageAvailable("playwright");

  return [
    {
      engine: "fetch",
      label: "Fetch",
      available: true,
      activeByDefault: defaultBrowserEngine === "fetch",
      detail: "Node fetch is always available for static pages."
    },
    {
      engine: "playwright",
      label: "Playwright",
      available: playwrightAvailable,
      activeByDefault: defaultBrowserEngine === "playwright",
      detail: playwrightAvailable
        ? "Playwright is installed for headless browser page fetching."
        : "Playwright is not installed; choose Fetch or install the package before using headless browser fetching."
    }
  ];
}

function getDefaultModelsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized ? `${normalized}/models` : "";
}

function getDefaultModelOptions(model: string): string[] {
  const seen = new Set<string>();
  const options: string[] = [];

  for (const candidate of [...REQUIRED_OPENROUTER_MODEL_OPTIONS, model]) {
    const normalized = candidate.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    options.push(normalized);
  }

  return options;
}

export function normalizeRuntimeReasoningEffort(
  value: unknown,
  fallback: RuntimeReasoningEffort = DEFAULT_OPENROUTER_REASONING
): RuntimeReasoningEffort {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }

  return fallback;
}

export function getRuntimeApiDefaults(): RuntimeApiDefaults {
  const baseUrl =
    envString("OPENROUTER_BASE_URL", "OPENROUTER_API_BASE_URL") ||
    DEFAULT_OPENROUTER_BASE_URL;
  const model = envString("OPENROUTER_MODEL") || DEFAULT_OPENROUTER_MODEL;

  return {
    providerId: "openrouter",
    providerName: "OpenRouter",
    baseUrl,
    apiStyle: normalizeApiStyle(envString("OPENROUTER_API_STYLE")),
    apiKeySource: "environment",
    apiKey: "",
    model,
    modelOptions: getDefaultModelOptions(model),
    modelsEndpoint:
      envString("OPENROUTER_MODELS_ENDPOINT") || getDefaultModelsEndpoint(baseUrl),
    reasoningEffort: normalizeRuntimeReasoningEffort(
      envString("OPENROUTER_REASONING_EFFORT")
    ),
    uiComplexity: DEFAULT_UI_COMPLEXITY,
    userPreferencePrompt: "",
    memoryItems: []
  };
}

function getPublishedRuntimeApiDefaults(): RuntimeApiDefaults {
  const model = envString("OPENROUTER_MODEL") || DEFAULT_OPENROUTER_MODEL;
  return {
    providerId: "chathtml-cloud",
    providerName: "ChatHTML Cloud",
    baseUrl: "",
    apiStyle: "responses",
    apiKeySource: "managed",
    apiKey: "",
    model,
    modelOptions: getDefaultModelOptions(model),
    modelsEndpoint: "",
    reasoningEffort: normalizeRuntimeReasoningEffort(
      envString("OPENROUTER_REASONING_EFFORT")
    ),
    uiComplexity: DEFAULT_UI_COMPLEXITY,
    userPreferencePrompt: "",
    memoryItems: []
  };
}

export function getRuntimeSettingsSummary(): RuntimeSettingsSummary {
  const defaultBrowserEngine = normalizeBrowserEngine(
    envString("STREAMUI_BROWSER_ENGINE")
  );

  return {
    api: {
      defaults: getPublishedRuntimeApiDefaults(),
      environmentKeys: environmentKeyStatus(API_ENV_KEYS)
    },
    cloud: {
      enabled: true,
      authRequired: isAuthenticationRequired(),
      billingEnabled: false,
      managedProviderEnabled: true,
      brandName: "ChatHTML Cloud"
    },
    search: {
      environmentKeys: environmentKeyStatus(SEARCH_ENV_KEYS),
      defaultProvider: normalizeSearchProvider(
        envString("STREAMUI_SEARCH_PROVIDER")
      ),
      defaultBrowserEngine,
      providers: searchProviderStatus(),
      browserEngines: browserEngineStatus(defaultBrowserEngine)
    }
  };
}

export function handleGetRuntimeSettings(_req: Request, res: Response): void {
  res.json(getRuntimeSettingsSummary());
}

export function normalizeBaseUrl(value: unknown): string {
  const input = typeof value === "string" ? value.trim() : "";

  if (!input) {
    return "";
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("API settings invalid: Base URL must be a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API settings invalid: Base URL must use http or https.");
  }

  return input.replace(/\/+$/, "");
}

export function normalizeApiKeySource(value: unknown): ApiKeySource {
  if (value === "environment" || value === "manual" || value === "managed") {
    return value;
  }

  return "environment";
}

export function normalizeApiStyle(value: unknown): ApiStyle {
  return value === "chat-completions" ? "chat-completions" : "responses";
}

export function getProviderApiEndpoint(
  baseUrl: string,
  apiStyle: ApiStyle
): RuntimeApiCredentialTarget {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  return apiStyle === "chat-completions"
    ? {
        endpoint: `${normalizedBaseUrl}/chat/completions`,
        kind: "chat-completions"
      }
    : { endpoint: `${normalizedBaseUrl}/responses`, kind: "responses" };
}

export function getApiKeyEnvironmentName(
  providerName: string,
  baseUrl: string,
  providerId: unknown
): string {
  const normalizedProviderId =
    typeof providerId === "string" ? providerId.toLowerCase() : "";
  const normalizedProviderName = providerName.toLowerCase();
  const normalizedBaseUrl = baseUrl.toLowerCase();

  if (
    normalizedProviderId === "chathtml-cloud" ||
    normalizedProviderName.includes("chathtml cloud")
  ) {
    return "CHATHTML_CLOUD_API_KEY";
  }
  if (
    normalizedProviderId === "openrouter" ||
    normalizedProviderName.includes("openrouter") ||
    normalizedBaseUrl.includes("openrouter.ai")
  ) {
    return "OPENROUTER_API_KEY";
  }
  if (
    normalizedProviderId === "openai" ||
    normalizedProviderName.includes("openai") ||
    normalizedBaseUrl.includes("api.openai.com")
  ) {
    return "OPENAI_API_KEY";
  }

  return "STREAMUI_API_KEY";
}

export function readRuntimeApiCredentialDescriptor(
  input: unknown
): RuntimeApiCredentialDescriptor {
  const defaults = getRuntimeApiDefaults();
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const requestedProviderId = hasOwn(object, "providerId")
    ? object.providerId
    : defaults.providerId;
  const apiKeySource = normalizeApiKeySource(object.apiKeySource);
  const isManagedProvider =
    requestedProviderId === "chathtml-cloud" || apiKeySource === "managed";
  if (isManagedProvider) {
    throw new Error(
      "Managed ChatHTML Service credentials must be supplied by the authenticated server gateway."
    );
  }
  const providerName =
    typeof object.providerName === "string" && object.providerName.trim()
      ? object.providerName.trim().slice(0, 80)
      : defaults.providerName;
  const baseUrl = normalizeBaseUrl(object.baseUrl);
  const effectiveBaseUrl =
    baseUrl || (hasOwn(object, "baseUrl") ? "" : defaults.baseUrl);
  const effectiveApiKeySource: ApiKeySource = apiKeySource;
  const apiKeyEnvironmentName = getApiKeyEnvironmentName(
    providerName,
    effectiveBaseUrl,
    requestedProviderId
  );

  return {
    providerName,
    baseUrl: effectiveBaseUrl,
    apiKeySource: effectiveApiKeySource,
    apiKeyEnvironmentName,
    manualApiKey:
      effectiveApiKeySource === "manual" && typeof object.apiKey === "string"
        ? object.apiKey.trim()
        : ""
  };
}

export function resolveRuntimeApiCredentials(
  descriptor: RuntimeApiCredentialDescriptor,
  target: RuntimeApiCredentialTarget
): RuntimeApiCredentials {
  const credentials = {
    providerName: descriptor.providerName,
    baseUrl: descriptor.baseUrl,
    apiKeySource: descriptor.apiKeySource,
    apiKeyEnvironmentName: descriptor.apiKeyEnvironmentName
  };
  if (descriptor.apiKeySource === "manual") {
    return {
      ...credentials,
      apiKey: descriptor.manualApiKey
    };
  }

  assertProviderCredentialEndpointTrusted(
    descriptor,
    target.endpoint,
    target.kind
  );
  return {
    ...credentials,
    apiKey: process.env[descriptor.apiKeyEnvironmentName]?.trim() ?? ""
  };
}

export function readRuntimeApiCredentials(input: unknown): RuntimeApiCredentials {
  const descriptor = readRuntimeApiCredentialDescriptor(input);
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  return resolveRuntimeApiCredentials(
    descriptor,
    getProviderApiEndpoint(
      descriptor.baseUrl,
      normalizeApiStyle(object.apiStyle)
    )
  );
}
