import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_API_SETTINGS } from "../../core/apiSettings";
import { DEFAULT_DISPLAY_SETTINGS } from "../../core/displaySettings";
import { DEFAULT_PROFILE_SETTINGS } from "../../core/profileSettings";
import { DEFAULT_SEARCH_SETTINGS } from "../../core/searchSettings";
import {
  commitSettingsDrafts,
  createCleanSettingsDraftState,
  getSettingsEscapeTarget,
  getSettingsSectionTitle,
  syncApiSettingsDraft,
  syncSettingsDraft
} from "./settingsDialogModel";

describe("settings dialog model", () => {
  it("provides the stable section headings used by the dialog", () => {
    assert.equal(getSettingsSectionTitle("profile"), "Personal");
    assert.equal(getSettingsSectionTitle("api"), "Providers");
    assert.equal(getSettingsSectionTitle("display"), "Display");
    assert.equal(getSettingsSectionTitle("search"), "Web Search");
  });

  it("commits each settings category exactly once without transforming drafts", () => {
    const calls: Array<[string, unknown]> = [];
    const drafts = {
      api: { ...DEFAULT_API_SETTINGS, model: "draft-model" },
      search: { ...DEFAULT_SEARCH_SETTINGS, enabled: true },
      display: { ...DEFAULT_DISPLAY_SETTINGS, showRawStream: true },
      profile: { ...DEFAULT_PROFILE_SETTINGS, avatarDataUrl: "data:image/png;base64,x" }
    };

    commitSettingsDrafts(drafts, {
      onApiSettingsChange: (settings) => calls.push(["api", settings]),
      onSearchSettingsChange: (settings) => calls.push(["search", settings]),
      onDisplaySettingsChange: (settings) => calls.push(["display", settings]),
      onProfileSettingsChange: (settings) => calls.push(["profile", settings])
    });

    assert.deepEqual(calls, [
      ["api", drafts.api],
      ["search", drafts.search],
      ["display", drafts.display],
      ["profile", drafts.profile]
    ]);
  });

  it("accepts background settings for clean categories without replacing dirty drafts", () => {
    const clean = createCleanSettingsDraftState();
    const dirtyApi = { ...clean, api: true };
    const dirtyProfile = { ...clean, profile: true };
    const currentApi = {
      ...DEFAULT_API_SETTINGS,
      apiKey: "unsaved-key",
      userPreferencePrompt: "unsaved preference",
      memoryItems: [{ id: "unsaved", text: "Unsaved memory" }]
    };
    const incomingApi = {
      ...DEFAULT_API_SETTINGS,
      apiKey: "loaded-key",
      userPreferencePrompt: "loaded preference",
      memoryItems: [{ id: "loaded", text: "Loaded memory" }]
    };
    const currentProfile = {
      ...DEFAULT_PROFILE_SETTINGS,
      avatarDataUrl: "data:image/png;base64,unsaved"
    };
    const incomingProfile = {
      ...DEFAULT_PROFILE_SETTINGS,
      avatarDataUrl: "data:image/png;base64,loaded"
    };

    assert.deepEqual(syncApiSettingsDraft(currentApi, incomingApi, clean), incomingApi);
    assert.deepEqual(syncApiSettingsDraft(currentApi, incomingApi, dirtyApi), {
      ...currentApi,
      userPreferencePrompt: incomingApi.userPreferencePrompt,
      memoryItems: incomingApi.memoryItems
    });
    assert.equal(
      syncSettingsDraft(currentProfile, incomingProfile, dirtyProfile.profile),
      currentProfile
    );

    const currentSearch = { ...DEFAULT_SEARCH_SETTINGS, apiKey: "unsaved" };
    const incomingSearch = { ...DEFAULT_SEARCH_SETTINGS, apiKey: "loaded" };
    const currentDisplay = {
      ...DEFAULT_DISPLAY_SETTINGS,
      showRawStream: true
    };
    const incomingDisplay = {
      ...DEFAULT_DISPLAY_SETTINGS,
      showRawStream: false
    };

    assert.equal(
      syncSettingsDraft(currentSearch, incomingSearch, true),
      currentSearch
    );
    assert.equal(
      syncSettingsDraft(currentDisplay, incomingDisplay, true),
      currentDisplay
    );
  });

  it("merges background provider data without erasing dirty Personal fields", () => {
    const clean = createCleanSettingsDraftState();
    const current = {
      ...DEFAULT_API_SETTINGS,
      apiKey: "draft-key",
      userPreferencePrompt: "draft preference",
      memoryItems: [{ id: "draft", text: "Draft memory" }]
    };
    const incoming = {
      ...DEFAULT_API_SETTINGS,
      model: "loaded-model",
      apiKey: "loaded-key",
      userPreferencePrompt: "loaded preference",
      memoryItems: [{ id: "loaded", text: "Loaded memory" }]
    };

    assert.deepEqual(
      syncApiSettingsDraft(current, incoming, {
        ...clean,
        personalApi: true
      }),
      {
        ...incoming,
        userPreferencePrompt: current.userPreferencePrompt,
        memoryItems: current.memoryItems
      }
    );
    assert.deepEqual(
      syncApiSettingsDraft(current, incoming, {
        ...clean,
        api: true,
        personalApi: true
      }),
      current
    );
  });

  it("dismisses the nested model importer before the settings dialog", () => {
    assert.equal(getSettingsEscapeTarget(true), "model-import");
    assert.equal(getSettingsEscapeTarget(false), "settings");
  });
});
