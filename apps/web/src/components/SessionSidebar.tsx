import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  MoreHorizontal,
  Moon,
  PanelLeftOpen,
  Search,
  Settings2,
  SquarePen,
  Sun,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import {
  API_KEY_SOURCE_OPTIONS,
  API_PROVIDER_PRESETS,
  MAX_USER_PREFERENCE_LENGTH,
  REASONING_EFFORT_OPTIONS,
  getDefaultModelsEndpoint,
  getProviderPreset,
  getApiKeyEnvironmentName,
  getSelectableModelOptions,
  hasCompleteApiSettings,
  normalizeApiSettings,
  type ApiKeySource,
  type ApiProviderId,
  type ApiSettings,
  type ReasoningEffort
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
import { fetchModelCatalog } from "../features/settings/modelCatalog";
import { ModelImportDialog } from "./ModelImportDialog";

export type ThemeMode = "day" | "night";

export type SessionListItem = {
  id: string;
  title: string;
};

type SettingsSection = "api" | "preferences" | "search";

const COMPACT_SIDEBAR_QUERY = "(max-width: 720px), (orientation: portrait)";

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
  onNewSession(): void;
  onSelectSession(id: string): void;
  onDeleteSession(id: string): void;
  onThemeModeChange(mode: ThemeMode): void;
  onApiSettingsChange(settings: ApiSettings): void;
  onSearchSettingsChange(settings: SearchSettings): void;
};

export function SessionSidebar({
  sessions,
  activeSessionId,
  isSending,
  themeMode,
  apiSettings,
  searchSettings,
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
  const apiSettingsComplete = hasCompleteApiSettings(apiSettings);
  const searchAllowsManualKey = searchProviderNeedsApiKey(
    draftSearchSettings.provider
  );
  const searchUsesEnvironmentKeys =
    draftSearchSettings.provider === "auto" || searchAllowsManualKey;
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

  const handleSaveSettings = () => {
    onApiSettingsChange(draftApiSettings);
    onSearchSettingsChange(draftSearchSettings);
    setIsSettingsOpen(false);
  };

  return (
    <aside
      className={`history-sidebar ${isCollapsed ? "is-collapsed" : ""} ${
        isSettingsOpen ? "is-settings-open" : ""
      }`}
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
              <PanelLeftOpen size={21} strokeWidth={2} aria-hidden="true" />
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

      {isSettingsOpen ? (
        <div
          className="settings-overlay"
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
                          <span className="settings-hint">
                            {getApiKeyEnvironmentName(draftApiSettings)}
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
                  <label className="settings-row settings-row-textarea">
                    <span>User Preferences</span>
                    <textarea
                      value={draftApiSettings.userPreference}
                      maxLength={MAX_USER_PREFERENCE_LENGTH}
                      rows={4}
                      placeholder="Preferred tone or response style"
                      spellCheck={false}
                      onChange={(event) =>
                        updateApiDraft({ userPreference: event.target.value })
                      }
                    />
                  </label>
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

                    <label className="settings-row">
                      <span>Provider</span>
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
                          <span className="settings-hint">
                            {getSearchProviderApiKeyEnvironmentName(
                              draftSearchSettings
                            )}
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
      ) : null}
    </aside>
  );
}
