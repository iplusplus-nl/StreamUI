import type { ApiSettings } from "./apiSettings";

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
    defaults: ApiSettings;
    environmentKeys: EnvironmentKeyStatus[];
  };
  search: {
    environmentKeys: EnvironmentKeyStatus[];
    defaultProvider: "auto" | "brave" | "tavily" | "serper" | "duckduckgo" | "none";
    defaultBrowserEngine: "fetch" | "playwright";
    providers: RuntimeSearchProviderStatus[];
    browserEngines: RuntimeSearchBrowserStatus[];
  };
};

export function getEnvironmentKeyStatus(
  keys: EnvironmentKeyStatus[] | undefined,
  name: string
): EnvironmentKeyStatus | null {
  return keys?.find((key) => key.name === name) ?? null;
}

export async function loadRuntimeSettings(): Promise<RuntimeSettingsSummary> {
  const response = await fetch("/api/settings");

  if (!response.ok) {
    throw new Error(`Settings load failed with HTTP ${response.status}.`);
  }

  return response.json() as Promise<RuntimeSettingsSummary>;
}
