import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import {
  Bug,
  Camera,
  Check,
  CreditCard,
  Download,
  Eraser,
  Eye,
  KeyRound,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelLeftOpen,
  Plus,
  Search,
  SquarePen,
  Trash2,
  Upload,
  UserRound,
  X
} from "lucide-react";
import {
  API_KEY_SOURCE_OPTIONS,
  API_PROVIDER_PRESETS,
  UI_COMPLEXITY_LEVEL_OPTIONS,
  MAX_MEMORY_ITEMS,
  MAX_MEMORY_ITEM_TEXT_LENGTH,
  MAX_USER_PREFERENCE_PROMPT_LENGTH,
  REASONING_EFFORT_OPTIONS,
  REQUIRED_MODEL_OPTIONS,
  createMemoryItemId,
  getDefaultModelsEndpoint,
  getProviderPreset,
  getApiKeyEnvironmentName,
  getUiComplexityLevel,
  getSelectableModelOptions,
  isRequiredModelOption,
  normalizeApiSettings,
  normalizeMemoryItems,
  normalizeUiComplexity,
  type ApiKeySource,
  type ApiProviderId,
  type ApiSettings,
  type MemoryItem,
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
import type { DisplaySettings } from "../core/displaySettings";
import {
  MAX_PROFILE_AVATAR_BYTES,
  normalizeProfileSettings,
  type ProfileSettings
} from "../core/profileSettings";
import {
  getEnvironmentKeyStatus,
  type EnvironmentKeyStatus,
  type RuntimeSearchBrowserStatus,
  type RuntimeSearchProviderStatus,
  type RuntimeSettingsSummary
} from "../core/runtimeSettings";
import type { AuthUser } from "../core/cloudAuth";
import { topUpBalance } from "../core/cloudBilling";
import { fetchModelCatalog } from "../features/settings/modelCatalog";
import packageJson from "../../package.json";
import { ModelImportDialog } from "./ModelImportDialog";

export type ThemeMode = "day" | "night";

export type SessionListItem = {
  id: string;
  title: string;
};

type SettingsSection = "profile" | "api" | "billing" | "display" | "search";

const COMPACT_SIDEBAR_QUERY = "(max-width: 720px), (orientation: portrait)";
const APP_VERSION = packageJson.version;
const APP_COMMIT = __APP_COMMIT__;

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
  isSessionSelectionBlocked: boolean;
  themeMode: ThemeMode;
  apiSettings: ApiSettings;
  searchSettings: SearchSettings;
  displaySettings: DisplaySettings;
  profileSettings: ProfileSettings;
  runtimeSettings: RuntimeSettingsSummary | null;
  cloudEnabled?: boolean;
  authUser?: AuthUser | null;
  onNewSession(): void;
  onSelectSession(id: string): void;
  onDeleteSession(id: string): void;
  onApiSettingsChange(settings: ApiSettings): void;
  onSearchSettingsChange(settings: SearchSettings): void;
  onDisplaySettingsChange(settings: DisplaySettings): void;
  onProfileSettingsChange(settings: ProfileSettings): void;
  onAuthUserChange?(user: AuthUser): void;
  onLoginRequest?(): void;
  onLogout?(): void;
  onBugReportOpen(): void;
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

function ProfileAvatar({
  avatarDataUrl,
  size = "sidebar"
}: {
  avatarDataUrl: string;
  size?: "sidebar" | "settings";
}) {
  return (
    <span className={`profile-avatar is-${size}`} aria-hidden="true">
      {avatarDataUrl ? <img src={avatarDataUrl} alt="" /> : null}
    </span>
  );
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  isSending,
  isSessionSelectionBlocked,
  themeMode,
  apiSettings,
  searchSettings,
  displaySettings,
  profileSettings,
  runtimeSettings,
  cloudEnabled = false,
  authUser,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onApiSettingsChange,
  onSearchSettingsChange,
  onDisplaySettingsChange,
  onProfileSettingsChange,
  onAuthUserChange,
  onLoginRequest,
  onLogout,
  onBugReportOpen
}: SessionSidebarProps) {
  const [isCompactSidebar, setIsCompactSidebar] = useState(
    getInitialSidebarCollapsed
  );
  const [isCollapsed, setIsCollapsed] = useState(getInitialSidebarCollapsed);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("profile");
  const [draftApiSettings, setDraftApiSettings] =
    useState<ApiSettings>(apiSettings);
  const [draftSearchSettings, setDraftSearchSettings] =
    useState<SearchSettings>(searchSettings);
  const [draftDisplaySettings, setDraftDisplaySettings] =
    useState<DisplaySettings>(displaySettings);
  const [draftProfileSettings, setDraftProfileSettings] =
    useState<ProfileSettings>(profileSettings);
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
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState("10");
  const [isTopUpLoading, setIsTopUpLoading] = useState(false);
  const [topUpFeedback, setTopUpFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const preferenceFileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const draftApiKeyStatus = getEnvironmentKeyStatus(
    runtimeSettings?.api.environmentKeys,
    getApiKeyEnvironmentName(draftApiSettings)
  );
  const draftApiUsesRuntimeKey =
    draftApiSettings.apiKeySource === "environment" ||
    draftApiSettings.apiKeySource === "managed";
  const isManagedApiProvider = draftApiSettings.apiKeySource === "managed";
  const draftApiKeySourceOptions = isManagedApiProvider
    ? [{ value: "managed" as ApiKeySource, label: "Managed by ChatHTML Cloud" }]
    : API_KEY_SOURCE_OPTIONS;
  const providerPresets = API_PROVIDER_PRESETS.filter(
    (preset) =>
      preset.apiKeySource !== "managed" ||
      cloudEnabled ||
      preset.id === draftApiSettings.providerId
  );
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
      setDraftDisplaySettings(displaySettings);
      setDraftProfileSettings(profileSettings);
      setPreferenceImportError(null);
      setAvatarError(null);
      setTopUpFeedback(null);
    }
  }, [apiSettings, displaySettings, isSettingsOpen, profileSettings, searchSettings]);

  useEffect(() => {
    if (!cloudEnabled && settingsSection === "billing") {
      setSettingsSection("profile");
    }
  }, [cloudEnabled, settingsSection]);

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

  const updateDisplayDraft = (patch: Partial<DisplaySettings>) => {
    setDraftDisplaySettings((current) => ({ ...current, ...patch }));
  };

  const handleAvatarChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!/image\/(?:png|jpeg|webp|gif)/i.test(file.type)) {
      setAvatarError("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    if (file.size > MAX_PROFILE_AVATAR_BYTES) {
      setAvatarError("Choose an image smaller than 1 MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const avatarDataUrl = typeof reader.result === "string" ? reader.result : "";
      const normalized = normalizeProfileSettings({ avatarDataUrl });
      if (!normalized.avatarDataUrl) {
        setAvatarError("This image could not be used.");
        return;
      }
      setDraftProfileSettings(normalized);
      setAvatarError(null);
    };
    reader.onerror = () => setAvatarError("This image could not be read.");
    reader.readAsDataURL(file);
  };

  const updateUserPreferencePromptDraft = (value: string) => {
    setDraftApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        userPreferencePrompt: value
      })
    );
  };

  const updateMemoryItemDraft = (id: string, text: string) => {
    setDraftApiSettings((current) => ({
      ...current,
      memoryItems: current.memoryItems.map((item) =>
        item.id === id
          ? { ...item, text: text.slice(0, MAX_MEMORY_ITEM_TEXT_LENGTH) }
          : item
      )
    }));
  };

  const handleAddMemoryItem = () => {
    const item: MemoryItem = {
      id: createMemoryItemId(),
      text: "New memory item"
    };
    setDraftApiSettings((current) => ({
      ...current,
      memoryItems: [...current.memoryItems, item]
    }));
  };

  const handleDeleteMemoryItem = (id: string) => {
    setDraftApiSettings((current) => ({
      ...current,
      memoryItems: current.memoryItems.filter((item) => item.id !== id)
    }));
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
        reasoningEffort: preset.reasoningEffort,
        apiKeySource: preset.apiKeySource ?? current.apiKeySource,
        apiKey: preset.apiKeySource === "managed" ? "" : current.apiKey
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
    if (isRequiredModelOption(modelId)) {
      return;
    }

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
    if (isRequiredModelOption(modelId)) {
      return;
    }

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
    const preferences = {
      userPreferencePrompt: draftApiSettings.userPreferencePrompt.trim(),
      memoryItems: normalizeMemoryItems(draftApiSettings.memoryItems)
    };
    const blob = new Blob(
      [JSON.stringify(preferences, null, 2)],
      { type: "application/json;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "chathtml-preferences.json";
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
      setDraftApiSettings((current) => {
        const imported = normalizeApiSettings(parsed);
        return {
          ...current,
          userPreferencePrompt: imported.userPreferencePrompt,
          memoryItems: imported.memoryItems
        };
      });
      setPreferenceImportError(null);
    } catch {
      setPreferenceImportError("Could not import preferences.");
    }
  };

  const handleClearPreferences = () => {
    setDraftApiSettings((current) =>
      ({
        ...current,
        userPreferencePrompt: "",
        memoryItems: []
      })
    );
    setPreferenceImportError(null);
  };

  const handlePlaceholderTopUp = async () => {
    if (!authUser || isTopUpLoading) {
      return;
    }

    setIsTopUpLoading(true);
    setTopUpFeedback(null);
    try {
      const result = await topUpBalance(topUpAmount.trim());
      onAuthUserChange?.({
        ...authUser,
        balanceMicros: result.balanceMicros,
        balanceUsd: result.balanceUsd
      });
      setTopUpAmount(result.amountUsd);
      setTopUpFeedback({
        type: "success",
        message: `Added $${result.amountUsd}. Balance is $${result.balanceUsd}.`
      });
    } catch (error) {
      setTopUpFeedback({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not add credit."
      });
    } finally {
      setIsTopUpLoading(false);
    }
  };

  const handleSaveSettings = () => {
    onApiSettingsChange(draftApiSettings);
    onSearchSettingsChange(draftSearchSettings);
    onDisplaySettingsChange(draftDisplaySettings);
    onProfileSettingsChange(draftProfileSettings);
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
              className="sidebar-profile-button is-collapsed"
              type="button"
              aria-label="Open personal settings"
              title="Personal settings"
              onClick={() => {
                setSettingsSection("profile");
                setIsSettingsOpen(true);
              }}
            >
              <ProfileAvatar avatarDataUrl={profileSettings.avatarDataUrl} />
            </button>
            <button
              className="collapsed-sidebar-button"
              type="button"
              aria-label="Bug Report"
              title="Bug Report"
              onClick={onBugReportOpen}
            >
              <Bug size={21} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-header">
            <div className="sidebar-brand-row">
              <span className="sidebar-brand">ChatHTML</span>
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
                  disabled={isSessionSelectionBlocked}
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
            <button
              className="sidebar-profile-button"
              type="button"
              aria-label="Open personal settings"
              title={authUser?.email || "Personal settings"}
              onClick={() => {
                setSettingsSection("profile");
                setIsSettingsOpen(true);
              }}
            >
              <ProfileAvatar avatarDataUrl={profileSettings.avatarDataUrl} />
            </button>
            <button
              className="sidebar-icon-button"
              type="button"
              aria-label="Bug Report"
              title="Bug Report"
              onClick={onBugReportOpen}
            >
              <Bug size={17} strokeWidth={2.1} aria-hidden="true" />
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
                  settingsSection === "profile" ? "is-active" : ""
                }`}
                type="button"
                onClick={() => setSettingsSection("profile")}
              >
                <UserRound size={18} strokeWidth={2.1} aria-hidden="true" />
                <span>Personal</span>
              </button>
              <button
                className={`settings-nav-item ${
                  settingsSection === "api" ? "is-active" : ""
                }`}
                type="button"
                onClick={() => setSettingsSection("api")}
              >
                <KeyRound size={18} strokeWidth={2.1} aria-hidden="true" />
                <span>Providers</span>
              </button>
              {cloudEnabled ? (
                <button
                  className={`settings-nav-item ${
                    settingsSection === "billing" ? "is-active" : ""
                  }`}
                  type="button"
                  onClick={() => setSettingsSection("billing")}
                >
                  <CreditCard size={18} strokeWidth={2.1} aria-hidden="true" />
                  <span>Billing</span>
                </button>
              ) : null}
              <button
                className={`settings-nav-item ${
                  settingsSection === "display" ? "is-active" : ""
                }`}
                type="button"
                onClick={() => setSettingsSection("display")}
              >
                <Eye size={18} strokeWidth={2.1} aria-hidden="true" />
                <span>Display</span>
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
              <div
                className="settings-build-meta"
                aria-label={`Version ${APP_VERSION}, commit ${APP_COMMIT}`}
              >
                <span>v{APP_VERSION}</span>
                <code>{APP_COMMIT}</code>
              </div>
            </aside>

            <div className="settings-content">
              <header className="settings-content-header">
                <h2 id="settings-panel-title">
                  {settingsSection === "profile"
                    ? "Personal"
                    : settingsSection === "api"
                      ? "Providers"
                    : settingsSection === "billing"
                      ? "Billing"
                      : settingsSection === "display"
                        ? "Display"
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
                        {providerPresets.map((preset) => (
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
                        disabled={isManagedApiProvider}
                        placeholder="https://api.example.com/v1"
                        onChange={(event) => updateApiBaseUrl(event.target.value)}
                      />
                    </label>

                    <label className="settings-row">
                      <span>API Key Source</span>
                      <select
                        value={draftApiSettings.apiKeySource}
                        disabled={isManagedApiProvider}
                        onChange={(event) =>
                          updateApiDraft({
                            apiKeySource: event.target.value as ApiKeySource
                          })
                        }
                      >
                        {draftApiKeySourceOptions.map((option) => (
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
                          disabled={draftApiSettings.apiKeySource !== "manual"}
                          spellCheck={false}
                          type="password"
                          placeholder={
                            isManagedApiProvider
                              ? "Managed by ChatHTML Cloud"
                              : draftApiSettings.apiKeySource === "environment"
                              ? getApiKeyEnvironmentName(draftApiSettings)
                              : "sk-..."
                          }
                          onChange={(event) =>
                            updateApiDraft({ apiKey: event.target.value })
                          }
                        />
                        {draftApiUsesRuntimeKey ? (
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
                          disabled={isManagedApiProvider}
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
                          draftApiSettings.modelOptions.map((model) => {
                            const isRequiredModel = isRequiredModelOption(model);

                            return (
                              <span
                                key={model}
                                className={`settings-model-chip ${
                                  model === draftApiSettings.model
                                    ? "is-active"
                                    : ""
                                } ${isRequiredModel ? "is-locked" : ""}`}
                              >
                                <button
                                  type="button"
                                  onClick={() => updateApiDraft({ model })}
                                >
                                  {model}
                                </button>
                                <button
                                  type="button"
                                  aria-label={
                                    isRequiredModel
                                      ? `${model} is always included`
                                      : `Remove ${model}`
                                  }
                                  disabled={isRequiredModel}
                                  title={isRequiredModel ? "Always included" : undefined}
                                  onClick={() => handleRemoveModelOption(model)}
                                >
                                  <X
                                    size={13}
                                    strokeWidth={2.1}
                                    aria-hidden="true"
                                  />
                                </button>
                              </span>
                            );
                          })
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

                    <label className="settings-row">
                      <span>UI complexity</span>
                      <select
                        value={getUiComplexityLevel(draftApiSettings.uiComplexity).value}
                        onChange={(event) =>
                          updateApiDraft({
                            uiComplexity: normalizeUiComplexity(event.target.value)
                          })
                        }
                      >
                        {UI_COMPLEXITY_LEVEL_OPTIONS.map((option) => (
                          <option key={option.label} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : settingsSection === "billing" ? (
                  <>
                    <div className="settings-row">
                      <span>Balance</span>
                      <div className="settings-control-stack">
                        <span className="settings-capability-chip is-configured">
                          {authUser && typeof authUser.balanceUsd === "string"
                            ? `$${authUser.balanceUsd}`
                            : "Sign in required"}
                        </span>
                        <span className="settings-hint">
                          Managed runs are charged from this prepaid balance by
                          the hosted ChatHTML Cloud backend.
                        </span>
                        {!authUser && onLoginRequest ? (
                          <button
                            className="settings-small-button"
                            type="button"
                            onClick={onLoginRequest}
                          >
                            <UserRound
                              size={14}
                              strokeWidth={2.1}
                              aria-hidden="true"
                            />
                            <span>Sign In</span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <label className="settings-row">
                      <span>Top Up</span>
                      <div className="settings-control-stack">
                        <div className="settings-inline-control">
                          <input
                            value={topUpAmount}
                            autoComplete="off"
                            disabled={!authUser || isTopUpLoading}
                            inputMode="decimal"
                            placeholder="10"
                            onChange={(event) => {
                              setTopUpAmount(event.target.value);
                              setTopUpFeedback(null);
                            }}
                          />
                          <button
                            className="settings-small-button"
                            type="button"
                            disabled={!authUser || isTopUpLoading}
                            onClick={() => void handlePlaceholderTopUp()}
                          >
                            <Plus size={14} strokeWidth={2.1} aria-hidden="true" />
                            <span>{isTopUpLoading ? "Adding" : "Top Up"}</span>
                          </button>
                        </div>
                        <span
                          className={`settings-hint ${
                            topUpFeedback
                              ? `settings-env-status ${
                                  topUpFeedback.type === "success"
                                    ? "is-configured"
                                    : "is-missing"
                                }`
                              : ""
                          }`}
                        >
                          {topUpFeedback
                            ? topUpFeedback.message
                            : "Uses the public /api/billing/top-up contract."}
                        </span>
                      </div>
                    </label>
                  </>
                ) : settingsSection === "profile" ? (
                  <>
                    <div className="settings-profile-hero">
                      <button
                        className="settings-avatar-editor"
                        type="button"
                        aria-label="Change profile photo"
                        onClick={() => avatarFileInputRef.current?.click()}
                      >
                        <ProfileAvatar
                          avatarDataUrl={draftProfileSettings.avatarDataUrl}
                          size="settings"
                        />
                        <span className="settings-avatar-editor-icon">
                          <Camera size={16} strokeWidth={2.1} aria-hidden="true" />
                        </span>
                      </button>
                      <button
                        className="settings-avatar-change-button"
                        type="button"
                        onClick={() => avatarFileInputRef.current?.click()}
                      >
                        Change photo
                      </button>
                      {draftProfileSettings.avatarDataUrl ? (
                        <button
                          className="settings-avatar-remove-button"
                          type="button"
                          onClick={() => {
                            setDraftProfileSettings({ avatarDataUrl: "" });
                            setAvatarError(null);
                          }}
                        >
                          Remove
                        </button>
                      ) : null}
                      <input
                        ref={avatarFileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        hidden
                        onChange={handleAvatarChange}
                      />
                      {avatarError ? (
                        <span className="settings-profile-error">{avatarError}</span>
                      ) : null}
                    </div>

                    {cloudEnabled ? (
                      <div className="settings-row">
                        <span>Account</span>
                        <div className="settings-account-control">
                          <span className="settings-account-copy">
                            {authUser?.email ?? "Not signed in"}
                          </span>
                          {authUser && onLogout ? (
                            <button
                              className="settings-small-button"
                              type="button"
                              onClick={onLogout}
                            >
                              <LogOut size={14} strokeWidth={2.1} aria-hidden="true" />
                              <span>Sign out</span>
                            </button>
                          ) : onLoginRequest ? (
                            <button
                              className="settings-small-button"
                              type="button"
                              onClick={onLoginRequest}
                            >
                              <UserRound
                                size={14}
                                strokeWidth={2.1}
                                aria-hidden="true"
                              />
                              <span>Sign in</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    <label className="settings-row settings-row-textarea">
                      <span>User Preference Prompt</span>
                      <textarea
                        value={draftApiSettings.userPreferencePrompt}
                        maxLength={MAX_USER_PREFERENCE_PROMPT_LENGTH}
                        rows={5}
                        placeholder="Persistent instructions that should shape every reply."
                        spellCheck={false}
                        onChange={(event) =>
                          updateUserPreferencePromptDraft(event.target.value)
                        }
                      />
                    </label>

                    <div className="settings-row settings-row-textarea">
                      <span>Memory Items</span>
                      <div className="settings-control-stack settings-memory-list">
                        {draftApiSettings.memoryItems.length ? (
                          draftApiSettings.memoryItems.map((item) => (
                            <div className="settings-memory-row" key={item.id}>
                              <textarea
                                value={item.text}
                                maxLength={MAX_MEMORY_ITEM_TEXT_LENGTH}
                                rows={2}
                                placeholder="Stable preference or fact to remember."
                                spellCheck={false}
                                onChange={(event) =>
                                  updateMemoryItemDraft(
                                    item.id,
                                    event.target.value
                                  )
                                }
                              />
                              <button
                                className="settings-icon-button"
                                type="button"
                                aria-label="Delete memory item"
                                title="Delete memory item"
                                onClick={() => handleDeleteMemoryItem(item.id)}
                              >
                                <Trash2
                                  size={14}
                                  strokeWidth={2.1}
                                  aria-hidden="true"
                                />
                              </button>
                            </div>
                          ))
                        ) : (
                          <span className="settings-empty-state">
                            No memory items yet
                          </span>
                        )}
                        <button
                          className="settings-small-button settings-add-memory-button"
                          type="button"
                          onClick={handleAddMemoryItem}
                          disabled={
                            draftApiSettings.memoryItems.length >= MAX_MEMORY_ITEMS
                          }
                        >
                          <Plus size={14} strokeWidth={2.1} aria-hidden="true" />
                          <span>Add Memory</span>
                        </button>
                      </div>
                    </div>

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
                ) : settingsSection === "display" ? (
                  <>
                    <label className="settings-row">
                      <span>Direct Edit</span>
                      <input
                        className="settings-switch"
                        type="checkbox"
                        role="switch"
                        checked={draftDisplaySettings.artifactEditingEnabled}
                        onChange={(event) =>
                          updateDisplayDraft({
                            artifactEditingEnabled: event.target.checked
                          })
                        }
                      />
                    </label>
                    <label className="settings-row">
                      <span>Raw Stream</span>
                      <input
                        className="settings-checkbox"
                        type="checkbox"
                        checked={draftDisplaySettings.showRawStream}
                        onChange={(event) =>
                          updateDisplayDraft({
                            showRawStream: event.target.checked
                          })
                        }
                      />
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
              requiredModels={[...REQUIRED_MODEL_OPTIONS]}
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
