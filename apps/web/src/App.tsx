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
import {
  SessionSidebar,
  type SessionListItem,
  type ThemeMode
} from "./components/SessionSidebar";
import { AuthOverlay } from "./components/AuthOverlay";
import {
  getSelectableModelOptions,
  normalizeApiSettings,
  normalizeUiComplexity,
  serializeApiSettings,
  type ReasoningEffort
} from "./core/apiSettings";
import { serializeSearchSettings } from "./core/searchSettings";
import {
  createId,
  createInitialSessionState,
  getSessionStreamingRunIds,
  interruptStaleArtifactEditsInSessionState,
  initialMessages,
  normalizeStoredSessionState,
  sortSessions,
  STALE_ARTIFACT_EDIT_SWEEP_INTERVAL_MS,
  STREAM_INTERRUPTED_ERROR,
  summarizeSession,
  type ChatSession,
  type ClientMessage,
  type SessionFile,
  type SessionState
} from "./domain/chat/sessionModel";
import { toApiMessages } from "./features/chat/apiMessages";
import {
  cancelChatRun,
  claimAcceptedChatRunResponse,
  readNdjsonLines,
  requestChatRunEvents,
  startChatRun
} from "./features/chat/chatApi";
import {
  createCancelledAssistantPatch,
  formatChatHttpError,
  isAbortError,
  sanitizeChatErrorMessage
} from "./features/chat/chatErrors";
import { createChatStreamLineHandler } from "./features/chat/chatStreamEvents";
import { reconcileChatRunState } from "./features/chat/chatRunReconcile";
import {
  projectCompletedChatRun,
  projectFailedChatRun,
  projectStreamingChatRun
} from "./features/chat/chatRunPresentation";
import {
  createChatRunState,
  reduceChatRunState
} from "./features/chat/chatRunStateMachine";
import type {
  ChatRunAssistantPhase,
  PendingManagedRequest,
  SendStreamUiRequestOptions
} from "./features/chat/chatRunRequest";
import { isManagedRequestReplaySafe } from "./features/chat/chatRunRequest";
import { createGenerationActivityCoordinator } from "./features/chat/generationActivityCoordinator";
import {
  convertMessage,
  getAppendMessageImages,
  getAppendMessageText
} from "./features/chat/assistantRuntimeAdapter";
import { createPendingRequestSlot } from "./features/chat/pendingRequestSlot";
import {
  closeAuthAndDiscard,
  openManualAuth,
  pinManagedRequestToSession,
  queueManagedAuthRequest,
  replayManagedAuthRequest
} from "./features/chat/managedAuthContinuation";
import { StreamThread } from "./features/chat/ui/StreamThread";
import { useBugReportController } from "./features/bug-reports/useBugReportController";
import {
  getAssistantBranchInfo,
  getAssistantForUserTurn,
  getBranchTurnInsertionIndex,
  getBranchVariantOrder,
  getSelectedBranchVariant,
  getVisibleSessionMessages,
  isMessageVisibleInSession
} from "./features/chat/branching";
import {
  requestSessions,
  uploadSessionFile
} from "./features/sessions/sessionApi";
import {
  loadSessionClientId
} from "./features/sessions/sessionPersistence";
import {
  getChatRunRequestFiles,
  getChatRunSessionFiles,
  getEphemeralChatRunFileIds,
  prepareChatRunAttachmentFiles
} from "./features/chat/chatRunAttachmentFiles";
import { useSessionSync } from "./features/sessions/useSessionSync";
import { useSessionSave } from "./features/sessions/useSessionSave";
import { useSessionIndex } from "./features/sessions/useSessionIndex";
import { useSessionActions } from "./features/sessions/useSessionActions";
import { useSessionAttachmentController } from "./features/sessions/useSessionAttachmentController";
import {
  updateMessageByIdInState,
  updateMessageInSessionByIdInState,
  upsertSessionFilesInState
} from "./features/sessions/sessionStateMutations";
import {
  createArtifactFileUpload,
  getAttachmentSessionError
} from "./features/sessions/sessionFileModel";
import {
  getArtifactEditActiveVariant,
  getArtifactEditCompleteRawStream,
  getResolvedArtifactEditId
} from "./features/artifacts/artifactEditModel";
import { hasRenderError } from "./features/artifacts/renderErrors";
import { useArtifactSelections } from "./features/artifacts/useArtifactSelections";
import { isArtifactSelectionTargetActive } from "./features/artifacts/artifactSelectionController";
import { useArtifactActions } from "./features/artifacts/useArtifactActions";
import { selectArtifactEditVersion } from "./features/artifacts/artifactEditOperationModel";
import { useArtifactEditController } from "./features/artifacts/useArtifactEditController";
import { createGeneratedArtifactBatchController } from "./features/artifacts/generatedArtifactBatchController";
import { useVisualRepairController } from "./features/artifacts/useVisualRepairController";
import {
  replayPendingVisualRepair,
  startVisualRepairWithAuthContinuation
} from "./features/artifacts/visualRepairAuthContinuation";
import type { StartVisualRepairInput } from "./features/artifacts/visualRepairController";
import {
  finalizePersistedGeneratedArtifactBatches,
  reduceGeneratedArtifactBatchPatch,
  restoreGeneratedArtifactBatchOperation
} from "./features/artifacts/generatedArtifactBatchModel";
import type {
  ArtifactEditMutationOutcome,
  ArtifactEditTarget
} from "./features/artifacts/artifactEditController";
import { coerceApiSettingsForRuntime } from "./features/settings/appSettingsPolicy";
import { useAppSettings } from "./features/settings/useAppSettings";
import { useCloudAuthController } from "./features/auth/useCloudAuthController";
import type { ImageAttachment } from "./core/imageAttachments";
import { createStreamingRenderer } from "./runtime/streamui/streamingRenderer";
import type {
  RenderError,
  RenderSnapshot,
  StreamingRenderer
} from "./runtime/streamui/types";

type BranchRunCancelCleanup = {
  sessionId: string;
  groupId: string;
  variantId: string;
  fallbackVariantId?: string;
};

const THEME_STORAGE_KEY = "streamui.theme.v1";
const SESSION_SYNC_INTERVAL_MS = 4_000;
const SESSION_SAVE_DEBOUNCE_MS = 350;

function loadThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "night";
  }

  return window.localStorage.getItem(THEME_STORAGE_KEY) === "day"
    ? "day"
    : "night";
}

function getCanvasContext() {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const messageListWidth =
    document.querySelector<HTMLElement>(".message-list")?.clientWidth ??
    viewportWidth;
  const horizontalInset = viewportWidth <= 720 ? 32 : 48;
  const canvasWidth = Math.min(900, Math.max(280, messageListWidth - horizontalInset));
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

export default function App() {
  const [sessionState, setSessionState] =
    useState<SessionState>(createInitialSessionState);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsHydrated, setSessionsHydrated] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
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
    summary: authSummary,
    loaded: authLoaded,
    user: authenticatedUser,
    isOverlayOpen: isAuthOverlayOpen,
    open: openAuthOverlay,
    close: closeAuthOverlay,
    acceptSummary: handleAuthChange,
    updateUser: handleAuthUserChange,
    refresh: refreshAuthSummary,
    logout: logoutCloudAccount
  } = useCloudAuthController({ cloudEnabled });
  const [isSending, setIsSending] = useState(false);
  const activeSession =
    sessionState.sessions.find(
      (session) => session.id === sessionState.activeSessionId
    ) ?? sessionState.sessions[0];
  const sessionMessages = activeSession?.messages ?? initialMessages;
  const messages = useMemo(
    () => getVisibleSessionMessages(activeSession),
    [activeSession]
  );
  const isActiveSessionSending = getSessionStreamingRunIds(activeSession).length > 0;
  const activeFiles = activeSession?.files ?? [];
  const activeSessionModel = activeSession?.model || apiSettings.model;
  const activeSessionReasoningEffort =
    activeSession?.reasoningEffort ?? apiSettings.reasoningEffort;
  const activeSessionUiComplexity = normalizeUiComplexity(
    activeSession?.uiComplexity ?? apiSettings.uiComplexity
  );
  const selectableModels = useMemo(
    () =>
      getSelectableModelOptions(
        normalizeApiSettings({
          ...apiSettings,
          model: activeSessionModel
        })
      ),
    [activeSessionModel, apiSettings]
  );
  const sessionClientIdRef = useRef(loadSessionClientId());
  const sessionStateRef = useRef(sessionState);
  const deletedSessionIdsRef = useRef<Set<string>>(new Set());
  const transientEmptySessionIdRef = useRef<string | null>(null);
  const messagesRef = useRef(sessionMessages);
  const activeSessionIdRef = useRef(sessionState.activeSessionId);
  const isSendingRef = useRef(isSending);
  const sessionNewOrDeleteBlockedRef = useRef(isSending);
  const sessionSelectionBlockedRef = useRef(false);
  const sessionsLoadedRef = useRef(sessionsLoaded);
  const sessionsHydratedRef = useRef(sessionsHydrated);
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());
  const runConnectionsRef = useRef<Map<string, AbortController>>(new Map());
  const cancelledRunIdsRef = useRef<Set<string>>(new Set());
  const branchRunCancelCleanupRef = useRef<
    Map<string, BranchRunCancelCleanup>
  >(new Map());
  const [generationActivity] = useState(() =>
    createGenerationActivityCoordinator({
      onBusyChange: (busy) => {
        isSendingRef.current = busy;
        setIsSending(busy);
      }
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
  const setSessionStateAndRef = useCallback(
    (updater: SessionState | ((current: SessionState) => SessionState)) => {
      const current = sessionStateRef.current;
      const next =
        typeof updater === "function"
          ? (updater as (current: SessionState) => SessionState)(current)
          : updater;

      sessionStateRef.current = next;
      setSessionState(next);
    },
    []
  );
  const handleAuthOverlayRequest = useCallback(() => {
    pendingVisualRepairSlot.clear();
    openManualAuth(pendingManagedRequestSlot, openAuthOverlay);
  }, [openAuthOverlay, pendingManagedRequestSlot, pendingVisualRepairSlot]);
  const handleAuthOverlayClose = useCallback(() => {
    closeAuthAndDiscard(pendingManagedRequestSlot, closeAuthOverlay);
    pendingVisualRepairSlot.clear();
  }, [closeAuthOverlay, pendingManagedRequestSlot, pendingVisualRepairSlot]);
  const handleLogout = useCallback(async () => {
    try {
      await logoutCloudAccount();
    } finally {
      pendingManagedRequestSlot.clear();
      pendingVisualRepairSlot.clear();
    }
  }, [logoutCloudAccount, pendingManagedRequestSlot, pendingVisualRepairSlot]);

  useEffect(() => {
    sessionStateRef.current = sessionState;
    messagesRef.current = sessionMessages;
    activeSessionIdRef.current = sessionState.activeSessionId;
  }, [sessionMessages, sessionState]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

  useEffect(() => {
    sessionsLoadedRef.current = sessionsLoaded;
  }, [sessionsLoaded]);

  useEffect(() => {
    return () => {
      runConnectionsRef.current.forEach((controller) => controller.abort());
      runConnectionsRef.current.clear();
      branchRunCancelCleanupRef.current.clear();
      generationActivity.reset();
    };
  }, [generationActivity]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

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

  useEffect(() => {
    if (typeof window === "undefined" || !sessionsLoaded) {
      return undefined;
    }

    const sweepStaleArtifactEdits = () => {
      setSessionStateAndRef((current) =>
        interruptStaleArtifactEditsInSessionState(current)
      );
    };

    sweepStaleArtifactEdits();
    const intervalId = window.setInterval(
      sweepStaleArtifactEdits,
      STALE_ARTIFACT_EDIT_SWEEP_INTERVAL_MS
    );

    return () => window.clearInterval(intervalId);
  }, [sessionsLoaded, setSessionStateAndRef]);

  const saveCurrentSessionStateNow = useSessionSave({
    sessionState,
    sessionsLoaded,
    debounceMs: SESSION_SAVE_DEBOUNCE_MS,
    sessionStateRef,
    sessionsLoadedRef,
    sessionClientIdRef,
    deletedSessionIdsRef
  });

  useEffect(() => {
    if (!sessionsLoaded) {
      return;
    }

    const current = sessionStateRef.current;
    const finalized = finalizePersistedGeneratedArtifactBatches(
      current,
      themeMode,
      Date.now(),
      cancelledRunIdsRef.current
    );
    if (finalized === current) {
      return;
    }

    setSessionStateAndRef(finalized);
    void Promise.resolve(saveCurrentSessionStateNow()).catch((error) => {
      console.warn("Could not finalize restored artifact generation.", error);
    });
  }, [
    saveCurrentSessionStateNow,
    sessionState.sessions,
    sessionsLoaded,
    setSessionStateAndRef,
    themeMode
  ]);

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

  const updateActiveSessionMessages = useCallback(
    (updater: (messages: ClientMessage[]) => ClientMessage[]) => {
      updateActiveSession((session) => {
        const nextMessages = updater(session.messages);
        return {
          ...session,
          title: summarizeSession(nextMessages),
          updatedAt: Date.now(),
          messages: nextMessages
        };
      });
    },
    [updateActiveSession]
  );

  const upsertSessionFiles = useCallback(
    (sessionId: string, files: SessionFile[]) => {
      setSessionStateAndRef((current) =>
        upsertSessionFilesInState(current, sessionId, files)
      );
    },
    [setSessionStateAndRef]
  );

  const updateAssistantMessage = useCallback(
    (id: string, updater: (message: ClientMessage) => ClientMessage) => {
      setSessionStateAndRef((current) =>
        updateMessageByIdInState(current, id, updater)
      );
    },
    [setSessionStateAndRef]
  );

  const updateAssistantMessageInSession = useCallback(
    (
      sessionId: string,
      id: string,
      updater: (message: ClientMessage) => ClientMessage
    ) => {
      let changed = false;
      setSessionStateAndRef((current) =>
        updateMessageInSessionByIdInState(
          current,
          sessionId,
          id,
          (message) => {
            const next = updater(message);
            changed = next !== message;
            return next;
          }
        )
      );
      return changed;
    },
    [setSessionStateAndRef]
  );

  const mutateArtifactEditMessage = useCallback(
    (
      target: ArtifactEditTarget,
      updater: (message: ClientMessage) => ClientMessage
    ): ArtifactEditMutationOutcome => {
      let found = false;
      let changed = false;
      setSessionStateAndRef((current) =>
        updateMessageInSessionByIdInState(
          current,
          target.sessionId,
          target.assistantId,
          (message) => {
            found = true;
            const next = updater(message);
            changed = next !== message;
            return next;
          }
        )
      );
      return !found ? "missing" : changed ? "applied" : "unchanged";
    },
    [setSessionStateAndRef]
  );

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

  const updateAssistant = useCallback(
    (id: string, patch: Partial<ClientMessage>) => {
      updateAssistantMessage(id, (message) => ({ ...message, ...patch }));
    },
    [updateAssistantMessage]
  );

  const handleRuntimeError = useCallback(
    (id: string, error: RenderError) => {
      setSessionStateAndRef((current) => {
        let didUpdate = false;
        const sessions = current.sessions.map((session) => {
          let sessionChanged = false;
          const messages = session.messages.map((message) => {
            if (message.id !== id || !message.snapshot) {
              return message;
            }

            const exists =
              hasRenderError(message.runtimeErrors, error) ||
              hasRenderError(message.snapshot.errors, error);

            if (exists) {
              return message;
            }

            didUpdate = true;
            sessionChanged = true;
            const runtimeErrors = [...(message.runtimeErrors ?? []), error];
            return {
              ...message,
              runtimeErrors,
              snapshot: {
                ...message.snapshot,
                errors: [...message.snapshot.errors, error]
              }
            };
          });

          return sessionChanged ? { ...session, messages } : session;
        });

        return didUpdate ? { ...current, sessions } : current;
      });
    },
    [setSessionStateAndRef]
  );

  const removeCancelledBranchRunVariants = useCallback(
    (runIds: string[]) => {
      const cleanups = runIds
        .map((runId) => [runId, branchRunCancelCleanupRef.current.get(runId)] as const)
        .filter(
          (entry): entry is readonly [string, BranchRunCancelCleanup] =>
            Boolean(entry[1])
        );
      if (!cleanups.length) {
        return;
      }

      cleanups.forEach(([runId]) => {
        branchRunCancelCleanupRef.current.delete(runId);
      });

      setSessionStateAndRef((current) => {
        let didUpdate = false;
        const now = Date.now();
        const sessions = current.sessions.map((session) => {
          const sessionCleanups = cleanups
            .map(([, cleanup]) => cleanup)
            .filter((cleanup) => cleanup.sessionId === session.id);
          if (!sessionCleanups.length) {
            return session;
          }

          let messages = session.messages;
          let sessionChanged = false;
          const branchSelections = { ...(session.branchSelections ?? {}) };
          for (const cleanup of sessionCleanups) {
            const beforeLength = messages.length;
            messages = messages.filter(
              (message) =>
                message.branchGroupId !== cleanup.groupId ||
                message.branchVariantId !== cleanup.variantId
            );

            if (messages.length === beforeLength) {
              continue;
            }

            didUpdate = true;
            sessionChanged = true;
            const variants = getBranchVariantOrder(messages, cleanup.groupId);
            const fallback =
              cleanup.fallbackVariantId &&
              variants.includes(cleanup.fallbackVariantId)
                ? cleanup.fallbackVariantId
                : variants[0];

            if (fallback) {
              branchSelections[cleanup.groupId] = fallback;
            } else {
              delete branchSelections[cleanup.groupId];
            }
          }

          if (!sessionChanged) {
            return session;
          }

          return {
            ...session,
            branchSelections: Object.keys(branchSelections).length
              ? branchSelections
              : undefined,
            title: summarizeSession(messages),
            updatedAt: now,
            messages
          };
        });

        return didUpdate
          ? {
              ...current,
              sessions: sortSessions(sessions)
            }
          : current;
      });
    },
    [setSessionStateAndRef]
  );

  const markRunsCancelled = useCallback(
    (runIds: string[]) => {
      const runIdSet = new Set(runIds);
      if (!runIdSet.size) {
        return;
      }

      setSessionStateAndRef((current) => {
        let didUpdate = false;
        const now = Date.now();
        const sessions = current.sessions.map((session) => {
          let sessionChanged = false;
          const messages = session.messages.map((message) => {
            if (
              message.role !== "assistant" ||
              message.status !== "streaming" ||
              !message.generationRunId ||
              !runIdSet.has(message.generationRunId)
            ) {
              return message;
            }

            didUpdate = true;
            sessionChanged = true;
            const cancelledPatch = createCancelledAssistantPatch(
              message.rawStream ?? "",
              message.reasoning ?? "",
              message.streamSequence ?? 0
            );
            const generatedBatchOperation =
              restoreGeneratedArtifactBatchOperation(session.id, message);
            if (generatedBatchOperation) {
              return reduceGeneratedArtifactBatchPatch(
                message,
                generatedBatchOperation,
                cancelledPatch,
                "cancelled",
                themeMode
              );
            }
            return {
              ...message,
              ...cancelledPatch
            };
          });

          if (!sessionChanged) {
            return session;
          }

          return {
            ...session,
            title: summarizeSession(messages),
            updatedAt: now,
            messages
          };
        });

        return didUpdate
          ? {
              ...current,
              sessions: sortSessions(sessions)
            }
          : current;
      });
    },
    [setSessionStateAndRef, themeMode]
  );

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

  const handleModelChange = useCallback((model: string) => {
    const nextModel = model.trim();
    if (!nextModel) {
      return;
    }

    updateApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        model: nextModel
      })
    );
    updateActiveSession((session) => ({
      ...session,
      model: nextModel
    }));
  }, [updateActiveSession, updateApiSettings]);

  const handleReasoningEffortChange = useCallback(
    (reasoningEffort: ReasoningEffort) => {
      updateApiSettings((current) =>
        normalizeApiSettings({
          ...current,
          reasoningEffort
        })
      );
      updateActiveSession((session) => ({
        ...session,
        reasoningEffort
      }));
    },
    [updateActiveSession, updateApiSettings]
  );

  const handleUiComplexityChange = useCallback(
    (uiComplexity: number) => {
      const normalizedUiComplexity = normalizeUiComplexity(uiComplexity);
      updateApiSettings((current) =>
        normalizeApiSettings({
          ...current,
          uiComplexity: normalizedUiComplexity
        })
      );
      updateActiveSession((session) => ({
        ...session,
        uiComplexity: normalizedUiComplexity
      }));
    },
    [updateActiveSession, updateApiSettings]
  );

  const sendStreamUiRequest = useCallback(
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

      const appendUserMessage = options.appendUserMessage ?? true;
      const ephemeralAttachments = options.ephemeralAttachments ?? false;
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
      const attachmentSessionError = getAttachmentSessionError(
        attachments,
        requestSessionId
      );
      if (attachmentSessionError) {
        console.warn(attachmentSessionError);
        return;
      }
      const requestModel = (
        requestSessionForModel.model || apiSettings.model
      ).trim();
      const requestReasoningEffort =
        requestSessionForModel.reasoningEffort ?? apiSettings.reasoningEffort;
      const requestUiComplexity = normalizeUiComplexity(
        requestSessionForModel.uiComplexity ?? apiSettings.uiComplexity
      );
      const requestApiSettings = coerceApiSettingsForRuntime(
        normalizeApiSettings({
          ...apiSettings,
          model: requestModel,
          reasoningEffort: requestReasoningEffort,
          uiComplexity: requestUiComplexity
        }),
        runtimeSettings
      );
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
      const userMessageId = createId("user");
      const previousMessages = getVisibleSessionMessages(requestSessionForModel);
      const preparedAttachmentFiles = prepareChatRunAttachmentFiles(
        attachments,
        userMessageId,
        ephemeralAttachments
      );
      const uploadedFiles = preparedAttachmentFiles.uploadedFiles;
      if (!preparedAttachmentFiles.allAttachmentsCommitted) {
        console.warn(
          "Image upload is still in progress. Please wait before sending."
        );
        return;
      }
      const userMessage: ClientMessage = {
        ...options.userMessagePatch,
        id: userMessageId,
        role: "user",
        content: trimmed,
        fileIds: uploadedFiles.length
          ? uploadedFiles.map((file) => file.id)
          : options.userMessagePatch?.fileIds,
        status: "complete"
      };
      const assistantId = options.assistantMessageId?.trim() || createId("assistant");
      const generationRunId = options.generationRunId?.trim() || createId("run");
      const assistantMessage: ClientMessage = {
        ...options.assistantPatch,
        id: assistantId,
        role: "assistant",
        content: "",
        rawStream: "",
        generationRunId,
        streamSequence: 0,
        status: "streaming",
        ...(options.initialReasoning
          ? { reasoning: options.initialReasoning }
          : {})
      };
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
      const updateRunAssistant = (patch: Partial<ClientMessage>) => {
        updateAssistantForPhase(patch, "streaming");
      };
      const chatActivityLease =
        options.chatActivityLease ??
        generationActivity.tryAcquireChatRun(generationRunId);
      if (!chatActivityLease) {
        return;
      }

      let setupRenderer: StreamingRenderer | null = null;
      let setupStreamController: AbortController | null = null;
      let setupUnsubscribeSnapshot: (() => void) | null = null;
      const cleanupChatActivity = (rollbackBranch = false) => {
        try {
          setupUnsubscribeSnapshot?.();
        } catch (error) {
          console.warn("Could not unsubscribe ChatHTML renderer.", error);
        }
        if (
          setupRenderer &&
          renderersRef.current.get(assistantId) === setupRenderer
        ) {
          renderersRef.current.delete(assistantId);
        }
        if (
          setupStreamController &&
          runConnectionsRef.current.get(generationRunId) ===
            setupStreamController
        ) {
          runConnectionsRef.current.delete(generationRunId);
        }
        try {
          if (
            rollbackBranch &&
            branchRunCancelCleanupRef.current.has(generationRunId)
          ) {
            removeCancelledBranchRunVariants([generationRunId]);
          } else {
            branchRunCancelCleanupRef.current.delete(generationRunId);
          }
        } finally {
          chatActivityLease.release();
        }
      };

      try {
        if (options.cancelBranchVariant) {
          branchRunCancelCleanupRef.current.set(generationRunId, {
            sessionId: requestSessionId,
            groupId: options.cancelBranchVariant.groupId,
            variantId: options.cancelBranchVariant.variantId,
            fallbackVariantId: options.cancelBranchVariant.fallbackVariantId
          });
        }
        setupRenderer = createStreamingRenderer(themeMode);
        renderersRef.current.set(assistantId, setupRenderer);
        setupStreamController = new AbortController();
        runConnectionsRef.current.set(
          generationRunId,
          setupStreamController
        );

        setupUnsubscribeSnapshot = setupRenderer.onSnapshot((snapshot) => {
          updateRunAssistant({ snapshot });
        });

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
      } catch (error) {
        cleanupChatActivity(true);
        console.warn("Could not initialize ChatHTML run.", error);
        return;
      }

      const renderer = setupRenderer;
      const streamController = setupStreamController;
      if (!renderer || !streamController || !setupUnsubscribeSnapshot) {
        cleanupChatActivity(true);
        return;
      }

      let runState = createChatRunState({
        runId: generationRunId,
        reasoning: options.initialReasoning
      });
      let streamConnected = false;
      let serverSyncIntervalId: number | undefined;
      let serverSyncPromise: Promise<void> | null = null;

      const dispatchRunEvent = (
        event: Parameters<typeof reduceChatRunState>[1]
      ) => {
        const result = reduceChatRunState(runState, event);
        runState = result.state;
        return result;
      };

      const applyServerAssistantMessage = (serverMessage: ClientMessage) => {
        if (
          cancelledRunIdsRef.current.has(generationRunId) ||
          runConnectionsRef.current.get(generationRunId) !== streamController ||
          (streamController.signal.aborted &&
            runState.terminal?.source !== "server")
        ) {
          dispatchRunEvent({ type: "cancel" });
          return;
        }

        const result = dispatchRunEvent({
          type: "server",
          message: serverMessage
        });
        if (!result.accepted || !result.phase || !result.assistantPatch) {
          return;
        }

        updateAssistantForPhase(result.assistantPatch, result.phase);

        if (result.abortConnection) {
          streamController.abort();
        }
      };

      const reconcileAssistantFromServer = (): Promise<void> => {
        if (runState.terminal?.source === "server") {
          return Promise.resolve();
        }
        if (serverSyncPromise) {
          return serverSyncPromise;
        }

        serverSyncPromise = (async () => {
          try {
            const response = await requestSessions(sessionClientIdRef.current);
            if (!response.ok) {
              throw new Error(`Session sync failed with HTTP ${response.status}.`);
            }

            const serverState = normalizeStoredSessionState(
              await response.json(),
              Date.now(),
              {
                rebuildSnapshots: false,
                interruptPendingArtifactEdits: true
              }
            );
            const serverMessage = serverState.sessions
              .find((session) => session.id === requestSessionId)
              ?.messages.find((message) => message.id === assistantId);
            if (serverMessage) {
              applyServerAssistantMessage(serverMessage);
            }
          } catch (error) {
            if ((error as { name?: unknown }).name !== "AbortError") {
              console.warn("Could not reconcile ChatHTML stream state.", error);
            }
          } finally {
            serverSyncPromise = null;
          }
        })();
        return serverSyncPromise;
      };

      const startServerReconcile = () => {
        serverSyncIntervalId = window.setInterval(() => {
          void reconcileAssistantFromServer();
        }, 1500);
        void reconcileAssistantFromServer();
      };

      const handleContentChunk = (chunk: string, streamSequence?: number) => {
        const result = dispatchRunEvent({
          type: "content",
          text: chunk,
          sequence: streamSequence
        });
        if (!result.accepted) {
          return;
        }
        const projection = projectStreamingChatRun(
          runState.raw,
          typeof streamSequence === "number"
            ? runState.streamSequence
            : undefined
        );

        if (projection.streamUiSource !== undefined) {
          renderer.replace(projection.streamUiSource);
        }

        const snapshot =
          projection.streamUiSource !== undefined
            ? renderer.getSnapshot()
            : undefined;

        updateRunAssistant({
          ...projection.patch,
          ...(snapshot ? { snapshot } : {}),
        });
      };

      let handleStreamEvent: ReturnType<typeof createChatStreamLineHandler>;
      try {
        handleStreamEvent = createChatStreamLineHandler({
          runId: generationRunId,
          getLastSequence: () => runState.streamSequence,
          onSequence: () => undefined,
          onDone: (status, error, streamSequence) => {
            const result = dispatchRunEvent({
              type: "done",
              status,
              error,
              sequence: streamSequence
            });
            if (result.accepted && typeof streamSequence === "number") {
              updateRunAssistant({ streamSequence: runState.streamSequence });
            }
          },
          onMemory: (event, streamSequence) => {
            const result = dispatchRunEvent({
              type: "memory",
              sequence: streamSequence
            });
            if (!result.accepted) {
              return;
            }
            handleMemoryStreamEvent(event);
            if (typeof streamSequence === "number") {
              updateRunAssistant({ streamSequence: runState.streamSequence });
            }
          },
          onReasoning: (text, streamSequence) => {
            const result = dispatchRunEvent({
              type: "reasoning",
              text,
              sequence: streamSequence
            });
            if (!result.accepted) {
              return;
            }
            updateRunAssistant({
              reasoning: runState.reasoning,
              ...(typeof streamSequence === "number"
                ? { streamSequence: runState.streamSequence }
                : {})
            });
          },
          onContent: handleContentChunk
        });
      } catch (error) {
        cleanupChatActivity(true);
        updateAssistantForPhase(
          {
            content: "I could not complete that request.",
            error: "The chat request could not be initialized.",
            status: "error"
          },
          "error"
        );
        console.warn("Could not initialize ChatHTML stream handler.", error);
        return;
      }

      try {
        const requestHistory =
          typeof options.requestHistory === "function"
            ? options.requestHistory(previousMessages, userMessage, assistantMessage)
            : options.requestHistory ?? [...previousMessages, userMessage];
        const requestSession = sessionStateRef.current.sessions.find(
          (session) => session.id === requestSessionId
        );
        const requestFiles = getChatRunRequestFiles(
          requestSession?.files ?? [],
          preparedAttachmentFiles
        );
        startServerReconcile();

        const response = await startChatRun(
          {
            clientId: sessionClientIdRef.current,
            sessionId: requestSessionId,
            runId: generationRunId,
            userMessage:
              options.persistUserMessage ??
              (appendUserMessage ? userMessage : undefined),
            assistantMessage,
            messages: toApiMessages(requestHistory),
            files: requestFiles,
            ephemeralFileIds: getEphemeralChatRunFileIds(
              preparedAttachmentFiles
            ),
            canvas: getCanvasContext(),
            themeMode,
            apiSettings: serializeApiSettings(requestApiSettings),
            searchSettings: serializeSearchSettings(searchSettings)
          },
          sessionClientIdRef.current,
          streamController.signal
        );

        const acceptedResponse = claimAcceptedChatRunResponse(
          response,
          options.onRunAccepted
        );
        if (!acceptedResponse) {
          const errorText = await response.text();
          throw new Error(formatChatHttpError(response, errorText));
        }
        streamConnected = true;

        await readNdjsonLines(acceptedResponse.body, handleStreamEvent);

        await reconcileAssistantFromServer();
        const eofResult = dispatchRunEvent({ type: "eof" });

        if (runState.terminal?.source === "server") {
          return;
        }

        if (eofResult.eofDisposition === "detached") {
          updateRunAssistant({
            reasoning: runState.reasoning,
            rawStream: runState.raw,
            streamSequence: runState.streamSequence,
            status: "streaming"
          });
          return;
        }

        if (runState.terminal?.phase === "cancelled") {
          updateAssistantForPhase(
            createCancelledAssistantPatch(
              runState.raw,
              runState.reasoning,
              runState.streamSequence
            ),
            "cancelled"
          );
          return;
        }

        if (runState.terminal?.phase === "error") {
          updateAssistantForPhase(
            projectFailedChatRun({
              raw: runState.raw,
              reasoning: runState.reasoning,
              streamSequence: runState.streamSequence,
              error: runState.terminal.error
            }),
            "error"
          );
          return;
        }

        const completion = projectCompletedChatRun({
          raw: runState.raw,
          reasoning: runState.reasoning,
          streamSequence: runState.streamSequence
        });
        let finalSnapshot: RenderSnapshot | undefined;

        if (completion.streamUiSource) {
          renderer.replace(completion.streamUiSource);
          renderer.complete();
          finalSnapshot = renderer.getSnapshot();
        }

        const terminalApplied = updateAssistantForPhase(
          {
            ...completion.patch,
            snapshot: finalSnapshot
          },
          "complete"
        );
        if (!terminalApplied) {
          return;
        }
        const artifactUpload = createArtifactFileUpload(
          assistantId,
          runState.raw,
          finalSnapshot,
          completion.patch.artifactContext?.textSummary
        );
        if (artifactUpload) {
          try {
            upsertSessionFiles(requestSessionId, [
              await uploadSessionFile(
                requestSessionId,
                artifactUpload,
                sessionClientIdRef.current
              )
            ]);
          } catch (uploadError) {
            console.warn("Could not persist ChatHTML artifact file.", uploadError);
          }
        }
      } catch (error) {
        if (runState.terminal?.source === "server") {
          return;
        }
        if (
          cancelledRunIdsRef.current.has(generationRunId) ||
          streamController.signal.aborted ||
          isAbortError(error)
        ) {
          dispatchRunEvent({ type: "cancel" });
          updateAssistantForPhase(
            createCancelledAssistantPatch(
              runState.raw,
              runState.reasoning,
              runState.streamSequence
            ),
            "cancelled"
          );
          return;
        }
        const message =
          error instanceof Error
            ? sanitizeChatErrorMessage(error.message)
            : "The chat request failed.";
        if (
          streamConnected &&
          runState.terminal?.phase !== "error"
        ) {
          updateRunAssistant({
            reasoning: runState.reasoning,
            rawStream: runState.raw,
            streamSequence: runState.streamSequence,
            status: "streaming"
          });
          return;
        }
        updateAssistantForPhase(
          {
            content: "I could not complete that request.",
            error: message,
            reasoning: runState.reasoning,
            rawStream: runState.raw,
            streamSequence: runState.streamSequence,
            status: "error"
          },
          "error"
        );
      } finally {
        if (typeof serverSyncIntervalId === "number") {
          window.clearInterval(serverSyncIntervalId);
        }
        cleanupChatActivity();
        if (requestApiSettings.apiKeySource === "managed") {
          void refreshAuthSummary().catch((error) => {
            console.warn("Could not refresh ChatHTML Cloud account.", error);
          });
        }
      }
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
      removeCancelledBranchRunVariants,
      runtimeSettings,
      searchSettings,
      themeMode,
      updateAssistantMessageInSession,
      updateSessionById,
      upsertSessionFiles
    ]
  );

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
    }: {
      session: ChatSession;
      visibleMessages: ClientMessage[];
      userIndex: number;
      assistantId?: string;
      nextUserContent: string;
      attachments?: ImageAttachment[];
      appendUserMessage?: boolean;
      userMessagePatch?: Partial<ClientMessage>;
      assistantPatch?: Partial<ClientMessage>;
      initialReasoning?: string;
      requestHistory?: SendStreamUiRequestOptions["requestHistory"];
      preserveFollowingMessages?: boolean;
    }) => {
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
      const existingGroupId =
        activeUser.branchGroupId ||
        (activeAssistant?.branchAnchor ? activeAssistant.branchGroupId : undefined);
      const groupId = existingGroupId || createId("branch");
      const originalVariantId =
        activeUser.branchVariantId ||
        activeAssistant?.branchVariantId ||
        createId("variant");
      const nextVariantId = createId("variant");
      const isNewGroup = !existingGroupId;
      const branchStartId = activeUser.id;
      const branchAnchorId = activeAssistant?.id;
      const historyCutoffIndex = preserveFollowingMessages
        ? (() => {
            if (existingGroupId) {
              const firstGroupIndex = session.messages.findIndex(
                (message) => message.branchGroupId === existingGroupId
              );
              if (firstGroupIndex >= 0) {
                return firstGroupIndex;
              }
            }

            return session.messages.findIndex(
              (message) => message.id === activeUser.id
            );
          })()
        : -1;
      const historyBeforeUser =
        preserveFollowingMessages && historyCutoffIndex >= 0
          ? session.messages
              .slice(0, historyCutoffIndex)
              .filter((message) => isMessageVisibleInSession(session, message))
          : visibleMessages.slice(0, userIndex);
      const visibleBranchUserMessage: ClientMessage | undefined = appendUserMessage
        ? undefined
        : {
            id: createId("user"),
            role: "user",
            content: activeUser.content,
            fileIds: activeUser.fileIds,
            status: "complete",
            branchGroupId: groupId,
            branchVariantId: nextVariantId
          };

      void sendStreamUiRequest(nextUserContent, attachments, {
        appendUserMessage,
        initialReasoning,
        persistUserMessage: visibleBranchUserMessage,
        targetSessionId: session.id,
        branchSelection: { groupId, variantId: nextVariantId },
        cancelBranchVariant: {
          groupId,
          variantId: nextVariantId,
          fallbackVariantId: originalVariantId
        },
        userMessagePatch: {
          ...userMessagePatch,
          fileIds: userMessagePatch?.fileIds ?? activeUser.fileIds,
          branchGroupId: groupId,
          branchVariantId: nextVariantId
        },
        assistantPatch: {
          ...assistantPatch,
          branchGroupId: groupId,
          branchVariantId: nextVariantId,
          branchAnchor: true
        },
        requestHistory:
          requestHistory ??
          ((_previousMessages, userMessage) => [
            ...historyBeforeUser,
            userMessage
          ]),
        insertMessages: (messages, userMessage, assistantMessage) => {
          const nextMessages = appendUserMessage
            ? [userMessage, assistantMessage]
            : visibleBranchUserMessage
              ? [visibleBranchUserMessage, assistantMessage]
              : [assistantMessage];

          if (preserveFollowingMessages) {
            const startIndex = messages.findIndex(
              (message) => message.id === branchStartId
            );
            const branchAnchorIndex = branchAnchorId
              ? messages.findIndex((message) => message.id === branchAnchorId)
              : -1;
            const branchEndIndex =
              branchAnchorIndex >= startIndex ? branchAnchorIndex : startIndex;
            const sourceMessages = isNewGroup
              ? messages.map((message, index) => {
                  if (
                    startIndex < 0 ||
                    index < startIndex ||
                    index > branchEndIndex ||
                    message.branchGroupId
                  ) {
                    return message;
                  }

                  return {
                    ...message,
                    branchGroupId: groupId,
                    branchVariantId: originalVariantId,
                    branchAnchor:
                      message.id === branchAnchorId ? true : message.branchAnchor
                  };
                })
              : messages;
            const insertionIndex = getBranchTurnInsertionIndex(
              sourceMessages,
              groupId,
              branchStartId,
              branchAnchorId
            );

            return [
              ...sourceMessages.slice(0, insertionIndex),
              ...nextMessages,
              ...sourceMessages.slice(insertionIndex)
            ];
          }

          if (!isNewGroup) {
            return [...messages, ...nextMessages];
          }

          const startIndex = messages.findIndex(
            (message) => message.id === branchStartId
          );
          const annotatedMessages = messages.map((message, index) => {
            if (startIndex < 0 || index < startIndex || message.branchGroupId) {
              return message;
            }

            return {
              ...message,
              branchGroupId: groupId,
              branchVariantId: originalVariantId,
              branchAnchor:
                message.id === branchAnchorId ? true : message.branchAnchor
            };
          });

          return [...annotatedMessages, ...nextMessages];
        }
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

  const handleCancelRun = useCallback(async () => {
    const activeSession = sessionStateRef.current.sessions.find(
      (session) => session.id === activeSessionIdRef.current
    );
    const activeVisualRun = getActiveVisualRepairRun();
    const runIds = Array.from(
      new Set([
        ...getSessionStreamingRunIds(activeSession),
        ...(activeVisualRun ? [activeVisualRun.runId] : [])
      ])
    );
    const cancelledLocalArtifactEdit = cancelActiveArtifactEdit();
    const cancelledVisualRepair = cancelActiveVisualRepair();
    if (
      !runIds.length &&
      !cancelledLocalArtifactEdit &&
      !cancelledVisualRepair
    ) {
      return;
    }

    const branchCleanupRunIds = runIds.filter((runId) =>
      branchRunCancelCleanupRef.current.has(runId)
    );
    const patchCancelledRunIds = runIds.filter(
      (runId) => !branchRunCancelCleanupRef.current.has(runId)
    );

    runIds.forEach((runId) => cancelledRunIdsRef.current.add(runId));

    const cancelRequests = runIds.map((runId) =>
      cancelChatRun(runId, sessionClientIdRef.current).catch((error) => {
        console.warn("Could not cancel ChatHTML run on the server.", error);
      })
    );

    runIds.forEach((runId) => {
      const controller = runConnectionsRef.current.get(runId);
      controller?.abort();
      runConnectionsRef.current.delete(runId);
      generationActivity.finishChatRun(runId);
    });
    if (branchCleanupRunIds.length) {
      removeCancelledBranchRunVariants(branchCleanupRunIds);
    }
    if (patchCancelledRunIds.length) {
      markRunsCancelled(patchCancelledRunIds);
    }
    await Promise.allSettled(cancelRequests);
    if (runIds.length) {
      try {
        await saveCurrentSessionStateNow();
      } catch (error) {
        console.warn("Could not persist cancelled ChatHTML runs.", error);
      }
    }
    window.setTimeout(() => {
      runIds.forEach((runId) => cancelledRunIdsRef.current.delete(runId));
    }, SESSION_SYNC_INTERVAL_MS);
  }, [
    cancelActiveArtifactEdit,
    cancelActiveVisualRepair,
    generationActivity,
    getActiveVisualRepairRun,
    markRunsCancelled,
    removeCancelledBranchRunVariants,
    saveCurrentSessionStateNow
  ]);

  const handleRegenerateAssistant = useCallback(
    (assistantId: string) => {
      const session =
        sessionStateRef.current.sessions.find(
          (candidate) => candidate.id === activeSessionIdRef.current
        ) ?? sessionStateRef.current.sessions[0];
      if (!session) {
        return;
      }
      const visibleMessages = getVisibleSessionMessages(session);
      const assistantIndex = visibleMessages.findIndex(
        (message) => message.id === assistantId && message.role === "assistant"
      );
      if (assistantIndex < 0) {
        return;
      }

      const activeAssistant = visibleMessages[assistantIndex];
      const userIndex = (() => {
        for (let index = assistantIndex - 1; index >= 0; index -= 1) {
          if (visibleMessages[index].role === "user") {
            return index;
          }
        }
        return -1;
      })();
      if (userIndex < 0) {
        return;
      }

      const activeArtifactEditId = getResolvedArtifactEditId(activeAssistant);
      if (activeArtifactEditId) {
        void regenerateArtifactEditNode(assistantId, activeArtifactEditId);
        return;
      }

      if (activeAssistant.artifactEdits?.length || activeAssistant.artifactEditBaseRawStream) {
        startGeneratedArtifactBatch({
          sessionId: session.id,
          assistantId: activeAssistant.id,
          sourceUserMessageId: visibleMessages[userIndex].id,
          prompt: visibleMessages[userIndex].content,
          initialReasoning: "Thinking"
        });
        return;
      }

      if (activeAssistant.repairOfMessageId) {
        const originalRepairSnapshot = session.messages.find(
          (message) =>
            message.id === activeAssistant.repairOfMessageId &&
            message.role === "assistant" &&
            message.snapshot?.status === "complete"
        )?.snapshot;
        const repairSnapshot =
          activeAssistant.snapshot?.status === "complete"
            ? activeAssistant.snapshot
            : originalRepairSnapshot;
        if (!repairSnapshot) {
          return;
        }

        void handleVisualRepairAssistant(activeAssistant.id, repairSnapshot, 900);
        return;
      }

      startBranchedTurn({
        session,
        visibleMessages,
        userIndex,
        assistantId,
        nextUserContent: visibleMessages[userIndex].content
      });
    },
    [
      handleVisualRepairAssistant,
      regenerateArtifactEditNode,
      startBranchedTurn,
      startGeneratedArtifactBatch
    ]
  );

  const handleEditUserMessage = useCallback(
    (messageId: string, content: string) => {
      const session =
        sessionStateRef.current.sessions.find(
          (candidate) => candidate.id === activeSessionIdRef.current
        ) ?? sessionStateRef.current.sessions[0];
      if (!session) {
        return;
      }
      const visibleMessages = getVisibleSessionMessages(session);
      const userIndex = visibleMessages.findIndex(
        (message) => message.id === messageId && message.role === "user"
      );
      const nextUserContent = content.trim();
      if (userIndex < 0 || !nextUserContent) {
        return;
      }

      if (nextUserContent === visibleMessages[userIndex].content.trim()) {
        return;
      }

      const activeAssistant = getAssistantForUserTurn(visibleMessages, userIndex);
      startBranchedTurn({
        session,
        visibleMessages,
        userIndex,
        assistantId: activeAssistant?.id,
        nextUserContent,
        preserveFollowingMessages: true
      });
    },
    [startBranchedTurn]
  );

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

  useEffect(() => {
    if (!sessionsLoaded) {
      return;
    }

    for (const session of sessionState.sessions) {
      for (const message of session.messages) {
        const generationRunId = message.generationRunId;
        if (
          message.role !== "assistant" ||
          message.status !== "streaming" ||
          !generationRunId ||
          runConnectionsRef.current.has(generationRunId)
        ) {
          continue;
        }

        const chatActivityLease =
          generationActivity.registerRestoredChatRun(generationRunId);
        if (!chatActivityLease) {
          continue;
        }
        const controller = new AbortController();
        runConnectionsRef.current.set(generationRunId, controller);

        void (async () => {
          const generatedBatchOperation =
            restoreGeneratedArtifactBatchOperation(session.id, message);
          const updateRestoredAssistant = (
            patch: Partial<ClientMessage>,
            phase: ChatRunAssistantPhase = "streaming"
          ) => {
            const changed = updateAssistantMessageInSession(
              session.id,
              message.id,
              (current) =>
                generatedBatchOperation
                  ? reduceGeneratedArtifactBatchPatch(
                      current,
                      generatedBatchOperation,
                      patch,
                      phase,
                      themeMode
                    )
                  : { ...current, ...patch }
            );
            if (changed && phase !== "streaming") {
              void Promise.resolve(saveCurrentSessionStateNow()).catch((error) => {
                console.warn(
                  "Could not save restored generated artifact state.",
                  error
                );
              });
            }
          };
          let setupRenderer: StreamingRenderer | null = null;
          let setupUnsubscribeSnapshot: (() => void) | null = null;
          const cleanupRestoredChatActivity = () => {
            try {
              setupUnsubscribeSnapshot?.();
            } catch (error) {
              console.warn("Could not unsubscribe ChatHTML renderer.", error);
            }
            if (
              setupRenderer &&
              renderersRef.current.get(message.id) === setupRenderer
            ) {
              renderersRef.current.delete(message.id);
            }
            if (
              runConnectionsRef.current.get(generationRunId) === controller
            ) {
              runConnectionsRef.current.delete(generationRunId);
            }
            chatActivityLease.release();
          };

          try {
            setupRenderer = createStreamingRenderer(themeMode);
            renderersRef.current.set(message.id, setupRenderer);
            setupUnsubscribeSnapshot = setupRenderer.onSnapshot((snapshot) => {
              updateRestoredAssistant({ snapshot });
            });
          } catch (error) {
            cleanupRestoredChatActivity();
            updateRestoredAssistant(
              {
                content: "I could not complete that request.",
                status: "error",
                error: STREAM_INTERRUPTED_ERROR
              },
              "error"
            );
            console.warn("Could not restore ChatHTML renderer.", error);
            return;
          }

          const renderer = setupRenderer;
          if (!renderer || !setupUnsubscribeSnapshot) {
            cleanupRestoredChatActivity();
            return;
          }
          let raw = message.rawStream ?? "";
          let reasoning = message.reasoning ?? "";
          let lastStreamSequence = message.streamSequence ?? 0;
          let doneStatus: "complete" | "error" | undefined;
          let doneError = "";
          let completedFromServer = false;
          let serverSyncIntervalId: number | undefined;
          let serverSyncInFlight = false;

          const applyServerAssistantMessage = (serverMessage: ClientMessage) => {
            const result = reconcileChatRunState(
              {
                runId: generationRunId,
                raw,
                reasoning,
                streamSequence: lastStreamSequence,
                doneStatus,
                doneError,
                completedFromServer
              },
              serverMessage
            );
            if (!result.accepted) {
              return;
            }

            raw = result.state.raw;
            reasoning = result.state.reasoning;
            lastStreamSequence = result.state.streamSequence;
            doneStatus = result.state.doneStatus;
            doneError = result.state.doneError;
            completedFromServer = result.state.completedFromServer;
            updateRestoredAssistant(
              serverMessage,
              result.phase ?? "streaming"
            );

            if (result.abortConnection) {
              controller.abort();
            }
          };

          const reconcileAssistantFromServer = async () => {
            if (serverSyncInFlight || completedFromServer) {
              return;
            }

            serverSyncInFlight = true;
            try {
              const response = await requestSessions(sessionClientIdRef.current);
              if (!response.ok) {
                throw new Error(`Session sync failed with HTTP ${response.status}.`);
              }

              const serverState = normalizeStoredSessionState(
                await response.json(),
                Date.now(),
                {
                  rebuildSnapshots: false,
                  interruptPendingArtifactEdits: true
                }
              );
              const serverMessage = serverState.sessions
                .find((candidate) => candidate.id === session.id)
                ?.messages.find((candidate) => candidate.id === message.id);
              if (serverMessage) {
                applyServerAssistantMessage(serverMessage);
              }
            } catch (error) {
              if ((error as { name?: unknown }).name !== "AbortError") {
                console.warn("Could not reconcile ChatHTML stream state.", error);
              }
            } finally {
              serverSyncInFlight = false;
            }
          };

          const startServerReconcile = () => {
            serverSyncIntervalId = window.setInterval(() => {
              void reconcileAssistantFromServer();
            }, 1500);
            void reconcileAssistantFromServer();
          };

          const handleContentChunk = (chunk: string, streamSequence?: number) => {
            raw += chunk;
            const projection = projectStreamingChatRun(raw, streamSequence);

            if (projection.streamUiSource !== undefined) {
              renderer.replace(projection.streamUiSource);
            }

            const snapshot = projection.streamUiSource !== undefined
              ? renderer.getSnapshot()
              : undefined;

            updateRestoredAssistant({
              ...projection.patch,
              ...(snapshot ? { snapshot } : {}),
            });
          };

          let handleStreamEvent: ReturnType<
            typeof createChatStreamLineHandler
          >;
          try {
            handleStreamEvent = createChatStreamLineHandler({
              runId: generationRunId,
              getLastSequence: () => lastStreamSequence,
              onSequence: (streamSequence) => {
                lastStreamSequence = streamSequence;
              },
              onDone: (status, error, streamSequence) => {
                doneStatus = status;
                doneError = error;
                if (typeof streamSequence === "number") {
                  updateRestoredAssistant({ streamSequence });
                }
              },
              onMemory: (event, streamSequence) => {
                handleMemoryStreamEvent(event);
                if (typeof streamSequence === "number") {
                  updateRestoredAssistant({ streamSequence });
                }
              },
              onReasoning: (text, streamSequence) => {
                reasoning += text;
                updateRestoredAssistant({
                  reasoning,
                  ...(typeof streamSequence === "number"
                    ? { streamSequence }
                    : {})
                });
              },
              onContent: handleContentChunk
            });
          } catch (error) {
            cleanupRestoredChatActivity();
            updateRestoredAssistant(
              {
                content: "I could not complete that request.",
                status: "error",
                error: STREAM_INTERRUPTED_ERROR
              },
              "error"
            );
            console.warn("Could not restore ChatHTML stream handler.", error);
            return;
          }

          try {
            startServerReconcile();
            const response = await requestChatRunEvents(
              generationRunId,
              lastStreamSequence,
              sessionClientIdRef.current,
              controller.signal
            );

            if (response.status === 404) {
              updateRestoredAssistant(
                {
                  content: "I could not complete that request.",
                  reasoning,
                  rawStream: raw,
                  streamSequence: lastStreamSequence,
                  status: "error",
                  error: STREAM_INTERRUPTED_ERROR
                },
                "error"
              );
              return;
            }

            if (!response.ok || !response.body) {
              const errorText = await response.text();
              throw new Error(formatChatHttpError(response, errorText));
            }

            await readNdjsonLines(response.body, handleStreamEvent);

            await reconcileAssistantFromServer();

            if (completedFromServer) {
              return;
            }

            if (doneStatus === "error") {
              updateRestoredAssistant(
                projectFailedChatRun({
                  raw,
                  reasoning,
                  streamSequence: lastStreamSequence,
                  error: doneError
                }),
                "error"
              );
              return;
            }

            const completion = projectCompletedChatRun({
              raw,
              reasoning,
              streamSequence: lastStreamSequence
            });
            let finalSnapshot: RenderSnapshot | undefined;

            if (completion.streamUiSource) {
              renderer.replace(completion.streamUiSource);
              renderer.complete();
              finalSnapshot = renderer.getSnapshot();
            }

            updateRestoredAssistant(
              {
                ...completion.patch,
                snapshot: finalSnapshot
              },
              "complete"
            );
          } catch (error) {
            if (completedFromServer) {
              return;
            }
            if (
              cancelledRunIdsRef.current.has(generationRunId) ||
              controller.signal.aborted ||
              isAbortError(error)
            ) {
              updateRestoredAssistant(
                createCancelledAssistantPatch(
                  raw,
                  reasoning,
                  lastStreamSequence
                ),
                "cancelled"
              );
              return;
            }
            if ((error as { name?: unknown }).name !== "AbortError") {
              console.warn("Could not resume ChatHTML run.", error);
            }
          } finally {
            if (typeof serverSyncIntervalId === "number") {
              window.clearInterval(serverSyncIntervalId);
            }
            cleanupRestoredChatActivity();
          }
        })();
      }
    }
  }, [
    generationActivity,
    handleMemoryStreamEvent,
    saveCurrentSessionStateNow,
    sessionState.sessions,
    sessionsLoaded,
    themeMode,
    updateAssistantMessageInSession
  ]);

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

  const handleSelectArtifactEdit = useCallback(
    (assistantId: string, editId?: string) => {
      let didSelect = false;
      updateAssistantMessage(assistantId, (message) => {
        const result = selectArtifactEditVersion(message, editId, themeMode);
        didSelect ||= result.selected;
        return result.message;
      });
      if (didSelect) {
        clearArtifactSelections();
      }
    },
    [clearArtifactSelections, themeMode, updateAssistantMessage]
  );

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

  const sessionItems = useMemo<SessionListItem[]>(
    () =>
      sessionState.sessions.map((session) => ({
        id: session.id,
        title: session.title || summarizeSession(session.messages)
      })),
    [sessionState.sessions]
  );
  const sidebarPreview =
    !sessionsLoaded && sessionListPreview ? sessionListPreview : null;
  const sidebarSessionItems = sidebarPreview?.sessions ?? sessionItems;
  const sidebarActiveSessionId =
    sidebarPreview?.activeSessionId ?? sessionState.activeSessionId;
  const getBranchInfo = useCallback(
    (messageId: string) => getAssistantBranchInfo(activeSession, messageId),
    [activeSession]
  );

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
      {cloudEnabled && isAuthOverlayOpen ? (
        <AuthOverlay
          authSummary={authSummary}
          isLoading={!authLoaded}
          onAuthChange={handleAuthChange}
          onClose={handleAuthOverlayClose}
        />
      ) : null}
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
