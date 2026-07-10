import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hasSavedApiSettings,
  loadApiSettings,
  normalizeApiSettings,
  saveApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import {
  loadDisplaySettings,
  normalizeDisplaySettings,
  saveDisplaySettings,
  type DisplaySettings
} from "../../core/displaySettings";
import {
  applyMemoryStreamEvent,
  type MemoryStreamEvent
} from "../../core/memoryStreamEvents";
import {
  loadProfileSettings,
  normalizeProfileSettings,
  saveProfileSettings,
  type ProfileSettings
} from "../../core/profileSettings";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";
import {
  loadSearchSettings,
  normalizeSearchSettings,
  saveSearchSettings,
  type SearchSettings
} from "../../core/searchSettings";
import {
  runRuntimeSettingsLoad,
  type AppSettingsControllerDependencies
} from "./appSettingsController";

export type AppSettingsDependencies = Partial<AppSettingsControllerDependencies> & {
  hasSavedApiSettings?(): boolean;
  saveApiSettings?(settings: ApiSettings): void;
  saveSearchSettings?(settings: SearchSettings): void;
  saveDisplaySettings?(settings: DisplaySettings): void;
  saveProfileSettings?(settings: ProfileSettings): void;
};

export type AppSettingsController = {
  apiSettings: ApiSettings;
  searchSettings: SearchSettings;
  displaySettings: DisplaySettings;
  profileSettings: ProfileSettings;
  runtimeSettings: RuntimeSettingsSummary | null;
  cloudEnabled: boolean;
  replaceApiSettings(settings: ApiSettings): void;
  replaceSearchSettings(settings: SearchSettings): void;
  replaceDisplaySettings(settings: DisplaySettings): void;
  replaceProfileSettings(settings: ProfileSettings): void;
  updateApiSettings(updater: (current: ApiSettings) => ApiSettings): void;
  applyMemoryEvent(event: MemoryStreamEvent): void;
};

export function useAppSettings(
  dependencies: AppSettingsDependencies = {}
): AppSettingsController {
  // Dependency overrides are test seams and intentionally mount-scoped.
  const dependenciesRef = useRef(dependencies);
  const stableDependencies = dependenciesRef.current;
  const [hadSavedApiSettings] = useState(() =>
    (
      stableDependencies.hasSavedApiSettings ?? hasSavedApiSettings
    )()
  );
  const [apiSettings, setApiSettings] = useState<ApiSettings>(loadApiSettings);
  const [searchSettings, setSearchSettings] =
    useState<SearchSettings>(loadSearchSettings);
  const [displaySettings, setDisplaySettings] =
    useState<DisplaySettings>(loadDisplaySettings);
  const [profileSettings, setProfileSettings] =
    useState<ProfileSettings>(loadProfileSettings);
  const [runtimeSettings, setRuntimeSettings] =
    useState<RuntimeSettingsSummary | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let cancelled = false;
    void runRuntimeSettingsLoad(
      {
        hadSavedApiSettings,
        isCancelled: () => cancelled,
        setRuntimeSettings,
        updateApiSettings: setApiSettings
      },
      stableDependencies
    );

    return () => {
      cancelled = true;
    };
  }, [hadSavedApiSettings, stableDependencies]);

  useEffect(() => {
    (stableDependencies.saveApiSettings ?? saveApiSettings)(apiSettings);
  }, [apiSettings, stableDependencies.saveApiSettings]);

  useEffect(() => {
    (stableDependencies.saveSearchSettings ?? saveSearchSettings)(searchSettings);
  }, [searchSettings, stableDependencies.saveSearchSettings]);

  useEffect(() => {
    (stableDependencies.saveDisplaySettings ?? saveDisplaySettings)(
      displaySettings
    );
  }, [displaySettings, stableDependencies.saveDisplaySettings]);

  useEffect(() => {
    (stableDependencies.saveProfileSettings ?? saveProfileSettings)(
      profileSettings
    );
  }, [profileSettings, stableDependencies.saveProfileSettings]);

  const replaceApiSettings = useCallback((settings: ApiSettings) => {
    setApiSettings(normalizeApiSettings(settings));
  }, []);
  const replaceSearchSettings = useCallback((settings: SearchSettings) => {
    setSearchSettings(normalizeSearchSettings(settings));
  }, []);
  const replaceDisplaySettings = useCallback((settings: DisplaySettings) => {
    setDisplaySettings(normalizeDisplaySettings(settings));
  }, []);
  const replaceProfileSettings = useCallback((settings: ProfileSettings) => {
    setProfileSettings(normalizeProfileSettings(settings));
  }, []);
  const updateApiSettings = useCallback(
    (updater: (current: ApiSettings) => ApiSettings) => {
      setApiSettings(updater);
    },
    []
  );
  const applyMemoryEvent = useCallback((event: MemoryStreamEvent) => {
    setApiSettings((current) => applyMemoryStreamEvent(current, event));
  }, []);

  return useMemo(
    () => ({
      apiSettings,
      searchSettings,
      displaySettings,
      profileSettings,
      runtimeSettings,
      cloudEnabled: Boolean(runtimeSettings?.cloud?.enabled),
      replaceApiSettings,
      replaceSearchSettings,
      replaceDisplaySettings,
      replaceProfileSettings,
      updateApiSettings,
      applyMemoryEvent
    }),
    [
      apiSettings,
      applyMemoryEvent,
      displaySettings,
      profileSettings,
      replaceApiSettings,
      replaceDisplaySettings,
      replaceProfileSettings,
      replaceSearchSettings,
      runtimeSettings,
      searchSettings,
      updateApiSettings
    ]
  );
}
