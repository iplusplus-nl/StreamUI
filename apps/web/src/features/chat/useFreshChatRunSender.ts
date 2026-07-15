import { useCallback } from "react";
import type { ApiSettings } from "../../core/apiSettings";
import type { AuthUser } from "../../core/cloudAuth";
import type { ImageAttachment } from "../../core/imageAttachments";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";
import type { SearchSettings } from "../../core/searchSettings";
import {
  createId,
  summarizeSession,
  type ClientMessage,
  type SessionFile,
  type SessionState
} from "../../domain/chat/sessionModel";
import { discardUnacceptedBranchRun } from "../../domain/chat/branchRunLifecycle";
import type {
  PageThemeMode,
  StreamingRenderer
} from "../../runtime/streamui/types";
import type { SessionActionsController } from "../sessions/sessionActionsController";
import { createBrowserLocalSessionFile } from "../sessions/browserLocalWorkspace";
import {
  startBrowserDirectChatRun,
  usesBrowserDirectProvider
} from "../providers/browserDirectProvider";
import { getChatRunSessionFiles } from "./chatRunAttachmentFiles";
import type { ChatRunCancellationTarget } from "./chatRunCancellationController";
import type { ChatRunExecutionController } from "./chatRunExecutionController";
import type { ChatRunRuntimeRegistry } from "./chatRunRuntimeRegistry";
import { loadChatRunServerMessage } from "./chatRunServerMessage";
import type {
  ChatRunAssistantPhase,
  PendingManagedRequest,
  SendStreamUiRequest,
  SendStreamUiRequestOptions
} from "./chatRunRequest";
import { isManagedRequestReplaySafe } from "./chatRunRequest";
import type { SequencedMemoryStreamEvent } from "./chatStreamEvents";
import {
  createFreshChatRunMessagePlan,
  resolveFreshChatRunSettings
} from "./freshChatRunPlan";
import { runFreshChatRun } from "./freshChatRunController";
import type { GenerationActivityCoordinator } from "./generationActivityCoordinator";
import {
  pinManagedRequestToSession,
  queueManagedAuthRequest
} from "./managedAuthContinuation";
import type { PendingRequestSlot } from "./pendingRequestSlot";

type ValueRef<T> = { current: T };

export type UseFreshChatRunSenderInput = {
  activeSessionIdRef: ValueRef<string>;
  sessionStateRef: ValueRef<SessionState>;
  sessionClientIdRef: ValueRef<string>;
  transientEmptySessionIdRef: ValueRef<string | null>;
  runConnectionsRef: ValueRef<Map<string, AbortController>>;
  renderersRef: ValueRef<Map<string, StreamingRenderer>>;
  apiSettings: ApiSettings;
  searchSettings: SearchSettings;
  runtimeSettings: RuntimeSettingsSummary | null;
  themeMode: PageThemeMode;
  cloudEnabled: boolean;
  authenticatedUser: AuthUser | null;
  generationActivity: GenerationActivityCoordinator;
  chatRunRuntimeRegistry: ChatRunRuntimeRegistry<ChatRunExecutionController>;
  pendingManagedRequestSlot: PendingRequestSlot<PendingManagedRequest>;
  openAuthOverlay(): void;
  refreshAuthSummary(): unknown | Promise<unknown>;
  handleMemoryStreamEvent(event: SequencedMemoryStreamEvent): void;
  updateAssistantMessageInSession(
    sessionId: string,
    assistantId: string,
    updater: (message: ClientMessage) => ClientMessage
  ): boolean;
  updateSessionById: SessionActionsController["updateSessionById"];
  upsertSessionFiles(sessionId: string, files: SessionFile[]): void;
};

function getCanvasContext() {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const messageListWidth =
    document.querySelector<HTMLElement>(".message-list")?.clientWidth ??
    viewportWidth;
  const horizontalInset = viewportWidth <= 720 ? 32 : 48;
  const canvasWidth = Math.min(
    900,
    Math.max(280, messageListWidth - horizontalInset)
  );
  const initialCanvasHeight = Math.round(
    Math.min(640, Math.max(260, canvasWidth * 0.62))
  );

  return {
    viewportWidth,
    viewportHeight,
    canvasWidth: Math.round(canvasWidth),
    initialCanvasHeight,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

export function useFreshChatRunSender({
  activeSessionIdRef,
  sessionStateRef,
  sessionClientIdRef,
  transientEmptySessionIdRef,
  runConnectionsRef,
  renderersRef,
  apiSettings,
  searchSettings,
  runtimeSettings,
  themeMode,
  cloudEnabled,
  authenticatedUser,
  generationActivity,
  chatRunRuntimeRegistry,
  pendingManagedRequestSlot,
  openAuthOverlay,
  refreshAuthSummary,
  handleMemoryStreamEvent,
  updateAssistantMessageInSession,
  updateSessionById,
  upsertSessionFiles
}: UseFreshChatRunSenderInput): SendStreamUiRequest {
  return useCallback(
    async (
      text: string,
      attachments: ImageAttachment[] = [],
      options: SendStreamUiRequestOptions = {}
    ) => {
      const trimmed = text.trim();
      if (
        (!trimmed && attachments.length === 0) ||
        (!options.chatActivityLease && generationActivity.isBusy())
      ) {
        return;
      }

      const requestedSessionId = options.targetSessionId?.trim();
      const requestSessionId = requestedSessionId || activeSessionIdRef.current;
      const requestSessionForModel = sessionStateRef.current.sessions.find(
        (session) => session.id === requestSessionId
      );
      if (
        !requestSessionForModel ||
        (options.validateRequestSession &&
          !options.validateRequestSession(requestSessionForModel))
      ) {
        return;
      }
      const settingsPlan = resolveFreshChatRunSettings({
        session: requestSessionForModel,
        sessionId: requestSessionId,
        attachments,
        apiSettings,
        runtimeSettings
      });
      if (!settingsPlan.ok) {
        console.warn(settingsPlan.warning);
        return;
      }
      const {
        requestModel,
        requestReasoningEffort,
        requestUiComplexity,
        requestApiSettings
      } = settingsPlan;
      const browserDirect = usesBrowserDirectProvider(requestApiSettings);
      if (
        requestApiSettings.apiKeySource === "managed" &&
        cloudEnabled &&
        !authenticatedUser
      ) {
        if (!isManagedRequestReplaySafe(options)) {
          options.chatActivityLease?.release();
          openAuthOverlay();
          return;
        }
        queueManagedAuthRequest(
          pendingManagedRequestSlot,
          pinManagedRequestToSession(
            { text, attachments, options },
            requestSessionId
          ),
          openAuthOverlay
        );
        return;
      }
      const messagePlan = createFreshChatRunMessagePlan({
        text,
        attachments,
        options,
        session: requestSessionForModel,
        createId
      });
      if (!messagePlan.ok) {
        console.warn(messagePlan.warning);
        return;
      }
      const {
        appendUserMessage,
        assistantId,
        generationRunId,
        preparedAttachmentFiles,
        userMessage,
        assistantMessage
      } = messagePlan;
      const reduceAssistantPatch = (
        current: ClientMessage,
        patch: Partial<ClientMessage>,
        phase: ChatRunAssistantPhase
      ) =>
        options.reduceAssistantPatch?.(current, patch, phase) ?? {
          ...current,
          ...patch
        };
      const updateAssistantForPhase = (
        patch: Partial<ClientMessage>,
        phase: ChatRunAssistantPhase = "streaming"
      ) => {
        const changed = updateAssistantMessageInSession(
          requestSessionId,
          assistantId,
          (message) => reduceAssistantPatch(message, patch, phase)
        );
        if (changed) {
          options.onAssistantPhaseApplied?.(phase);
        }
        return changed;
      };
      const chatActivityLease =
        options.chatActivityLease ??
        generationActivity.tryAcquireChatRun(generationRunId);
      if (!chatActivityLease) {
        return;
      }
      const runTarget: ChatRunCancellationTarget = {
        runId: generationRunId,
        sessionId: requestSessionId,
        assistantId
      };
      const runtimeRegistration =
        chatRunRuntimeRegistry.registerFresh(runTarget);

      const discardUnacceptedBranchVariant = () => {
        updateSessionById(requestSessionId, (session) => {
          const next = discardUnacceptedBranchRun(session, runTarget);
          return next === session
            ? session
            : { ...next, title: summarizeSession(next.messages) };
        });
      };

      await runFreshChatRun({
        sessionId: requestSessionId,
        plan: messagePlan,
        sendOptions: options,
        requestApiSettings,
        searchSettings,
        themeMode,
        activityLease: chatActivityLease,
        runtimeRegistration,
        connections: runConnectionsRef.current,
        renderers: renderersRef.current,
        initializeSession: () => {
          if (transientEmptySessionIdRef.current === requestSessionId) {
            transientEmptySessionIdRef.current = null;
          }
          updateSessionById(requestSessionId, (session) => {
            const nextMessages = options.insertMessages
              ? options.insertMessages(
                  session.messages,
                  userMessage,
                  assistantMessage
                )
              : appendUserMessage
                ? [...session.messages, userMessage, assistantMessage]
                : [...session.messages, assistantMessage];
            const branchSelections = options.branchSelection
              ? {
                  ...(session.branchSelections ?? {}),
                  [options.branchSelection.groupId]:
                    options.branchSelection.variantId
                }
              : session.branchSelections;

            return {
              ...session,
              title: summarizeSession(nextMessages),
              updatedAt: Date.now(),
              model: requestModel || session.model,
              reasoningEffort: requestReasoningEffort,
              uiComplexity: requestUiComplexity,
              branchSelections,
              messages: nextMessages,
              files: getChatRunSessionFiles(
                session.files,
                preparedAttachmentFiles
              )
            };
          });
        },
        discardUnacceptedRun: discardUnacceptedBranchVariant,
        updateAssistant: updateAssistantForPhase,
        onMemory: handleMemoryStreamEvent,
        loadServerMessage: () =>
          browserDirect
            ? Promise.resolve(undefined)
            : loadChatRunServerMessage({
                clientId: sessionClientIdRef.current,
                sessionId: requestSessionId,
                assistantId
              }),
        getClientId: () => sessionClientIdRef.current,
        getSessionFiles: () =>
          sessionStateRef.current.sessions.find(
            (session) => session.id === requestSessionId
          )?.files ?? [],
        getCanvasContext,
        upsertSessionFiles: (files) =>
          upsertSessionFiles(requestSessionId, files),
        refreshManagedAuth: refreshAuthSummary,
        startRequest: browserDirect ? startBrowserDirectChatRun : undefined,
        uploadArtifactFile: browserDirect
          ? async (_sessionId, input) => createBrowserLocalSessionFile(input)
          : undefined,
        scheduleInterval: browserDirect
          ? () => () => undefined
          : undefined
      });
    },
    [
      apiSettings,
      authenticatedUser,
      cloudEnabled,
      generationActivity,
      handleMemoryStreamEvent,
      openAuthOverlay,
      pendingManagedRequestSlot,
      refreshAuthSummary,
      chatRunRuntimeRegistry,
      runtimeSettings,
      searchSettings,
      themeMode,
      updateAssistantMessageInSession,
      updateSessionById,
      upsertSessionFiles
    ]
  );
}
