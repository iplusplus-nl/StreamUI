import { useEffect, useRef, useState } from "react";
import {
  normalizeApiSettings,
  normalizeUiComplexity,
  serializeApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";
import {
  createId,
  type ChatSession,
  type ClientMessage,
  type SessionState
} from "../../domain/chat/sessionModel";
import type { PageThemeMode } from "../../runtime/streamui/types";
import { isAbortError, sanitizeChatErrorMessage } from "../chat/chatErrors";
import { coerceApiSettingsForRuntime } from "../settings/appSettingsPolicy";
import { requestArtifactEdit } from "./artifactEditApi";
import {
  createArtifactEditController,
  type ArtifactEditBusyLease,
  type ArtifactEditController,
  type ArtifactEditControllerDependencies,
  type ArtifactEditMutationOutcome,
  type ArtifactEditRequestSettings,
  type ArtifactEditTarget
} from "./artifactEditController";

type ValueRef<T> = { current: T };

export type UseArtifactEditControllerInput = {
  sessionStateRef: ValueRef<SessionState>;
  activeSessionIdRef: ValueRef<string>;
  sessionClientIdRef: ValueRef<string>;
  apiSettings: ApiSettings;
  runtimeSettings: RuntimeSettingsSummary | null;
  cloudEnabled: boolean;
  authenticated: boolean;
  themeMode: PageThemeMode;
  isBusy(): boolean;
  mutateMessage(
    target: ArtifactEditTarget,
    updater: (message: ClientMessage) => ClientMessage
  ): ArtifactEditMutationOutcome;
  tryAcquireBusy(ownerId: string): ArtifactEditBusyLease | undefined;
  clearSelections(target: ArtifactEditTarget): void;
  openAuthentication(): void;
  saveNow(): void;
  refreshAuthentication(): Promise<unknown>;
  dependencies?: Partial<ArtifactEditControllerDependencies>;
};

export type ArtifactEditViewController = Omit<
  ArtifactEditController,
  "activate" | "isRunning"
> & {
  isRunning: boolean;
};

export function resolveArtifactEditRequestSettings(
  session: ChatSession,
  apiSettings: ApiSettings,
  runtimeSettings: RuntimeSettingsSummary | null,
  cloudEnabled: boolean,
  authenticated: boolean
): ArtifactEditRequestSettings {
  const requestApiSettings = coerceApiSettingsForRuntime(
    normalizeApiSettings({
      ...apiSettings,
      model: (session.model || apiSettings.model).trim(),
      reasoningEffort:
        session.reasoningEffort ?? apiSettings.reasoningEffort,
      uiComplexity: normalizeUiComplexity(
        session.uiComplexity ?? apiSettings.uiComplexity
      )
    }),
    runtimeSettings
  );
  const managed = requestApiSettings.apiKeySource === "managed";

  return {
    apiSettings: serializeApiSettings(requestApiSettings),
    managed,
    requiresAuthentication: managed && cloudEnabled && !authenticated
  };
}

function browserDependencies(): ArtifactEditControllerDependencies {
  return {
    requestEdit: requestArtifactEdit,
    createEditId: () => createId("artifact-edit"),
    createVariantId: () => createId("artifact-edit-variant"),
    createOperationId: () => createId("artifact-edit-operation"),
    now: Date.now,
    isAbortError,
    sanitizeError: (error, fallback) =>
      error instanceof Error
        ? sanitizeChatErrorMessage(error.message, fallback)
        : fallback
  };
}

export function useArtifactEditController({
  sessionStateRef,
  activeSessionIdRef,
  sessionClientIdRef,
  apiSettings,
  runtimeSettings,
  cloudEnabled,
  authenticated,
  themeMode,
  isBusy,
  mutateMessage,
  tryAcquireBusy,
  clearSelections,
  openAuthentication,
  saveNow,
  refreshAuthentication,
  dependencies = {}
}: UseArtifactEditControllerInput): ArtifactEditViewController {
  const [running, setRunning] = useState(false);
  const apiSettingsRef = useRef(apiSettings);
  const runtimeSettingsRef = useRef(runtimeSettings);
  const cloudEnabledRef = useRef(cloudEnabled);
  const authenticatedRef = useRef(authenticated);
  const themeModeRef = useRef(themeMode);
  const isBusyRef = useRef(isBusy);
  const mutateMessageRef = useRef(mutateMessage);
  const tryAcquireBusyRef = useRef(tryAcquireBusy);
  const clearSelectionsRef = useRef(clearSelections);
  const openAuthenticationRef = useRef(openAuthentication);
  const saveNowRef = useRef(saveNow);
  const refreshAuthenticationRef = useRef(refreshAuthentication);
  const dependenciesRef = useRef(dependencies);

  apiSettingsRef.current = apiSettings;
  runtimeSettingsRef.current = runtimeSettings;
  cloudEnabledRef.current = cloudEnabled;
  authenticatedRef.current = authenticated;
  themeModeRef.current = themeMode;
  isBusyRef.current = isBusy;
  mutateMessageRef.current = mutateMessage;
  tryAcquireBusyRef.current = tryAcquireBusy;
  clearSelectionsRef.current = clearSelections;
  openAuthenticationRef.current = openAuthentication;
  saveNowRef.current = saveNow;
  refreshAuthenticationRef.current = refreshAuthentication;

  const [controller] = useState(() =>
    createArtifactEditController(
      {
        isBusy: () => isBusyRef.current(),
        getActiveSessionId: () => activeSessionIdRef.current,
        getSessionState: () => sessionStateRef.current,
        resolveRequestSettings: (session) =>
          resolveArtifactEditRequestSettings(
            session,
            apiSettingsRef.current,
            runtimeSettingsRef.current,
            cloudEnabledRef.current,
            authenticatedRef.current
          ),
        getClientId: () => sessionClientIdRef.current,
        getThemeMode: () => themeModeRef.current,
        mutateMessage: (target, updater) =>
          mutateMessageRef.current(target, updater),
        tryAcquireBusy: (ownerId) => {
          const lease = tryAcquireBusyRef.current(ownerId);
          if (!lease) {
            return undefined;
          }

          let released = false;
          setRunning(true);
          return {
            release() {
              if (released) {
                return;
              }
              released = true;
              lease.release();
              setRunning(false);
            }
          };
        },
        clearSelections: (target) => clearSelectionsRef.current(target),
        openAuthentication: () => openAuthenticationRef.current(),
        saveNow: () => saveNowRef.current(),
        refreshAuthentication: async () => {
          await refreshAuthenticationRef.current();
        },
        warn: (message, error) => console.warn(message, error)
      },
      {
        ...browserDependencies(),
        ...dependenciesRef.current
      }
    )
  );

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  return {
    runSourceEdit: controller.runSourceEdit,
    regenerate: controller.regenerate,
    editPrompt: controller.editPrompt,
    cancelActive: controller.cancelActive,
    dispose: controller.dispose,
    isRunning: running
  };
}
