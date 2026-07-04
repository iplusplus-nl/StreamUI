import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Download,
  Eraser,
  KeyRound,
  Menu,
  MoreHorizontal,
  Moon,
  PanelLeftOpen,
  Search,
  Settings2,
  SquarePen,
  Sun,
  Trash2,
  Upload,
  UserRound,
  X
} from "lucide-react";
import {
  API_KEY_SOURCE_OPTIONS,
  API_PROVIDER_PRESETS,
  DEFAULT_USER_PREFERENCES,
  MAX_USER_PREFERENCE_FIELD_LENGTH,
  REASONING_EFFORT_OPTIONS,
  getDefaultModelsEndpoint,
  getProviderPreset,
  getApiKeyEnvironmentName,
  getSelectableModelOptions,
  hasCompleteApiSettings,
  normalizeApiSettings,
  normalizeUserPreferences,
  type ApiKeySource,
  type ApiProviderId,
  type ApiSettings,
  type ReasoningEffort,
  type UserPreferences
} from "../core/apiSettings";
import {
  SEARCH_BROWSER_ENGINE_OPTIONS,
  SEARCH_PROVIDER_OPTIONS,
  getSearchProviderApiKeyEnvironmentName,
  normalizeSearchSettings,
  searchProviderNeedsApiKey,
  type SearchBrowserEngine,
  type SearchProvider,
  type SearchSettings
} from "../core/searchSettings";
import {
  getEnvironmentKeyStatus,
  type EnvironmentKeyStatus,
  type RuntimeSearchBrowserStatus,
  type RuntimeSearchProviderStatus,
  type RuntimeSettingsSummary
} from "../core/runtimeSettings";
import { fetchModelCatalog } from "../features/settings/modelCatalog";
import { ModelImportDialog } from "./ModelImportDialog";

export type ThemeMode = "day" | "night";

export type SessionListItem = {
  id: string;
  title: string;
};

type SettingsSection = "api" | "preferences" | "search";
type UserPreferenceKey = keyof UserPreferences;

const COMPACT_SIDEBAR_QUERY = "(max-width: 720px), (orientation: portrait)";
const USER_PREFERENCE_FIELDS: Array<{
  key: UserPreferenceKey;
  label: string;
  rows: number;
  placeholder: string;
}> = [
  {
    key: "responseTone",
    label: "Response Tone",
    rows: 3,
    placeholder: "Warm, concise, Chinese by default..."
  },
  {
    key: "interfaceStyle",
    label: "Interface Style",
    rows: 3,
    placeholder: "Dense controls, restrained cards, compact dashboards..."
  },
  {
    key: "defaultTechnicalPreferences",
    label: "Technical Defaults",
    rows: 3,
    placeholder: "TypeScript, minimal dependencies, test risky changes..."
  },
  {
    key: "longTermMemory",
    label: "Long-Term Memory",
    rows: 4,
    placeholder: "Stable facts and working preferences to remember..."
  }
];

function getInitialSidebarCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia(COMPACT_SIDEBAR_QUERY).matches;
}

type SessionSidebarProps = {
  sessions: SessionListItem[];
  activeSessionId: string;
  isSending: boolean;
  themeMode: ThemeMode;
  apiSettings: ApiSettings;
  searchSettings: SearchSettings;
  runtimeSettings: RuntimeSettingsSummary | null;
  onNewSession(): void;
  onSelectSession(id: string): void;
  onDeleteSession(id: string): void;
  onThemeModeChange(mode: ThemeMode): void;
  onApiSettingsChange(settings: ApiSettings): void;
  onSearchSettingsChange(settings: SearchSettings): void;
};

function getSearchEnvironmentKeyNames(provider: SearchProvider): string[] {
  if (provider === "auto") {
    return ["BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY"];
  }
  if (provider === "brave") {
    return ["BRAVE_SEARCH_API_KEY"];
  }
  if (provider === "tavily") {
    return ["TAVILY_API_KEY"];
  }
  if (provider === "serper") {
    return ["SERPER_API_KEY"];
  }

  return [];
}

function formatEnvironmentStatus(
  name: string,
  status: EnvironmentKeyStatus | null
): string {
  if (!status) {
    return `${name}: checking`;
  }

  return `${name}: ${status.configured ? "set" : "missing"}`;
}

function getEnvironmentStatusClass(status: EnvironmentKeyStatus | null): string {
  if (!status) {
    return "is-pending";
  }

  return status.configured ? "is-configured" : "is-missing";
}

function getSearchProviderCapability(
  runtimeSettings: RuntimeSettingsSummary | null,
  provider: SearchProvider
): RuntimeSearchProviderStatus | null {
  if (provider === "auto" || provider === "none") {
    return null;
  }

  return (
    runtimeSettings?.search.providers.find((status) => status.provider === provider) ??
    null
  );
}

function getSearchBrowserCapability(
  runtimeSettings: RuntimeSettingsSummary | null,
  engine: SearchBrowserEngine
): RuntimeSearchBrowserStatus | null {
  return (
    runtimeSettings?.search.browserEngines.find(
      (status) => status.engine === engine
    ) ?? null
  );
}

function formatSearchProviderCapability(
  provider: RuntimeSearchProviderStatus
): string {
  if (!provider.requiresApiKey) {
    return `${provider.label}: no key required`;
  }

  return `${provider.label}: ${
    provider.configured ? "env key set" : "env key missing"
  }`;
}

function getSearchCapabilityClass(configured: boolean): string {
  return configured ? "is-configured" : "is-missing";
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  isSending,
  themeMode,
  apiSettings,
  searchSettings,
  runtimeSettings,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onThemeModeChange,
  onApiSettingsChange,
  onSearchSettingsChange
}: SessionSidebarProps) {
  const [isCompactSidebar, setIsCompactSidebar] = useState(
    getInitialSidebarCollapsed
  );
  const [isCollapsed, setIsCollapsed] = useState(getInitialSidebarCollapsed);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("api");
  const [draftApiSettings, setDraftApiSettings] =
    useState<ApiSettings>(apiSettings);
  const [draftSearchSettings, setDraftSearchSettings] =
    useState<SearchSettings>(searchSettings);
  const [isModelImportOpen, setIsModelImportOpen] = useState(false);
  const [isModelImportLoading, setIsModelImportLoading] = useState(false);
  const [modelImportError, setModelImportError] = useState<string | null>(null);
  const [modelImportQuery, setModelImportQuery] = useState("");
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [selectedFetchedModels, setSelectedFetchedModels] = useState<string[]>([]);
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const [preferenceImportError, setPreferenceImportError] = useState<string | null>(
    null
  );
  const preferenceFileInputRef = useRef<HTMLInputElement | null>(null);
  const activeApiKeyStatus = getEnvironmentKeyStatus(
    runtimeSettings?.api.environmentKeys,
    getApiKeyEnvironmentName(apiSettings)
  );
  const draftApiKeyStatus = getEnvironmentKeyStatus(
    runtimeSettings?.api.environmentKeys,
    getApiKeyEnvironmentName(draftApiSettings)
  );
  const apiSettingsComplete =
    hasCompleteApiSettings(apiSettings) &&
    (apiSettings.apiKeySource !== "environment" ||
      activeApiKeyStatus?.configured !== false);
  const searchAllowsManualKey = searchProviderNeedsApiKey(
    draftSearchSettings.provider
  );
  const searchUsesEnvironmentKeys =
    draftSearchSettings.provider === "auto" || searchAllowsManualKey;
  const searchKeyStatuses = getSearchEnvironmentKeyNames(
    draftSearchSettings.provider
  ).map((name) => ({
    name,
    status: getEnvironmentKeyStatus(runtimeSettings?.search.environmentKeys, name)
  }));
  const selectedSearchProviderCapability = getSearchProviderCapability(
    runtimeSettings,
    draftSearchSettings.provider
  );
  const selectedBrowserCapability = getSearchBrowserCapability(
    runtimeSettings,
    draftSearchSettings.browserEngine
  );
  const draftSelectableModels = getSelectableModelOptions(draftApiSettings);

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_SIDEBAR_QUERY);
    const updateCompactSidebarState = () => {
      setIsCompactSidebar(mediaQuery.matches);
      if (mediaQuery.matches) {
        setIsCollapsed(true);
      }
    };

    updateCompactSidebarState();
    mediaQuery.addEventListener("change", updateCompactSidebarState);

    return () => {
      mediaQuery.removeEventListener("change", updateCompactSidebarState);
    };
  }, []);

  useEffect(() => {
    if (isSettingsOpen) {
      setDraftApiSettings(apiSettings);
      setDraftSearchSettings(searchSettings);
      setPreferenceImportError(null);
    }
  }, [apiSettings, isSettingsOpen, searchSettings]);

  useEffect(() => {
    if (isSending) {
      setOpenSessionMenuId(null);
    }
  }, [isSending]);

  const updateApiDraft = (patch: Partial<ApiSettings>) => {
    setDraftApiSettings((current) =>
      normalizeApiSettings({ ...current, ...patch })
    );
  };

  const updateSearchDraft = (patch: Partial<SearchSettings>) => {
    setDraftSearchSettings((current) =>
      normalizeSearchSettings({ ...current, ...patch })
    );
  };

  const updateUserPreferenceDraft = (
    key: UserPreferenceKey,
    value: string
  ) => {
    setDraftApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        userPreferences: {
          ...current.userPreferences,
          [key]: value
        }
      })
    );
  };

  const updateApiBaseUrl = (baseUrl: string) => {
    setDraftApiSettings((current) => {
      const currentDefaultEndpoint = getDefaultModelsEndpoint(current.baseUrl);
      const shouldFollowBaseUrl =
        !current.modelsEndpoint ||
        current.modelsEndpoint === currentDefaultEndpoint;

      return normalizeApiSettings({
        ...current,
        baseUrl,
        modelsEndpoint: shouldFollowBaseUrl
          ? getDefaultModelsEndpoint(baseUrl)
          : current.modelsEndpoint
      });
    });
  };

  const handleProviderChange = (providerId: ApiProviderId) => {
    const preset = getProviderPreset(providerId);
    setDraftApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        providerId: preset.id,
        providerName: preset.label,
        baseUrl: preset.baseUrl,
        model: preset.model,
        modelOptions: [preset.model],
        modelsEndpoint: getDefaultModelsEndpoint(preset.baseUrl),
        reasoningEffort: preset.reasoningEffort
      })
    );
  };

  const handleFetchModels = async () => {
    setIsModelImportOpen(true);
    setIsModelImportLoading(true);
    setModelImportError(null);
    setModelImportQuery("");
    setSelectedFetchedModels([]);

    try {
      setFetchedModels(await fetchModelCatalog(draftApiSettings));
    } catch (error) {
      setFetchedModels([]);
      setModelImportError(
        error instanceof Error ? error.message : "Unable to fetch model list."
      );
    } finally {
      setIsModelImportLoading(false);
    }
  };

  const toggleFetchedModel = (modelId: string) => {
    setSelectedFetchedModels((current) => {
      const normalizedModelId = modelId.toLowerCase();
      const exists = current.some(
        (selectedModel) => selectedModel.toLowerCase() === normalizedModelId
      );

      return exists
        ? current.filter(
            (selectedModel) => selectedModel.toLowerCase() !== normalizedModelId
          )
        : [...current, modelId];
    });
  };

  const handleAddFetchedModels = () => {
    if (!selectedFetchedModels.length) {
      return;
    }

    setDraftApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        model: current.model || selectedFetchedModels[0],
        modelOptions: [...current.modelOptions, ...selectedFetchedModels]
      })
    );
    setIsModelImportOpen(false);
  };

  const handleRemoveModelOption = (modelId: string) => {
    setDraftApiSettings((current) => {
      const modelOptions = current.modelOptions.filter(
        (modelOption) => modelOption !== modelId
      );
      const model = current.model === modelId ? (modelOptions[0] ?? "") : current.model;

      return normalizeApiSettings({
        ...current,
        model,
        modelOptions
      });
    });
  };

  const handleExportPreferences = () => {
    const blob = new Blob(
      [JSON.stringify(draftApiSettings.userPreferences, null, 2)],
      { type: "application/json;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "streamui-preferences.json";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const handleImportPreferences = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const object =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      const source =
        typeof object.userPreferences === "object" && object.userPreferences !== null
          ? object.userPreferences
          : parsed;
      const legacyPreference =
        typeof object.userPreference === "string" ? object.userPreference : "";
      const userPreferences = normalizeUserPreferences(source, legacyPreference);
      setDraftApiSettings((current) =>
        normalizeApiSettings({
          ...current,
          userPreferences
        })
      );
      setPreferenceImportError(null);
    } catch {
      setPreferenceImportError("Could not import preferences.");
    }
  };

  const handleClearPreferences = () => {
    setDraftApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        userPreferences: DEFAULT_USER_PREFERENCES,
        userPreference: ""
      })
    );
    setPreferenceImportError(null);
  };

  const handleSaveSettings = () => {
    onApiSettingsChange(draftApiSettings);
    onSearchSettingsChange(draftSearchSettings);
    setIsSettingsOpen(false);
  };

  return (
    <aside
      className={`history-sidebar ${isCollapsed ? "is-collapsed" : ""}`}
      aria-label="Session history"
    >
      {isCollapsed ? (
        <>
          <div className="collapsed-sidebar-top">
            <button
              className="collapsed-sidebar-button"
              type="button"
              aria-label="Expand sidebar"
              onClick={() => setIsCollapsed(false)}
            >
              {isCompactSidebar ? (
                <Menu size={24} strokeWidth={2} aria-hidden="true" />
              ) : (
                <PanelLeftOpen size={21} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
            <button
              className="collapsed-sidebar-button"
              type="button"
              disabled={isSending}
              aria-label="New session"
              onClick={() => {
                if (isCompactSidebar) {
                  setIsCollapsed(true);
                }
                onNewSession();
              }}
            >
              <SquarePen size={21} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          <div className="collapsed-sidebar-spacer" />
          <div className="collapsed-sidebar-bottom">
            <button
              className={`collapsed-sidebar-button api-settings-button ${
                apiSettingsComplete ? "is-configured" : "needs-setup"
              }`}
              type="button"
              aria-label="API settings"
              aria-pressed={isSettingsOpen}
              onClick={() => setIsSettingsOpen(true)}
            >
              <Settings2 size={21} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-header">
            <div className="sidebar-brand-row">
              <span className="sidebar-brand">StreamUI</span>
              <button
                className="sidebar-collapse-button"
                type="button"
                aria-label="Collapse sidebar"
              onClick={() => {
                setOpenSessionMenuId(null);
                setIsCollapsed(true);
              }}
            >
                <X size={20} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <button
              className="new-session-button"
              type="button"
              disabled={isSending}
              onClick={() => {
                if (isCompactSidebar) {
                  setIsCollapsed(true);
                }
                onNewSession();
              }}
            >
              <SquarePen size={17} strokeWidth={2.1} aria-hidden="true" />
              <span>New Session</span>
            </button>
          </div>

          <nav className="session-list" aria-label="Saved sessions">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`session-list-item ${
                  session.id === activeSessionId ? "is-active" : ""
                } ${openSessionMenuId === session.id ? "is-menu-open" : ""}`}
              >
                <button
                  className="session-select-button"
                  type="button"
                  disabled={isSending && session.id !== activeSessionId}
                  aria-current={
                    session.id === activeSessionId ? "page" : undefined
                  }
                  onClick={() => {
                    setOpenSessionMenuId(null);
                    if (isCompactSidebar) {
                      setIsCollapsed(true);
                    }
                    onSelectSession(session.id);
                  }}
                >
                  <span className="session-title">{session.title}</span>
                </button>
                <button
                  className="session-actions-button"
                  type="button"
                  disabled={isSending}
                  aria-label={`Session actions: ${session.title}`}
                  aria-expanded={openSessionMenuId === session.id}
                  onClick={() =>
                    setOpenSessionMenuId((current) =>
                      current === session.id ? null : session.id
                    )
                  }
                >
                  <MoreHorizontal size={17} strokeWidth={2.1} aria-hidden="true" />
                </button>
                {openSessionMenuId === session.id ? (
                  <div className="session-menu-popover" role="menu">
                    <button
                      className="session-menu-item is-danger"
                      type="button"
                      role="menuitem"
                      disabled={isSending}
                      onClick={() => {
                        setOpenSessionMenuId(null);
                        onDeleteSession(session.id);
                      }}
                    >
                      <Trash2 size={16} strokeWidth={2.1} aria-hidden="true" />
                      <span>Delete</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div
              className="theme-toggle"
              data-mode={themeMode}
              role="group"
              aria-label="Theme"
            >
              <span className="theme-toggle-indicator" aria-hidden="true" />
              <button
                className="theme-toggle-button"
                type="button"
                aria-label="Use day theme"
                aria-pressed={themeMode === "day"}
                onClick={() => onThemeModeChange("day")}
              >
                <Sun size={15} strokeWidth={2.1} aria-hidden="true" />
              </button>
              <button
                className="theme-toggle-button"
                type="button"
                aria-label="Use night theme"
                aria-pressed={themeMode === "night"}
                onClick={() => onThemeModeChange("night")}
              >
                <Moon size={15} strokeWidth={2.1} aria-hidden="true" />
              </button>
            </div>
            <button
              className={`sidebar-icon-button api-settings-button ${
                apiSettingsComplete ? "is-configured" : "needs-setup"
              }`}
              type="button"
              aria-label="API settings"
              aria-pressed={isSettingsOpen}
              onClick={() => setIsSettingsOpen(true)}
            >
              <Settings2 size={17} strokeWidth={2.1} aria-hidden="true" />
            </button>
          </div>
        </>
      )}

      {isSettingsOpen && typeof document !== "undefined"
        ? createPortal(
            (
        <div
          className="settings-overlay"
          data-theme={themeMode}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <section
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-panel-title"
          >
            <aside className="settings-nav" aria-label="Settings sections">
              <button
                className="settings-close-button"
                type="button"
                aria-label="Close settings"
                onClick={() => setIsSettingsOpen(false)}
              >
                <X size={17} strokeWidth={2.1} aria-hidden="true" />
              </button>
              <button
                className={`settings-nav-item ${
                  settingsSection === "api" ? "is-active" : ""
                }`}
                type="button"
                onClick={() => setSettingsSection("api")}
              >
                <KeyRound size={18} strokeWidth={2.1} aria-hidden="true" />
                <span>API</span>
              </button>
              <button
                className={`settings-nav-item ${
                  settingsSection === "preferences" ? "is-active" : ""
                }`}
                type="button"
                onClick={() => setSettingsSection("preferences")}
              >
                <UserRound size={18} strokeWidth={2.1} aria-hidden="true" />
                <span>User Preferences</span>
              </button>
              <button
                className={`settings-nav-item ${
                  settingsSection === "search" ? "is-active" : ""
                }`}
                type="button"
                onClick={() => setSettingsSection("search")}
              >
                <Search size={18} strokeWidth={2.1} aria-hidden="true" />
                <span>Web Search</span>
              </button>
            </aside>

            <div className="settings-content">
              <header className="settings-content-header">
                <h2 id="settings-panel-title">
                  {settingsSection === "api"
                    ? "API"
                    : settingsSection === "preferences"
                      ? "User Preferences"
                      : "Web Search"}
                </h2>
              </header>

              <form
                className="settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleSaveSettings();
                }}
              >
                {settingsSection === "api" ? (
                  <>
                    <label className="settings-row">
                      <span>Provider</span>
                      <select
                        value={draftApiSettings.providerId}
                        onChange={(event) =>
                          handleProviderChange(event.target.value as ApiProviderId)
                        }
                      >
                        {API_PROVIDER_PRESETS.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="settings-row">
                      <span>Base URL</span>
                      <input
                        value={draftApiSettings.baseUrl}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://api.example.com/v1"
                        onChange={(event) => updateApiBaseUrl(event.target.value)}
                      />
                    </label>

                    <label className="settings-row">
                      <span>API Key Source</span>
                      <select
                        value={draftApiSettings.apiKeySource}
                        onChange={(event) =>
                          updateApiDraft({
                            apiKeySource: event.target.value as ApiKeySource
                          })
                        }
                      >
                        {API_KEY_SOURCE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="settings-row">
                      <span>API Key</span>
                      <div className="settings-control-stack">
                        <input
                          value={draftApiSettings.apiKey}
                          autoComplete="off"
                          disabled={draftApiSettings.apiKeySource === "environment"}
                          spellCheck={false}
                          type="password"
                          placeholder={
                            draftApiSettings.apiKeySource === "environment"
                              ? getApiKeyEnvironmentName(draftApiSettings)
                              : "sk-..."
                          }
                          onChange={(event) =>
                            updateApiDraft({ apiKey: event.target.value })
                          }
                        />
                        {draftApiSettings.apiKeySource === "environment" ? (
                          <span
                            className={`settings-hint settings-env-status ${getEnvironmentStatusClass(
                              draftApiKeyStatus
                            )}`}
                          >
                            {formatEnvironmentStatus(
                              getApiKeyEnvironmentName(draftApiSettings),
                              draftApiKeyStatus
                            )}
                          </span>
                        ) : null}
                      </div>
                    </label>

                    <label className="settings-row">
                      <span>Default Model</span>
                      <div className="settings-control-stack">
                        <select
                          value={draftApiSettings.model}
                          onChange={(event) =>
                            updateApiDraft({ model: event.target.value })
                          }
                        >
                          {draftSelectableModels.length ? (
                            draftSelectableModels.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))
                          ) : (
                            <option value="">No saved models</option>
                          )}
                        </select>
                      </div>
                    </label>

                    <label className="settings-row">
                      <span>Models Endpoint</span>
                      <div className="settings-inline-control">
                        <input
                          value={draftApiSettings.modelsEndpoint}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={
                            getDefaultModelsEndpoint(draftApiSettings.baseUrl) ||
                            "https://api.example.com/v1/models"
                          }
                          onChange={(event) =>
                            updateApiDraft({
                              modelsEndpoint: event.target.value
                            })
                          }
                        />
                        <button
                          className="settings-small-button"
                          type="button"
                          disabled={isModelImportLoading}
                          onClick={handleFetchModels}
                        >
                          Fetch
                        </button>
                      </div>
                    </label>

                    <div className="settings-row settings-row-textarea">
                      <span>Model List</span>
                      <div className="settings-model-list">
                        {draftApiSettings.modelOptions.length ? (
                          draftApiSettings.modelOptions.map((model) => (
                            <span
                              key={model}
                              className={`settings-model-chip ${
                                model === draftApiSettings.model ? "is-active" : ""
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => updateApiDraft({ model })}
                              >
                                {model}
                              </button>
                              <button
                                type="button"
                                aria-label={`Remove ${model}`}
                                onClick={() => handleRemoveModelOption(model)}
                              >
                                <X size={13} strokeWidth={2.1} aria-hidden="true" />
                              </button>
                            </span>
                          ))
                        ) : (
                          <span className="settings-empty-state">
                            No saved models
                          </span>
                        )}
                      </div>
                    </div>

                    <label className="settings-row">
                      <span>Reasoning</span>
                      <select
                        value={draftApiSettings.reasoningEffort}
                        onChange={(event) =>
                          updateApiDraft({
                            reasoningEffort: event.target.value as ReasoningEffort
                          })
                        }
                      >
                        {REASONING_EFFORT_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : settingsSection === "preferences" ? (
                  <>
                    {USER_PREFERENCE_FIELDS.map((field) => (
                      <label
                        className="settings-row settings-row-textarea"
                        key={field.key}
                      >
                        <span>{field.label}</span>
                        <textarea
                          value={draftApiSettings.userPreferences[field.key]}
                          maxLength={MAX_USER_PREFERENCE_FIELD_LENGTH}
                          rows={field.rows}
                          placeholder={field.placeholder}
                          spellCheck={false}
                          onChange={(event) =>
                            updateUserPreferenceDraft(
                              field.key,
                              event.target.value
                            )
                          }
                        />
                      </label>
                    ))}
                    <div className="settings-row">
                      <span>Preferences File</span>
                      <div className="settings-control-stack">
                        <div className="settings-preference-actions">
                          <button
                            className="settings-small-button"
                            type="button"
                            onClick={() =>
                              preferenceFileInputRef.current?.click()
                            }
                          >
                            <Upload size={14} strokeWidth={2.1} aria-hidden="true" />
                            <span>Import</span>
                          </button>
                          <button
                            className="settings-small-button"
                            type="button"
                            onClick={handleExportPreferences}
                          >
                            <Download
                              size={14}
                              strokeWidth={2.1}
                              aria-hidden="true"
                            />
                            <span>Export</span>
                          </button>
                          <button
                            className="settings-small-button"
                            type="button"
                            onClick={handleClearPreferences}
                          >
                            <Eraser size={14} strokeWidth={2.1} aria-hidden="true" />
                            <span>Clear</span>
                          </button>
                        </div>
                        <input
                          ref={preferenceFileInputRef}
                          type="file"
                          accept="application/json,.json"
                          hidden
                          onChange={handleImportPreferences}
                        />
                        {preferenceImportError ? (
                          <span className="settings-hint">
                            {preferenceImportError}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="settings-row">
                      <span>Retrieval</span>
                      <input
                        className="settings-checkbox"
                        type="checkbox"
                        checked={draftSearchSettings.enabled}
                        onChange={(event) =>
                          updateSearchDraft({ enabled: event.target.checked })
                        }
                      />
                    </label>

                    <div className="settings-row settings-row-textarea">
                      <span>Capability Status</span>
                      <div className="settings-capability-list">
                        {runtimeSettings ? (
                          <>
                            <span className="settings-capability-chip is-neutral">
                              Provider default: {runtimeSettings.search.defaultProvider}
                            </span>
                            {runtimeSettings.search.providers.map((provider) => (
                              <span
                                className={`settings-capability-chip ${getSearchCapabilityClass(
                                  provider.configured
                                )}`}
                                key={provider.provider}
                              >
                                {formatSearchProviderCapability(provider)}
                              </span>
                            ))}
                            {runtimeSettings.search.browserEngines.map((engine) => (
                              <span
                                className={`settings-capability-chip ${
                                  engine.available ? "is-configured" : "is-missing"
                                }`}
                                key={engine.engine}
                              >
                                {engine.label}:{" "}
                                {engine.available ? "available" : "not installed"}
                                {engine.activeByDefault ? " default" : ""}
                              </span>
                            ))}
                          </>
                        ) : (
                          <span className="settings-empty-state">
                            Checking runtime
                          </span>
                        )}
                      </div>
                    </div>

                    <label className="settings-row">
                      <span>Provider</span>
                      <div className="settings-control-stack">
                        <select
                          value={draftSearchSettings.provider}
                          onChange={(event) => {
                            const provider = event.target.value as SearchProvider;
                            updateSearchDraft({
                              provider,
                              apiKeySource: searchProviderNeedsApiKey(provider)
                                ? draftSearchSettings.apiKeySource
                                : "environment"
                            });
                          }}
                        >
                          {SEARCH_PROVIDER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        {selectedSearchProviderCapability &&
                        draftSearchSettings.apiKeySource === "environment" ? (
                          <span
                            className={`settings-hint settings-env-status ${getSearchCapabilityClass(
                              selectedSearchProviderCapability.configured
                            )}`}
                          >
                            {formatSearchProviderCapability(
                              selectedSearchProviderCapability
                            )}
                          </span>
                        ) : null}
                      </div>
                    </label>

                    <label className="settings-row">
                      <span>API Key Source</span>
                      <select
                        value={draftSearchSettings.apiKeySource}
                        disabled={!searchAllowsManualKey}
                        onChange={(event) =>
                          updateSearchDraft({
                            apiKeySource: event.target.value as ApiKeySource
                          })
                        }
                      >
                        {API_KEY_SOURCE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="settings-row">
                      <span>API Key</span>
                      <div className="settings-control-stack">
                        <input
                          value={draftSearchSettings.apiKey}
                          autoComplete="off"
                          disabled={
                            !searchAllowsManualKey ||
                            draftSearchSettings.apiKeySource === "environment"
                          }
                          spellCheck={false}
                          type="password"
                          placeholder={
                            searchUsesEnvironmentKeys
                              ? draftSearchSettings.apiKeySource === "environment"
                                ? getSearchProviderApiKeyEnvironmentName(
                                    draftSearchSettings
                                  )
                                : "search api key"
                              : "Not required"
                          }
                          onChange={(event) =>
                            updateSearchDraft({ apiKey: event.target.value })
                          }
                        />
                        {searchUsesEnvironmentKeys &&
                        draftSearchSettings.apiKeySource === "environment" &&
                        getSearchProviderApiKeyEnvironmentName(
                          draftSearchSettings
                        ) ? (
                          <span className="settings-hint settings-env-list">
                            {searchKeyStatuses
                              .map(({ name, status }) =>
                                formatEnvironmentStatus(name, status)
                              )
                              .join(" | ")}
                          </span>
                        ) : null}
                        {searchAllowsManualKey &&
                        draftSearchSettings.apiKeySource === "manual" ? (
                          <span
                            className={`settings-hint settings-env-status ${
                              draftSearchSettings.apiKey.trim()
                                ? "is-configured"
                                : "is-missing"
                            }`}
                          >
                            {draftSearchSettings.apiKey.trim()
                              ? "Manual search key entered"
                              : "Manual search key missing"}
                          </span>
                        ) : null}
                      </div>
                    </label>

                    <label className="settings-row">
                      <span>DuckDuckGo Fallback</span>
                      <input
                        className="settings-checkbox"
                        type="checkbox"
                        checked={draftSearchSettings.allowDuckDuckGoFallback}
                        disabled={draftSearchSettings.provider !== "auto"}
                        onChange={(event) =>
                          updateSearchDraft({
                            allowDuckDuckGoFallback: event.target.checked
                          })
                        }
                      />
                    </label>

                    <label className="settings-row">
                      <span>Fetch Engine</span>
                      <div className="settings-control-stack">
                        <select
                          value={draftSearchSettings.browserEngine}
                          onChange={(event) =>
                            updateSearchDraft({
                              browserEngine: event.target.value as SearchBrowserEngine
                            })
                          }
                        >
                          {SEARCH_BROWSER_ENGINE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        {selectedBrowserCapability ? (
                          <span
                            className={`settings-hint settings-env-status ${
                              selectedBrowserCapability.available
                                ? "is-configured"
                                : "is-missing"
                            }`}
                          >
                            {selectedBrowserCapability.detail}
                          </span>
                        ) : null}
                      </div>
                    </label>

                    <label className="settings-row">
                      <span>Results</span>
                      <input
                        value={draftSearchSettings.maxResults}
                        min={1}
                        max={10}
                        type="number"
                        onChange={(event) =>
                          updateSearchDraft({
                            maxResults: Number.parseInt(event.target.value, 10)
                          })
                        }
                      />
                    </label>

                    <label className="settings-row">
                      <span>Pages to Fetch</span>
                      <input
                        value={draftSearchSettings.fetchMaxPages}
                        min={0}
                        max={10}
                        type="number"
                        onChange={(event) =>
                          updateSearchDraft({
                            fetchMaxPages: Number.parseInt(event.target.value, 10)
                          })
                        }
                      />
                    </label>
                  </>
                )}

                <div className="settings-actions">
                  <button
                    className="settings-secondary-button"
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                  >
                    Cancel
                  </button>
                  <button className="settings-primary-button" type="submit">
                    <Check size={16} strokeWidth={2.1} aria-hidden="true" />
                    <span>Done</span>
                  </button>
                </div>
              </form>
            </div>
          </section>
          {isModelImportOpen ? (
            <ModelImportDialog
              models={fetchedModels}
              selectedModels={selectedFetchedModels}
              query={modelImportQuery}
              isLoading={isModelImportLoading}
              error={modelImportError}
              onQueryChange={setModelImportQuery}
              onToggleModel={toggleFetchedModel}
              onClose={() => setIsModelImportOpen(false)}
              onAddSelected={handleAddFetchedModels}
            />
          ) : null}
        </div>
            ),
            document.body
          )
        : null}
    </aside>
  );
}
