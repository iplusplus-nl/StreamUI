export type ApiKeySource = "environment" | "manual";

export type RuntimeApiCredentials = {
  providerName: string;
  baseUrl: string;
  apiKeySource: ApiKeySource;
  apiKeyEnvironmentName: string;
  apiKey: string;
};

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
  if (value === "environment" || value === "manual") {
    return value;
  }

  return "environment";
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

export function readRuntimeApiCredentials(input: unknown): RuntimeApiCredentials {
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const providerName =
    typeof object.providerName === "string" && object.providerName.trim()
      ? object.providerName.trim().slice(0, 80)
      : "custom";
  const baseUrl = normalizeBaseUrl(object.baseUrl);
  const apiKeySource = normalizeApiKeySource(object.apiKeySource);
  const apiKeyEnvironmentName = getApiKeyEnvironmentName(
    providerName,
    baseUrl,
    object.providerId
  );
  const apiKey =
    apiKeySource === "environment"
      ? process.env[apiKeyEnvironmentName]?.trim() ?? ""
      : typeof object.apiKey === "string"
        ? object.apiKey.trim()
        : "";

  return {
    providerName,
    baseUrl,
    apiKeySource,
    apiKeyEnvironmentName,
    apiKey
  };
}
