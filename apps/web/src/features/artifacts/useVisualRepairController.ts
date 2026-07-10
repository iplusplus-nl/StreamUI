import { useEffect, useRef, useState } from "react";
import type { ApiSettings } from "../../core/apiSettings";
import { blobToDataUrl } from "../../core/blob";
import {
  getSnapshotDiagnostics,
  renderSnapshotToPngBlob
} from "../../core/artifactExport";
import type { ImageAttachment } from "../../core/imageAttachments";
import { modelLikelySupportsImageInput } from "../../core/modelCapabilities";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";
import {
  createId,
  type SessionState
} from "../../domain/chat/sessionModel";
import type { PageThemeMode } from "../../runtime/streamui/types";
import type {
  ChatGenerationLease,
  LocalGenerationLease
} from "../chat/generationActivityCoordinator";
import type {
  StartGeneratedArtifactBatchInput,
  StartGeneratedArtifactBatchResult
} from "./generatedArtifactBatchController";
import { resolveArtifactEditRequestSettings } from "./useArtifactEditController";
import { createEphemeralVisualRepairFile } from "./visualRepairFile";
import {
  createVisualRepairController,
  type StartVisualRepairInput,
  type VisualRepairController,
  type VisualRepairOutcome
} from "./visualRepairController";

type ValueRef<T> = { current: T };

export type UseVisualRepairControllerInput = {
  sessionStateRef: ValueRef<SessionState>;
  apiSettings: ApiSettings;
  runtimeSettings: RuntimeSettingsSummary | null;
  cloudEnabled: boolean;
  authenticated: boolean;
  themeMode: PageThemeMode;
  isBusy(): boolean;
  tryAcquireLocal(ownerId: string): LocalGenerationLease | undefined;
  promoteLocalToChat(
    lease: LocalGenerationLease,
    runId: string
  ): ChatGenerationLease | undefined;
  startGeneratedBatch(
    input: StartGeneratedArtifactBatchInput
  ): StartGeneratedArtifactBatchResult;
  openAuthentication(): void;
};

export type VisualRepairViewController = {
  start(input: StartVisualRepairInput): Promise<VisualRepairOutcome>;
  cancelActive(): boolean;
  getActiveRun(): ReturnType<VisualRepairController["getActiveRun"]>;
  isRunning: boolean;
};

export function useVisualRepairController({
  sessionStateRef,
  apiSettings,
  runtimeSettings,
  cloudEnabled,
  authenticated,
  themeMode,
  isBusy,
  tryAcquireLocal,
  promoteLocalToChat,
  startGeneratedBatch,
  openAuthentication
}: UseVisualRepairControllerInput): VisualRepairViewController {
  const [running, setRunning] = useState(false);
  const mountedRef = useRef(false);
  const apiSettingsRef = useRef(apiSettings);
  const runtimeSettingsRef = useRef(runtimeSettings);
  const cloudEnabledRef = useRef(cloudEnabled);
  const authenticatedRef = useRef(authenticated);
  const themeModeRef = useRef(themeMode);
  const isBusyRef = useRef(isBusy);
  const tryAcquireLocalRef = useRef(tryAcquireLocal);
  const promoteLocalToChatRef = useRef(promoteLocalToChat);
  const startGeneratedBatchRef = useRef(startGeneratedBatch);
  const openAuthenticationRef = useRef(openAuthentication);

  apiSettingsRef.current = apiSettings;
  runtimeSettingsRef.current = runtimeSettings;
  cloudEnabledRef.current = cloudEnabled;
  authenticatedRef.current = authenticated;
  themeModeRef.current = themeMode;
  isBusyRef.current = isBusy;
  tryAcquireLocalRef.current = tryAcquireLocal;
  promoteLocalToChatRef.current = promoteLocalToChat;
  startGeneratedBatchRef.current = startGeneratedBatch;
  openAuthenticationRef.current = openAuthentication;

  const [controller] = useState<VisualRepairController>(() =>
    createVisualRepairController({
      getState: () => sessionStateRef.current,
      getThemeMode: () => themeModeRef.current,
      resolveRequestContext: (session) => {
        const requestSettings = resolveArtifactEditRequestSettings(
          session,
          apiSettingsRef.current,
          runtimeSettingsRef.current,
          cloudEnabledRef.current,
          authenticatedRef.current
        );
        return {
          model: (session.model || apiSettingsRef.current.model).trim(),
          requiresAuthentication: requestSettings.requiresAuthentication
        };
      },
      isBusy: () => isBusyRef.current(),
      tryAcquireLocal: (ownerId) =>
        tryAcquireLocalRef.current(ownerId),
      promoteLocalToChat: (lease, runId) =>
        promoteLocalToChatRef.current(lease, runId),
      startGeneratedBatch: (input) =>
        startGeneratedBatchRef.current(input),
      openAuthentication: () => openAuthenticationRef.current(),
      captureScreenshot: async (snapshot, width, activeThemeMode, assistantId) => {
        const blob = await renderSnapshotToPngBlob(snapshot, {
          themeMode: activeThemeMode,
          width
        });
        const attachment: ImageAttachment = {
          id: createId("render"),
          name: `${assistantId}-render.png`,
          mimeType: "image/png",
          size: blob.size,
          dataUrl: await blobToDataUrl(blob)
        };
        return attachment;
      },
      stageScreenshot: async (target, attachment) =>
        createEphemeralVisualRepairFile(
          attachment,
          target.assistantId
        ),
      discardScreenshot: async () => undefined,
      getDiagnostics: (snapshot, width, activeThemeMode) =>
        getSnapshotDiagnostics(snapshot, {
          exportWidth: width,
          themeMode: activeThemeMode
        }),
      supportsImageInput: modelLikelySupportsImageInput,
      createId,
      onRunningChange: (nextRunning) => {
        if (mountedRef.current) {
          setRunning(nextRunning);
        }
      },
      warn: (message, error) => console.warn(message, error)
    })
  );

  useEffect(() => {
    mountedRef.current = true;
    controller.activate();
    return () => {
      mountedRef.current = false;
      controller.dispose();
    };
  }, [controller]);

  return {
    start: controller.start,
    cancelActive: controller.cancelActive,
    getActiveRun: controller.getActiveRun,
    isRunning: running
  };
}
