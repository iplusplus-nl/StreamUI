import type { ApiSettings } from "../../core/apiSettings";
import type { DisplaySettings } from "../../core/displaySettings";
import type { ProfileSettings } from "../../core/profileSettings";
import type { SearchSettings } from "../../core/searchSettings";

export type SettingsSection =
  | "profile"
  | "api"
  | "display"
  | "search";

export type SettingsDrafts = {
  api: ApiSettings;
  search: SearchSettings;
  display: DisplaySettings;
  profile: ProfileSettings;
};

export type SettingsDraftDirtyState = Record<keyof SettingsDrafts, boolean> & {
  personalApi: boolean;
};

export function createCleanSettingsDraftState(): SettingsDraftDirtyState {
  return {
    api: false,
    personalApi: false,
    search: false,
    display: false,
    profile: false
  };
}

export function syncApiSettingsDraft(
  currentDraft: ApiSettings,
  incomingSettings: ApiSettings,
  dirty: Pick<SettingsDraftDirtyState, "api" | "personalApi">
): ApiSettings {
  const base = dirty.api ? currentDraft : incomingSettings;
  const personal = dirty.personalApi ? currentDraft : incomingSettings;

  return {
    ...base,
    userPreferencePrompt: personal.userPreferencePrompt,
    memoryItems: personal.memoryItems
  };
}

export function syncSettingsDraft<T>(
  currentDraft: T,
  incomingSettings: T,
  isDirty: boolean
): T {
  return isDirty ? currentDraft : incomingSettings;
}

export function getSettingsEscapeTarget(
  isModelImportOpen: boolean
): "model-import" | "settings" {
  return isModelImportOpen ? "model-import" : "settings";
}

export type SettingsCommitters = {
  onApiSettingsChange(settings: ApiSettings): void;
  onSearchSettingsChange(settings: SearchSettings): void;
  onDisplaySettingsChange(settings: DisplaySettings): void;
  onProfileSettingsChange(settings: ProfileSettings): void;
};

const SETTINGS_SECTION_TITLES: Record<SettingsSection, string> = {
  profile: "Personal",
  api: "Providers",
  display: "Display",
  search: "Web Search"
};

export function getSettingsSectionTitle(section: SettingsSection): string {
  return SETTINGS_SECTION_TITLES[section];
}

export function commitSettingsDrafts(
  drafts: SettingsDrafts,
  committers: SettingsCommitters
): void {
  committers.onApiSettingsChange(drafts.api);
  committers.onSearchSettingsChange(drafts.search);
  committers.onDisplaySettingsChange(drafts.display);
  committers.onProfileSettingsChange(drafts.profile);
}
