import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage
} from "@assistant-ui/react";
import { ChatShell } from "./components/ChatShell";
import { BugReportDialog } from "./components/BugReportDialog";
import { SessionSidebar } from "./components/SessionSidebar";
import { createId } from "./domain/chat/sessionModel";
import { useChatRunCancellation } from "./features/chat/useChatRunCancellation";
import { createChatRunReconnectScheduler } from "./features/chat/chatRunReconnectScheduler";
import type { ChatRunExecutionController } from "./features/chat/chatRunExecutionController";
import { createChatRunRuntimeRegistry } from "./features/chat/chatRunRuntimeRegistry";
import type { PendingManagedRequest } from "./features/chat/chatRunRequest";
import { createBranchTurnPlan } from "./features/chat/branchTurnPlanner";
import {
  createMessageRevisionController,
  type MessageRevisionBranchInput
} from "./features/chat/messageRevisionController";
import { createGenerationActivityCoordinator } from "./features/chat/generationActivityCoordinator";
import {
  convertMessage,
  getAppendMessageImages,
  getAppendMessageText
} from "./features/chat/assistantRuntimeAdapter";
import { createPendingRequestSlot } from "./features/chat/pendingRequestSlot";
import {
  openManualAuth,
  replayManagedAuthRequest
} from "./features/chat/managedAuthContinuation";
import { StreamThread } from "./features/chat/ui/StreamThread";
import { useBugReportController } from "./features/bug-reports/useBugReportController";
import {
  getAssistantForUserTurn
} from "./features/chat/branching";
import {
  loadSessionClientId
} from "./features/sessions/sessionPersistence";
import { useSessionSync } from "./features/sessions/useSessionSync";
import { useSessionSave } from "./features/sessions/useSessionSave";
import { useSessionIndex } from "./features/sessions/useSessionIndex";
import { useSessionActions } from "./features/sessions/useSessionActions";
import { useSessionAttachmentController } from "./features/sessions/useSessionAttachmentController";
import { useSessionStateController } from "./features/sessions/useSessionStateController";
import { useSessionMessageMutations } from "./features/sessions/useSessionMessageMutations";
import { useSessionViewModel } from "./features/sessions/useSessionViewModel";
import {
  useGeneratedArtifactBatchRecovery,
  useStaleArtifactEditSweep
} from "./features/sessions/useSessionMaintenance";
import { useFreshChatRunSender } from "./features/chat/useFreshChatRunSender";
import { useRestoredChatRuns } from "./features/chat/useRestoredChatRuns";
import { useArtifactSelections } from "./features/artifacts/useArtifactSelections";
import { isArtifactSelectionTargetActive } from "./features/artifacts/artifactSelectionController";
import { useArtifactActions } from "./features/artifacts/useArtifactActions";
import { useArtifactEditController } from "./features/artifacts/useArtifactEditController";
import { useArtifactEditSelection } from "./features/artifacts/useArtifactEditSelection";
import { createGeneratedArtifactBatchController } from "./features/artifacts/generatedArtifactBatchController";
import { useVisualRepairController } from "./features/artifacts/useVisualRepairController";
import {
  replayPendingVisualRepair,
  startVisualRepairWithAuthContinuation
} from "./features/artifacts/visualRepairAuthContinuation";
import type { StartVisualRepairInput } from "./features/artifacts/visualRepairController";
import type { ArtifactEditTarget } from "./features/artifacts/artifactEditController";
import { useAppSettings } from "./features/settings/useAppSettings";
import { usePersistentThemeMode } from "./features/settings/usePersistentThemeMode";
import { useSessionRunSettings } from "./features/settings/useSessionRunSettings";
import { useCloudAuthController } from "./features/auth/useCloudAuthController";
import type {
  RenderSnapshot,
  StreamingRenderer
} from "./runtime/streamui/types";

const SESSION_SYNC_INTERVAL_MS = 4_000;
const SESSION_SAVE_DEBOUNCE_MS = 350;

export default function App() {
  const {
    sessionState,
    sessionsLoaded,
    sessionsHydrated,
    sessionStateRef,
    activeSessionIdRef,
    sessionsLoadedRef,
    sessionsHydratedRef,
    deletedSessionIdsRef,
    transientEmptySessionIdRef,
    replaceState: setSessionStateAndRef,
    setSessionsLoaded,
    setSessionsHydrated
  } = useSessionStateController();
  const [themeMode, setThemeMode] = usePersistentThemeMode();
  const {
    apiSettings,
    searchSettings,
    displaySettings,
    profileSettings,
    runtimeSettings,
    cloudEnabled,
    replaceApiSettings: handleApiSettingsChange,
    replaceSearchSettings: handleSearchSettingsChange,
    replaceDisplaySettings: handleDisplaySettingsChange,
    replaceProfileSettings: handleProfileSettingsChange,
    updateApiSettings,
    applyMemoryEvent: handleMemoryStreamEvent
  } = useAppSettings();
  const {
    user: authenticatedUser,
    open: openAuthOverlay,
    close: closeAuthOverlay,
    updateUser: handleAuthUserChange,
    refresh: refreshAuthSummary,
    logout: logoutCloudAccount
  } = useCloudAuthController({ cloudEnabled });
  const [isSending, setIsSending] = useState(false);
  const {
    activeSession,
    messages,
    sessionItems,
    getBranchInfo,
    activeFiles,
    isActiveSessionSending
  } = useSessionViewModel(sessionState);
  const sessionClientIdRef = useRef(loadSessionClientId());
  const isSendingRef = useRef(isSending);
  const sessionNewOrDeleteBlockedRef = useRef(isSending);
  const sessionSelectionBlockedRef = useRef(false);
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());
  const runConnectionsRef = useRef<Map<string, AbortController>>(new Map());
  const cancelledRunIdsRef = useRef<Set<string>>(new Set());
  const [chatRunRuntimeRegistry] = useState(() =>
    createChatRunRuntimeRegistry<ChatRunExecutionController>()
  );
  const [generationActivity] = useState(() =>
    createGenerationActivityCoordinator({
      onBusyChange: (busy) => {
        isSendingRef.current = busy;
        setIsSending(busy);
      }
    })
  );
  const [restoredRunReconnectScheduler] = useState(() =>
    createChatRunReconnectScheduler({
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (timer) => window.clearTimeout(timer as number)
    })
  );
  const [pendingManagedRequestSlot] = useState(
    () => createPendingRequestSlot<PendingManagedRequest>(),
  );
  const [pendingVisualRepairSlot] = useState(
    () => createPendingRequestSlot<StartVisualRepairInput>()
  );
  const {
    getSelections: getArtifactSelections,
    changeSelections: handleArtifactSelectionsChange,
    clearSelections: clearArtifactSelections,
    clearSelectionsForMessage: clearArtifactSelectionsForMessage,
    selectionClearVersion: artifactSelectionClearVersion,
    selectionClearMessageId: artifactSelectionClearMessageId
  } = useArtifactSelections();
  const {
    adapter: attachmentAdapter,
    isSendBlocked: isAttachmentSendBlocked,
    hasComposerDrafts: hasComposerAttachmentDrafts
  } = useSessionAttachmentController({
    activeSessionIdRef,
    sessionClientIdRef
  });
  sessionNewOrDeleteBlockedRef.current =
    isSending || hasComposerAttachmentDrafts;
  sessionSelectionBlockedRef.current = hasComposerAttachmentDrafts;
  const handleAuthOverlayRequest = useCallback(() => {
    pendingVisualRepairSlot.clear();
    openManualAuth(pendingManagedRequestSlot, openAuthOverlay);
  }, [openAuthOverlay, pendingManagedRequestSlot, pendingVisualRepairSlot]);
  const handleLogout = useCallback(async () => {
    try {
      await logoutCloudAccount();
    } finally {
      pendingManagedRequestSlot.clear();
      pendingVisualRepairSlot.clear();
    }
  }, [logoutCloudAccount, pendingManagedRequestSlot, pendingVisualRepairSlot]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

  useEffect(() => {
    restoredRunReconnectScheduler.activate();
    return () => {
      runConnectionsRef.current.forEach((controller) => controller.abort());
      runConnectionsRef.current.clear();
      cancelledRunIdsRef.current.clear();
      restoredRunReconnectScheduler.dispose();
      generationActivity.reset();
    };
  }, [generationActivity, restoredRunReconnectScheduler]);

  useEffect(() => {
    if (!cloudEnabled) {
      pendingManagedRequestSlot.clear();
      pendingVisualRepairSlot.clear();
    }
  }, [cloudEnabled, pendingManagedRequestSlot, pendingVisualRepairSlot]);

  const sessionListPreview = useSessionIndex({
    sessionState,
    sessionsHydrated,
    sessionClientIdRef,
    sessionsHydratedRef
  });

  useSessionSync({
    sessionsLoaded,
    intervalMs: SESSION_SYNC_INTERVAL_MS,
    sessionClientIdRef,
    sessionStateRef,
    sessionsLoadedRef,
    sessionsHydratedRef,
    deletedSessionIdsRef,
    transientEmptySessionIdRef,
    runConnectionsRef,
    cancelledRunIdsRef,
    attachmentDraftsRef: sessionSelectionBlockedRef,
    updateState: setSessionStateAndRef,
    setSessionsLoaded,
    setSessionsHydrated
  });

  useStaleArtifactEditSweep(sessionsLoaded, setSessionStateAndRef);

  const saveCurrentSessionStateNow = useSessionSave({
    sessionState,
    sessionsLoaded,
    debounceMs: SESSION_SAVE_DEBOUNCE_MS,
    sessionStateRef,
    sessionsLoadedRef,
    sessionClientIdRef,
    deletedSessionIdsRef
  });

  useGeneratedArtifactBatchRecovery({
    sessions: sessionState.sessions,
    sessionsLoaded,
    sessionStateRef,
    cancelledRunIdsRef,
    themeMode,
    replaceState: setSessionStateAndRef,
    saveNow: saveCurrentSessionStateNow
  });

  const {
    updateActiveSession,
    updateSessionById,
    createNewSession: handleNewSession,
    selectSession: handleSelectSession,
    deleteSession: handleDeleteSession
  } = useSessionActions({
    sessionStateRef,
    isNewOrDeleteBlockedRef: sessionNewOrDeleteBlockedRef,
    isSelectionBlockedRef: sessionSelectionBlockedRef,
    transientEmptySessionIdRef,
    deletedSessionIdsRef,
    replaceState: setSessionStateAndRef,
    saveNow: saveCurrentSessionStateNow,
    defaultModel: apiSettings.model,
    defaultReasoningEffort: apiSettings.reasoningEffort,
    defaultUiComplexity: apiSettings.uiComplexity
  });

  const {
    model: activeSessionModel,
    reasoningEffort: activeSessionReasoningEffort,
    uiComplexity: activeSessionUiComplexity,
    selectableModels,
    changeModel: handleModelChange,
    changeReasoningEffort: handleReasoningEffortChange,
    changeUiComplexity: handleUiComplexityChange
  } = useSessionRunSettings({
    session: activeSession,
    apiSettings,
    updateApiSettings,
    updateActiveSession
  });

  const {
    session: bugReportSession,
    draft: bugReportDraft,
    isOpen: isBugReportOpen,
    isSubmitting: isBugReportSubmitting,
    isSubmitted: isBugReportSubmitted,
    captureError: bugReportCaptureError,
    submitError: bugReportSubmitError,
    open: handleBugReportOpen,
    changeDraft: handleBugReportDraftChange,
    close: handleBugReportClose,
    submit: handleBugReportSubmit
  } = useBugReportController({
    sessionState,
    sessionStateRef,
    activeSessionIdRef,
    sessionClientIdRef,
    updateSessionById,
    saveNow: saveCurrentSessionStateNow
  });

  const {
    upsertSessionFiles,
    updateAssistantMessage,
    updateAssistantMessageInSession,
    mutateArtifactEditMessage,
    appendRuntimeError: handleRuntimeError
  } = useSessionMessageMutations(setSessionStateAndRef);

  const clearArtifactSelectionsForTarget = useCallback(
    (target: ArtifactEditTarget) => {
      if (
        !isArtifactSelectionTargetActive(
          activeSessionIdRef.current,
          target.sessionId
        )
      ) {
        return;
      }
      clearArtifactSelectionsForMessage(target.assistantId);
    },
    [clearArtifactSelectionsForMessage]
  );

  const {
    runSourceEdit: runArtifactSourceEdit,
    regenerate: regenerateArtifactEditNode,
    editPrompt: handleEditArtifactEditPrompt,
    cancelActive: cancelActiveArtifactEdit,
    isRunning: isLocalArtifactEditRunning
  } = useArtifactEditController({
    sessionStateRef,
    activeSessionIdRef,
    sessionClientIdRef,
    apiSettings,
    runtimeSettings,
    cloudEnabled,
    authenticated: Boolean(authenticatedUser),
    themeMode,
    isBusy: generationActivity.isBusy,
    mutateMessage: mutateArtifactEditMessage,
    tryAcquireBusy: generationActivity.tryAcquireLocal,
    clearSelections: clearArtifactSelectionsForTarget,
    openAuthentication: openAuthOverlay,
    saveNow: saveCurrentSessionStateNow,
    refreshAuthentication: refreshAuthSummary
  });

  const handleSelectBranch = useCallback(
    (groupId: string, variantId: string) => {
      updateActiveSession((session) => ({
        ...session,
        branchSelections: {
          ...(session.branchSelections ?? {}),
          [groupId]: variantId
        },
        updatedAt: Date.now()
      }));
      clearArtifactSelections();
    },
    [clearArtifactSelections, updateActiveSession]
  );

  const sendStreamUiRequest = useFreshChatRunSender({
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
  });

  const startBranchedTurn = useCallback(
    ({
      session,
      visibleMessages,
      userIndex,
      assistantId,
      nextUserContent,
      attachments = [],
      appendUserMessage = true,
      userMessagePatch,
      assistantPatch,
      initialReasoning,
      requestHistory,
      preserveFollowingMessages = false
    }: MessageRevisionBranchInput) => {
      if (generationActivity.isBusy()) {
        return;
      }

      const activeUser = visibleMessages[userIndex];
      if (!activeUser || activeUser.role !== "user") {
        return;
      }

      const activeAssistant = assistantId
        ? visibleMessages.find((message) => message.id === assistantId)
        : getAssistantForUserTurn(visibleMessages, userIndex);
      const plan = createBranchTurnPlan(
        {
          session,
          visibleMessages,
          userIndex,
          activeUser,
          activeAssistant,
          appendUserMessage,
          userMessagePatch,
          assistantPatch,
          preserveFollowingMessages
        },
        createId
      );

      void sendStreamUiRequest(nextUserContent, attachments, {
        ...plan,
        initialReasoning,
        targetSessionId: session.id,
        requestHistory: requestHistory ?? plan.requestHistory
      });
    },
    [generationActivity, sendStreamUiRequest]
  );

  const generatedArtifactBatchController = useMemo(
    () =>
      createGeneratedArtifactBatchController({
        getState: () => sessionStateRef.current,
        isBusy: generationActivity.isBusy,
        sendRequest: sendStreamUiRequest,
        saveNow: saveCurrentSessionStateNow,
        themeMode
      }),
    [
      generationActivity,
      saveCurrentSessionStateNow,
      sendStreamUiRequest,
      themeMode
    ]
  );

  const startGeneratedArtifactBatch = generatedArtifactBatchController.start;

  const {
    start: startVisualRepair,
    cancelActive: cancelActiveVisualRepair,
    getActiveRun: getActiveVisualRepairRun,
    isRunning: isVisualRepairRunning
  } = useVisualRepairController({
    sessionStateRef,
    apiSettings,
    runtimeSettings,
    cloudEnabled,
    authenticated: Boolean(authenticatedUser),
    themeMode,
    isBusy: generationActivity.isBusy,
    tryAcquireLocal: generationActivity.tryAcquireLocal,
    promoteLocalToChat: generationActivity.promoteLocalToChat,
    startGeneratedBatch: startGeneratedArtifactBatch,
    openAuthentication: openAuthOverlay
  });

  const handleVisualRepairAssistant = useCallback(
    (assistantId: string, snapshot: RenderSnapshot, width: number) => {
      const request: StartVisualRepairInput = {
        sessionId: activeSessionIdRef.current,
        assistantId,
        snapshot,
        width
      };
      pendingVisualRepairSlot.clear();
      void startVisualRepairWithAuthContinuation(
        request,
        startVisualRepair,
        pendingVisualRepairSlot
      ).catch((error) => {
        console.warn("Could not start visual artifact repair.", error);
      });
    },
    [pendingVisualRepairSlot, startVisualRepair]
  );

  useEffect(() => {
    if (!authenticatedUser || isSending) {
      return;
    }
    if (pendingVisualRepairSlot.peek()) {
      closeAuthOverlay();
    }
    replayPendingVisualRepair(
      pendingVisualRepairSlot,
      startVisualRepair,
      (message, error) => console.warn(message, error)
    );
  }, [
    authenticatedUser,
    closeAuthOverlay,
    isSending,
    pendingVisualRepairSlot,
    startVisualRepair
  ]);

  const handleCancelRun = useChatRunCancellation({
    sessionStateRef,
    activeSessionIdRef,
    sessionClientIdRef,
    cancelledRunIdsRef,
    runConnectionsRef,
    themeMode,
    runtimeRegistry: chatRunRuntimeRegistry,
    reconnectScheduler: restoredRunReconnectScheduler,
    generationActivity,
    updateState: setSessionStateAndRef,
    saveNow: saveCurrentSessionStateNow,
    cancelActiveArtifactEdit,
    cancelActiveVisualRepair,
    getActiveVisualRepairRun
  });

  const messageRevisionController = useMemo(
    () =>
      createMessageRevisionController({
        getState: () => sessionStateRef.current,
        getActiveSessionId: () => activeSessionIdRef.current,
        regenerateArtifactEdit: regenerateArtifactEditNode,
        startGeneratedArtifactBatch,
        startVisualRepair: handleVisualRepairAssistant,
        startBranchedTurn
      }),
    [
      handleVisualRepairAssistant,
      regenerateArtifactEditNode,
      startBranchedTurn,
      startGeneratedArtifactBatch
    ]
  );
  const handleRegenerateAssistant =
    messageRevisionController.regenerateAssistant;
  const handleEditUserMessage = messageRevisionController.editUserMessage;

  const sendArtifactActionMessage = useCallback(
    (text: string, targetSessionId: string) => {
      void sendStreamUiRequest(text, [], { targetSessionId });
    },
    [sendStreamUiRequest]
  );
  const handleArtifactAction = useArtifactActions({
    isSending,
    isSendingRef,
    sessionStateRef,
    sendActionMessage: sendArtifactActionMessage
  });

  useRestoredChatRuns({
    sessionsLoaded,
    sessions: sessionState.sessions,
    sessionStateRef,
    sessionClientIdRef,
    runConnectionsRef,
    renderersRef,
    themeMode,
    generationActivity,
    chatRunRuntimeRegistry,
    restoredRunReconnectScheduler,
    handleMemoryStreamEvent,
    updateAssistantMessageInSession,
    saveCurrentSessionStateNow
  });

  useEffect(() => {
    if (!cloudEnabled || !authenticatedUser || !sessionsLoaded) {
      return;
    }

    replayManagedAuthRequest(
      pendingManagedRequestSlot,
      closeAuthOverlay,
      (pending) => {
        void sendStreamUiRequest(
          pending.text,
          pending.attachments,
          pending.options
        );
      }
    );
  }, [
    authenticatedUser,
    closeAuthOverlay,
    cloudEnabled,
    pendingManagedRequestSlot,
    sendStreamUiRequest,
    sessionsLoaded
  ]);

  const handleSelectArtifactEdit = useArtifactEditSelection({
    themeMode,
    updateMessage: updateAssistantMessage,
    clearSelections: clearArtifactSelections
  });

  const handleNewMessage = useCallback(
    async (message: AppendMessage) => {
      if (
        isAttachmentSendBlocked
      ) {
        return;
      }

      const text = getAppendMessageText(message);
      const attachments = getAppendMessageImages(message);
      const artifactSelections = getArtifactSelections();
      if (artifactSelections.length > 0) {
        await runArtifactSourceEdit(text, artifactSelections, attachments);
        return;
      }

      await sendStreamUiRequest(text, attachments);
    },
    [
      isAttachmentSendBlocked,
      getArtifactSelections,
      runArtifactSourceEdit,
      sendStreamUiRequest
    ]
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning:
      isActiveSessionSending ||
      isLocalArtifactEditRunning ||
      isVisualRepairRunning,
    isSendDisabled:
      isSending ||
      isAttachmentSendBlocked,
    convertMessage,
    onNew: handleNewMessage,
    onCancel: handleCancelRun,
    adapters: {
      attachments: attachmentAdapter
    }
  });

  const sidebarPreview =
    !sessionsLoaded && sessionListPreview ? sessionListPreview : null;
  const sidebarSessionItems = sidebarPreview?.sessions ?? sessionItems;
  const sidebarActiveSessionId =
    sidebarPreview?.activeSessionId ?? sessionState.activeSessionId;
  return (
    <>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatShell
          themeMode={themeMode}
          onThemeModeChange={setThemeMode}
          sidebar={
            <SessionSidebar
              sessions={sidebarSessionItems}
              activeSessionId={sidebarActiveSessionId}
              isSending={isSending || hasComposerAttachmentDrafts}
              isSessionSelectionBlocked={hasComposerAttachmentDrafts}
              themeMode={themeMode}
              apiSettings={apiSettings}
              searchSettings={searchSettings}
              displaySettings={displaySettings}
              profileSettings={profileSettings}
              runtimeSettings={runtimeSettings}
              cloudEnabled={cloudEnabled}
              authUser={authenticatedUser}
              onNewSession={handleNewSession}
              onSelectSession={handleSelectSession}
              onDeleteSession={handleDeleteSession}
              onApiSettingsChange={handleApiSettingsChange}
              onSearchSettingsChange={handleSearchSettingsChange}
              onDisplaySettingsChange={handleDisplaySettingsChange}
              onProfileSettingsChange={handleProfileSettingsChange}
              onAuthUserChange={handleAuthUserChange}
              onLoginRequest={handleAuthOverlayRequest}
              onLogout={handleLogout}
              onBugReportOpen={() => void handleBugReportOpen()}
            />
          }
        >
          <StreamThread
            activeSessionId={sessionState.activeSessionId}
            messages={messages}
            files={activeFiles}
            getBranchInfo={getBranchInfo}
            themeMode={themeMode}
            showRawStream={displaySettings.showRawStream}
            artifactEditingEnabled={
              displaySettings.artifactEditingEnabled
            }
            model={activeSessionModel}
            modelOptions={selectableModels}
            reasoningEffort={activeSessionReasoningEffort}
            uiComplexity={activeSessionUiComplexity}
            artifactSelectionClearVersion={artifactSelectionClearVersion}
            artifactSelectionClearMessageId={artifactSelectionClearMessageId}
            onRuntimeError={handleRuntimeError}
            onArtifactAction={handleArtifactAction}
            onVisualRepairAssistant={handleVisualRepairAssistant}
            onRegenerateAssistant={handleRegenerateAssistant}
            onEditUserMessage={handleEditUserMessage}
            onSelectBranch={handleSelectBranch}
            onSelectArtifactEdit={handleSelectArtifactEdit}
            onEditArtifactEditPrompt={handleEditArtifactEditPrompt}
            onArtifactSelectionsChange={handleArtifactSelectionsChange}
            onModelChange={handleModelChange}
            onReasoningEffortChange={handleReasoningEffortChange}
            onUiComplexityChange={handleUiComplexityChange}
          />
        </ChatShell>
      </AssistantRuntimeProvider>
      {isBugReportOpen && bugReportSession ? (
        <BugReportDialog
          draft={bugReportDraft}
          themeMode={themeMode}
          captureError={bugReportCaptureError}
          submitError={bugReportSubmitError}
          isSubmitting={isBugReportSubmitting}
          isSubmitted={isBugReportSubmitted}
          onChange={handleBugReportDraftChange}
          onClose={handleBugReportClose}
          onSubmit={() => void handleBugReportSubmit()}
        />
      ) : null}
    </>
  );
}
