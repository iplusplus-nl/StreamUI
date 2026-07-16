import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import {
  createMemoryItemId,
  normalizeApiSettings,
  type ApiProviderId,
  type ApiSettings,
  type MemoryItem
} from "../core/apiSettings";
import type { AccountMode } from "../core/accountMode";
import type { AuthUser } from "../core/cloudAuth";
import type { DisplaySettings } from "../core/displaySettings";
import { compressProfileAvatar } from "../core/profileAvatarImage";
import {
  normalizeProfileSettings,
  type ProfileSettings
} from "../core/profileSettings";
import {
  normalizeSearchSettings,
  type SearchSettings
} from "../core/searchSettings";
import type { RuntimeSettingsSummary } from "../core/runtimeSettings";
import { fetchModelCatalog } from "../features/settings/modelCatalog";
import {
  addSettingsModelOptions,
  applyImportedUserPreferences,
  changeSettingsBaseUrl,
  changeSettingsProvider,
  getExportedUserPreferences,
  removeSettingsModelOption,
  toggleSettingsModelSelection
} from "../features/settings/settingsDraftModel";
import {
  commitSettingsDrafts,
  createCleanSettingsDraftState,
  getSettingsEscapeTarget,
  getSettingsSectionTitle,
  syncApiSettingsDraft,
  syncSettingsDraft,
  type SettingsSection
} from "../features/settings/settingsDialogModel";
import {
  consumeEscapeDismissal,
  isDirectOverlayInteraction
} from "./dismissalModel";
import { ModelImportDialog } from "./ModelImportDialog";
import { ApiSettingsSection } from "./settings/ApiSettingsSection";
import { DisplaySettingsSection } from "./settings/DisplaySettingsSection";
import { ProfileSettingsSection } from "./settings/ProfileSettingsSection";
import { SearchSettingsSection } from "./settings/SearchSettingsSection";
import { SettingsNavigation } from "./settings/SettingsNavigation";
import { useModalFocusTrap } from "./useModalFocusTrap";

export type SettingsDialogProps = {
  section: SettingsSection;
  themeMode: "day" | "night";
  apiSettings: ApiSettings;
  searchSettings: SearchSettings;
  displaySettings: DisplaySettings;
  profileSettings: ProfileSettings;
  runtimeSettings: RuntimeSettingsSummary | null;
  cloudEnabled: boolean;
  accountMode: AccountMode;
  authUser?: AuthUser | null;
  onClose(): void;
  onSectionChange(section: SettingsSection): void;
  onApiSettingsChange(settings: ApiSettings): void;
  onSearchSettingsChange(settings: SearchSettings): void;
  onDisplaySettingsChange(settings: DisplaySettings): void;
  onProfileSettingsChange(settings: ProfileSettings): void;
  onLogout?(): void;
  onExportAccount?(): void;
  onDeleteAccount?(): void;
  onGenerateRecoveryCode?(): Promise<string>;
};

export function SettingsDialog({
  section,
  themeMode,
  apiSettings,
  searchSettings,
  displaySettings,
  profileSettings,
  runtimeSettings,
  cloudEnabled,
  accountMode,
  authUser,
  onClose,
  onSectionChange,
  onApiSettingsChange,
  onSearchSettingsChange,
  onDisplaySettingsChange,
  onProfileSettingsChange,
  onLogout,
  onExportAccount,
  onDeleteAccount,
  onGenerateRecoveryCode
}: SettingsDialogProps) {
  const [draftApiSettings, setDraftApiSettings] = useState(apiSettings);
  const [draftSearchSettings, setDraftSearchSettings] = useState(searchSettings);
  const [draftDisplaySettings, setDraftDisplaySettings] =
    useState(displaySettings);
  const [draftProfileSettings, setDraftProfileSettings] =
    useState(profileSettings);
  const [isModelImportOpen, setIsModelImportOpen] = useState(false);
  const [isModelImportLoading, setIsModelImportLoading] = useState(false);
  const [modelImportError, setModelImportError] = useState<string | null>(null);
  const [modelImportQuery, setModelImportQuery] = useState("");
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [selectedFetchedModels, setSelectedFetchedModels] = useState<string[]>([]);
  const [preferenceImportError, setPreferenceImportError] = useState<string | null>(
    null
  );
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const preferenceFileInputRef = useRef<HTMLInputElement>(null);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dirtyDraftsRef = useRef(createCleanSettingsDraftState());

  useModalFocusTrap({ dialogRef, enabled: !isModelImportOpen });

  useEffect(() => {
    setDraftApiSettings((current) =>
      syncApiSettingsDraft(current, apiSettings, dirtyDraftsRef.current)
    );
  }, [apiSettings]);

  useEffect(() => {
    setDraftSearchSettings((current) =>
      syncSettingsDraft(current, searchSettings, dirtyDraftsRef.current.search)
    );
  }, [searchSettings]);

  useEffect(() => {
    setDraftDisplaySettings((current) =>
      syncSettingsDraft(
        current,
        displaySettings,
        dirtyDraftsRef.current.display
      )
    );
  }, [displaySettings]);

  useEffect(() => {
    setDraftProfileSettings((current) =>
      syncSettingsDraft(
        current,
        profileSettings,
        dirtyDraftsRef.current.profile
      )
    );
  }, [profileSettings]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!consumeEscapeDismissal(event)) {
        return;
      }
      if (getSettingsEscapeTarget(isModelImportOpen) === "model-import") {
        setIsModelImportOpen(false);
        return;
      }
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModelImportOpen, onClose]);

  const updateApiSettingsDraft = (
    update: (current: ApiSettings) => ApiSettings
  ) => {
    dirtyDraftsRef.current.api = true;
    setDraftApiSettings(update);
  };

  const updatePersonalApiSettingsDraft = (
    update: (current: ApiSettings) => ApiSettings
  ) => {
    dirtyDraftsRef.current.personalApi = true;
    setDraftApiSettings(update);
  };

  const updateSearchSettingsDraft = (
    update: (current: SearchSettings) => SearchSettings
  ) => {
    dirtyDraftsRef.current.search = true;
    setDraftSearchSettings(update);
  };

  const updateDisplaySettingsDraft = (
    update: (current: DisplaySettings) => DisplaySettings
  ) => {
    dirtyDraftsRef.current.display = true;
    setDraftDisplaySettings(update);
  };

  const updateProfileSettingsDraft = (
    update: (current: ProfileSettings) => ProfileSettings
  ) => {
    dirtyDraftsRef.current.profile = true;
    setDraftProfileSettings(update);
  };

  const updateApiDraft = (patch: Partial<ApiSettings>) => {
    updateApiSettingsDraft((current) =>
      normalizeApiSettings({ ...current, ...patch })
    );
  };

  const updateSearchDraft = (patch: Partial<SearchSettings>) => {
    updateSearchSettingsDraft((current) =>
      normalizeSearchSettings({ ...current, ...patch })
    );
  };

  const handleAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setAvatarError(null);
    try {
      const avatarDataUrl = await compressProfileAvatar(file);
      const normalized = normalizeProfileSettings({ avatarDataUrl });
      if (!normalized.avatarDataUrl) {
        throw new Error("This image could not be used.");
      }
      updateProfileSettingsDraft(() => normalized);
    } catch (error) {
      setAvatarError(
        error instanceof Error ? error.message : "This image could not be used."
      );
    }
  };

  const handleAddMemoryItem = () => {
    const item: MemoryItem = {
      id: createMemoryItemId(),
      text: "New memory item"
    };
    updatePersonalApiSettingsDraft((current) => ({
      ...current,
      memoryItems: [...current.memoryItems, item]
    }));
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

  const handleExportPreferences = () => {
    const preferences = getExportedUserPreferences(draftApiSettings);
    const blob = new Blob([JSON.stringify(preferences, null, 2)], {
      type: "application/json;charset=utf-8"
    });
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
      updatePersonalApiSettingsDraft((current) =>
        applyImportedUserPreferences(current, parsed)
      );
      setPreferenceImportError(null);
    } catch {
      setPreferenceImportError("Could not import preferences.");
    }
  };

  const handleSave = () => {
    commitSettingsDrafts(
      {
        api: draftApiSettings,
        search: draftSearchSettings,
        display: draftDisplaySettings,
        profile: draftProfileSettings
      },
      {
        onApiSettingsChange,
        onSearchSettingsChange,
        onDisplaySettingsChange,
        onProfileSettingsChange
      }
    );
    onClose();
  };

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="settings-overlay"
      data-theme={themeMode}
      role="presentation"
      onPointerDown={(event) => {
        if (isDirectOverlayInteraction(event.target, event.currentTarget)) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
      >
        <SettingsNavigation
          section={section}
          onSectionChange={onSectionChange}
          onClose={onClose}
        />

        <div className="settings-content">
          <header className="settings-content-header">
            <h2 id="settings-panel-title">{getSettingsSectionTitle(section)}</h2>
          </header>

          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              handleSave();
            }}
          >
            <div className="settings-form-scroll">
              {section === "api" ? (
                <ApiSettingsSection
                settings={draftApiSettings}
                runtimeSettings={runtimeSettings}
                cloudEnabled={cloudEnabled}
                browserOnly={accountMode === "local" && !authUser}
                isModelImportLoading={isModelImportLoading}
                onSettingsChange={updateApiDraft}
                onProviderChange={(providerId: ApiProviderId) =>
                  updateApiSettingsDraft((current) =>
                    changeSettingsProvider(current, providerId)
                  )
                }
                onBaseUrlChange={(baseUrl) =>
                  updateApiSettingsDraft((current) =>
                    changeSettingsBaseUrl(current, baseUrl)
                  )
                }
                onFetchModels={() => void handleFetchModels()}
                onRemoveModel={(modelId) =>
                  updateApiSettingsDraft((current) =>
                    removeSettingsModelOption(current, modelId)
                  )
                }
              />
              ) : section === "profile" ? (
                <ProfileSettingsSection
                apiSettings={draftApiSettings}
                profileSettings={draftProfileSettings}
                cloudEnabled={cloudEnabled}
                accountMode={accountMode}
                authUser={authUser}
                avatarError={avatarError}
                preferenceImportError={preferenceImportError}
                avatarFileInputRef={avatarFileInputRef}
                preferenceFileInputRef={preferenceFileInputRef}
                onAvatarChange={handleAvatarChange}
                onRemoveAvatar={() => {
                  updateProfileSettingsDraft(() => ({ avatarDataUrl: "" }));
                  setAvatarError(null);
                }}
                onUserPreferencePromptChange={(value) =>
                  updatePersonalApiSettingsDraft((current) =>
                    normalizeApiSettings({
                      ...current,
                      userPreferencePrompt: value
                    })
                  )
                }
                onMemoryItemChange={(id, text) =>
                  updatePersonalApiSettingsDraft((current) => ({
                    ...current,
                    memoryItems: current.memoryItems.map((item) =>
                      item.id === id ? { ...item, text } : item
                    )
                  }))
                }
                onAddMemoryItem={handleAddMemoryItem}
                onDeleteMemoryItem={(id) =>
                  updatePersonalApiSettingsDraft((current) => ({
                    ...current,
                    memoryItems: current.memoryItems.filter(
                      (item) => item.id !== id
                    )
                  }))
                }
                onImportPreferences={(event) =>
                  void handleImportPreferences(event)
                }
                onExportPreferences={handleExportPreferences}
                onClearPreferences={() => {
                  updatePersonalApiSettingsDraft((current) => ({
                    ...current,
                    userPreferencePrompt: "",
                    memoryItems: []
                  }));
                  setPreferenceImportError(null);
                }}
                onLogout={onLogout}
                onExportAccount={onExportAccount}
                onDeleteAccount={onDeleteAccount}
                onGenerateRecoveryCode={onGenerateRecoveryCode}
              />
              ) : section === "display" ? (
                <DisplaySettingsSection
                settings={draftDisplaySettings}
                onSettingsChange={(patch) =>
                  updateDisplaySettingsDraft((current) => ({
                    ...current,
                    ...patch
                  }))
                }
              />
              ) : (
                <SearchSettingsSection
                settings={draftSearchSettings}
                runtimeSettings={runtimeSettings}
                onSettingsChange={updateSearchDraft}
              />
              )}
            </div>

            <div className="settings-actions">
              <button
                className="settings-secondary-button"
                type="button"
                onClick={onClose}
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
          requiredModels={[]}
          query={modelImportQuery}
          isLoading={isModelImportLoading}
          error={modelImportError}
          onQueryChange={setModelImportQuery}
          onToggleModel={(modelId) =>
            setSelectedFetchedModels((current) =>
              toggleSettingsModelSelection(current, modelId)
            )
          }
          onClose={() => setIsModelImportOpen(false)}
          onAddSelected={() => {
            if (!selectedFetchedModels.length) {
              return;
            }
            updateApiSettingsDraft((current) =>
              addSettingsModelOptions(current, selectedFetchedModels)
            );
            setIsModelImportOpen(false);
          }}
        />
      ) : null}
    </div>,
    document.body
  );
}
