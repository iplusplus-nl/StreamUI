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
  loadApiSettings?(ownerId: string | null): ApiSettings;
  saveApiSettings?(settings: ApiSettings, ownerId: string | null): void;
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
  authRequired: boolean;
  memoryOwnerId: string | null;
  selectMemoryOwner(ownerId: string | null): void;
  replaceApiSettings(settings: ApiSettings): void;
  replaceSearchSettings(settings: SearchSettings): void;
  replaceDisplaySettings(settings: DisplaySettings): void;
  replaceProfileSettings(settings: ProfileSettings): void;
  updateApiSettings(updater: (current: ApiSettings) => ApiSettings): void;
  applyMemoryEvent(
    event: MemoryStreamEvent,
    expectedOwnerId?: string | null
  ): void;
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
  const [apiSettings, setApiSettings] = useState<ApiSettings>(() =>
    (stableDependencies.loadApiSettings ?? loadApiSettings)(null)
  );
  const apiSettingsRef = useRef(apiSettings);
  const [memoryOwnerId, setMemoryOwnerId] = useState<string | null>(null);
  const memoryOwnerIdRef = useRef<string | null>(null);
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
        updateApiSettings: (updater) => {
          const next = updater(apiSettingsRef.current);
          apiSettingsRef.current = next;
          setApiSettings(next);
        }
      },
      stableDependencies
    );

    return () => {
      cancelled = true;
    };
  }, [hadSavedApiSettings, stableDependencies]);

  useEffect(() => {
    apiSettingsRef.current = apiSettings;
    (stableDependencies.saveApiSettings ?? saveApiSettings)(
      apiSettings,
      memoryOwnerId
    );
  }, [apiSettings, memoryOwnerId, stableDependencies.saveApiSettings]);

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
    const next = normalizeApiSettings(settings);
    apiSettingsRef.current = next;
    setApiSettings(next);
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
      const next = updater(apiSettingsRef.current);
      apiSettingsRef.current = next;
      setApiSettings(next);
    },
    []
  );
  const selectMemoryOwner = useCallback(
    (ownerId: string | null) => {
      if (memoryOwnerIdRef.current === ownerId) {
        return;
      }

      (stableDependencies.saveApiSettings ?? saveApiSettings)(
        apiSettingsRef.current,
        memoryOwnerIdRef.current
      );
      const scoped = (
        stableDependencies.loadApiSettings ?? loadApiSettings
      )(ownerId);
      const next = normalizeApiSettings({
        ...apiSettingsRef.current,
        userPreferencePrompt: scoped.userPreferencePrompt,
        memoryItems: scoped.memoryItems
      });
      memoryOwnerIdRef.current = ownerId;
      apiSettingsRef.current = next;
      setMemoryOwnerId(ownerId);
      setApiSettings(next);
    },
    [stableDependencies.loadApiSettings, stableDependencies.saveApiSettings]
  );
  const applyMemoryEvent = useCallback(
    (event: MemoryStreamEvent, expectedOwnerId?: string | null) => {
      if (
        expectedOwnerId !== undefined &&
        expectedOwnerId !== memoryOwnerIdRef.current
      ) {
        return;
      }
      const next = applyMemoryStreamEvent(apiSettingsRef.current, event);
      apiSettingsRef.current = next;
      setApiSettings(next);
    },
    []
  );

  return useMemo(
    () => ({
      apiSettings,
      searchSettings,
      displaySettings,
      profileSettings,
      runtimeSettings,
      cloudEnabled: Boolean(runtimeSettings?.cloud?.enabled),
      authRequired: Boolean(runtimeSettings?.cloud?.authRequired),
      memoryOwnerId,
      selectMemoryOwner,
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
      memoryOwnerId,
      profileSettings,
      replaceApiSettings,
      replaceDisplaySettings,
      replaceProfileSettings,
      replaceSearchSettings,
      runtimeSettings,
      searchSettings,
      selectMemoryOwner,
      updateApiSettings
    ]
  );
}
