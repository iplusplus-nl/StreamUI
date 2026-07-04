import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  MoreHorizontal,
  Moon,
  Search,
  Settings2,
  SquarePen,
  Sun,
  Trash2,
  X
} from "lucide-react";
import {
  API_KEY_SOURCE_OPTIONS,
  API_PROVIDER_PRESETS,
  REASONING_EFFORT_OPTIONS,
  getProviderPreset,
  getApiKeyEnvironmentName,
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

export type ThemeMode = "day" | "night";

export type SessionListItem = {
  id: string;
  title: string;
};

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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"api" | "search">("api");
  const [draftApiSettings, setDraftApiSettings] =
    useState<ApiSettings>(apiSettings);
  const [draftSearchSettings, setDraftSearchSettings] =
    useState<SearchSettings>(searchSettings);
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const apiSettingsComplete = hasCompleteApiSettings(apiSettings);
  const searchAllowsManualKey = searchProviderNeedsApiKey(
    draftSearchSettings.provider
  );
  const searchUsesEnvironmentKeys =
    draftSearchSettings.provider === "auto" || searchAllowsManualKey;

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

  const handleProviderChange = (providerId: ApiProviderId) => {
    const preset = getProviderPreset(providerId);
    setDraftApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        providerId: preset.id,
        providerName: preset.label,
        baseUrl: preset.baseUrl,
        model: preset.model,
        reasoningEffort: preset.reasoningEffort
      })
    );
  };

  const handleSaveSettings = () => {
    onApiSettingsChange(draftApiSettings);
    onSearchSettingsChange(draftSearchSettings);
    setIsSettingsOpen(false);
  };

  return (
    <aside className="history-sidebar" aria-label="Session history">
      <div className="sidebar-header">
        <button
          className="new-session-button"
          type="button"
          disabled={isSending}
          onClick={onNewSession}
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
              aria-current={session.id === activeSessionId ? "page" : undefined}
              onClick={() => {
                setOpenSessionMenuId(null);
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
                  {settingsSection === "api" ? "API" : "Web Search"}
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
                        onChange={(event) =>
                          updateApiDraft({ baseUrl: event.target.value })
                        }
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
                      <span>Model</span>
                      <input
                        value={draftApiSettings.model}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="model-id"
                        onChange={(event) =>
                          updateApiDraft({ model: event.target.value })
                        }
                      />
                    </label>

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
        </div>
      ) : null}
    </aside>
  );
}
