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
import { blobToDataUrl } from "./core/blob";
import {
  getSelectableModelOptions,
  normalizeApiSettings,
  normalizeUiComplexity,
  serializeApiSettings,
  type ReasoningEffort
} from "./core/apiSettings";
import { serializeSearchSettings } from "./core/searchSettings";
import { buildArtifactContext } from "./core/artifactContext";
import {
  getSnapshotDiagnostics,
  renderSnapshotToPngBlob
} from "./core/artifactExport";
import { modelLikelySupportsImageInput } from "./core/modelCapabilities";
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
  type ArtifactEdit,
  type ChatSession,
  type ClientMessage,
  type SessionFile,
  type SessionState
} from "./domain/chat/sessionModel";
import { toApiMessages } from "./features/chat/apiMessages";
import {
  cancelChatRun,
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
  findSessionMessage,
  mergeSessionFiles
} from "./features/sessions/sessionSelectors";
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
  commitUploadedImageFile,
  createArtifactFileUpload,
  getAttachmentSessionError,
  imageAttachmentToFileUpload
} from "./features/sessions/sessionFileModel";
import {
  getArtifactEditActiveVariant,
  getArtifactEditCompleteRawStream,
  getArtifactEditRawStream,
  getResolvedArtifactEditId
} from "./features/artifacts/artifactEditModel";
import {
  buildCompletedAssistantPatchFromRawStream
} from "./features/artifacts/artifactMessageProjection";
import { hasRenderError } from "./features/artifacts/renderErrors";
import { buildVisualRepairPrompt } from "./features/artifacts/visualRepair";
import { useArtifactSelections } from "./features/artifacts/useArtifactSelections";
import { isArtifactSelectionTargetActive } from "./features/artifacts/artifactSelectionController";
import { useArtifactActions } from "./features/artifacts/useArtifactActions";
import { selectArtifactEditVersion } from "./features/artifacts/artifactEditOperationModel";
import { useArtifactEditController } from "./features/artifacts/useArtifactEditController";
import type {
  ArtifactEditMutationOutcome,
  ArtifactEditTarget
} from "./features/artifacts/artifactEditController";
import { coerceApiSettingsForRuntime } from "./features/settings/appSettingsPolicy";
import { useAppSettings } from "./features/settings/useAppSettings";
import { useCloudAuthController } from "./features/auth/useCloudAuthController";
import type {
  ImageAttachment,
  UploadedSessionFile
} from "./core/imageAttachments";
import { extractStreamUiParts } from "./runtime/streamui/protocol";
import { createStreamingRenderer } from "./runtime/streamui/streamingRenderer";
import type {
  RenderError,
  RenderSnapshot,
  StreamingRenderer
} from "./runtime/streamui/types";

type SendStreamUiRequestOptions = {
  appendUserMessage?: boolean;
  assistantMessageId?: string;
  assistantPatch?: Partial<ClientMessage>;
  persistUserMessage?: ClientMessage;
  userMessagePatch?: Partial<ClientMessage>;
  initialReasoning?: string;
  decorateAssistantPatch?: (
    patch: Partial<ClientMessage>,
    phase: "streaming" | "complete" | "error" | "cancelled"
  ) => Partial<ClientMessage>;
  requestHistory?:
    | ClientMessage[]
    | ((
        previousMessages: ClientMessage[],
        userMessage: ClientMessage,
        assistantMessage: ClientMessage
      ) => ClientMessage[]);
  targetSessionId?: string;
  branchSelection?: {
    groupId: string;
    variantId: string;
  };
  cancelBranchVariant?: {
    groupId: string;
    variantId: string;
    fallbackVariantId?: string;
  };
  insertMessages?: (
    messages: ClientMessage[],
    userMessage: ClientMessage,
    assistantMessage: ClientMessage
  ) => ClientMessage[];
};

type PendingManagedRequest = {
  text: string;
  attachments: ImageAttachment[];
  options: SendStreamUiRequestOptions;
};

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
    openManualAuth(pendingManagedRequestSlot, openAuthOverlay);
  }, [openAuthOverlay, pendingManagedRequestSlot]);
  const handleAuthOverlayClose = useCallback(() => {
    closeAuthAndDiscard(pendingManagedRequestSlot, closeAuthOverlay);
  }, [closeAuthOverlay, pendingManagedRequestSlot]);
  const handleLogout = useCallback(async () => {
    try {
      await logoutCloudAccount();
    } finally {
      pendingManagedRequestSlot.clear();
    }
  }, [logoutCloudAccount, pendingManagedRequestSlot]);

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
    }
  }, [cloudEnabled, pendingManagedRequestSlot]);

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
            return {
              ...message,
              ...createCancelledAssistantPatch(
                message.rawStream ?? "",
                message.reasoning ?? "",
                message.streamSequence ?? 0
              )
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
    [setSessionStateAndRef]
  );

  const handleCancelRun = useCallback(async () => {
    const activeSession = sessionStateRef.current.sessions.find(
      (session) => session.id === activeSessionIdRef.current
    );
    const runIds = getSessionStreamingRunIds(activeSession);
    const cancelledLocalArtifactEdit = cancelActiveArtifactEdit();
    if (!runIds.length && !cancelledLocalArtifactEdit) {
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
    window.setTimeout(() => {
      runIds.forEach((runId) => cancelledRunIdsRef.current.delete(runId));
    }, SESSION_SYNC_INTERVAL_MS);
  }, [
    cancelActiveArtifactEdit,
    generationActivity,
    markRunsCancelled,
    removeCancelledBranchRunVariants
  ]);

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
        generationActivity.isBusy()
      ) {
        return;
      }

      const appendUserMessage = options.appendUserMessage ?? true;
      const requestedSessionId = options.targetSessionId?.trim();
      const requestSessionId = requestedSessionId || activeSessionIdRef.current;
      const requestSessionForModel = sessionStateRef.current.sessions.find(
        (session) => session.id === requestSessionId
      );
      if (!requestSessionForModel) {
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
      const uploadedFiles = attachments
        .map((attachment) => commitUploadedImageFile(attachment, userMessageId))
        .filter((file): file is SessionFile => file !== null);
      if (uploadedFiles.length !== attachments.length) {
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
      const generationRunId = createId("run");
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
      const decorateAssistantPatch = (
        patch: Partial<ClientMessage>,
        phase: "streaming" | "complete" | "error" | "cancelled"
      ) => options.decorateAssistantPatch?.(patch, phase) ?? patch;
      const updateAssistantForPhase = (
        patch: Partial<ClientMessage>,
        phase: "streaming" | "complete" | "error" | "cancelled" = "streaming"
      ) => {
        updateAssistant(assistantId, decorateAssistantPatch(patch, phase));
      };
      const chatActivityLease =
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
          updateAssistant(assistantId, { snapshot });
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
            files: mergeSessionFiles([...session.files, ...uploadedFiles])
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

      let raw = "";
      let reasoning = options.initialReasoning ?? "";
      let lastStreamSequence = 0;
      let streamConnected = false;
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
        if (!result.accepted || !result.phase) {
          return;
        }

        raw = result.state.raw;
        reasoning = result.state.reasoning;
        lastStreamSequence = result.state.streamSequence;
        doneStatus = result.state.doneStatus;
        doneError = result.state.doneError;
        completedFromServer = result.state.completedFromServer;
        updateAssistantForPhase(serverMessage, result.phase);

        if (result.abortConnection) {
          streamController.abort();
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
          const serverMessage = findSessionMessage(serverState, assistantId);
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
        const parts = extractStreamUiParts(raw);

        if (parts.hasStreamUi) {
          renderer.replace(parts.streamui);
        }

        const snapshot = parts.hasStreamUi ? renderer.getSnapshot() : undefined;
        const artifactContext =
          parts.hasStreamUi && parts.streamUiComplete && parts.streamui.trim()
            ? buildArtifactContext(raw)
            : undefined;
        const sessionTitle =
          parts.sessionTitleComplete && parts.sessionTitle.trim()
            ? parts.sessionTitle
            : undefined;

        updateAssistant(assistantId, {
          content: parts.chat || (!parts.hasStreamUi ? parts.fallbackText : ""),
          rawStream: raw,
          ...(snapshot ? { snapshot } : {}),
          ...(artifactContext ? { artifactContext } : {}),
          ...(sessionTitle ? { sessionTitle } : {}),
          hasStreamUi: parts.hasStreamUi,
          streamUiComplete: parts.streamUiComplete,
          ...(typeof streamSequence === "number" ? { streamSequence } : {})
        });
      };

      let handleStreamEvent: ReturnType<typeof createChatStreamLineHandler>;
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
              updateAssistant(assistantId, { streamSequence });
            }
          },
          onMemory: (event, streamSequence) => {
            handleMemoryStreamEvent(event);
            if (typeof streamSequence === "number") {
              updateAssistant(assistantId, { streamSequence });
            }
          },
          onReasoning: (text, streamSequence) => {
            reasoning += text;
            updateAssistant(assistantId, {
              reasoning,
              ...(typeof streamSequence === "number"
                ? { streamSequence }
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
        const requestFiles = mergeSessionFiles([
          ...(requestSession?.files ?? []),
          ...uploadedFiles
        ]);
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
            canvas: getCanvasContext(),
            themeMode,
            apiSettings: serializeApiSettings(requestApiSettings),
            searchSettings: serializeSearchSettings(searchSettings)
          },
          sessionClientIdRef.current,
          streamController.signal
        );

        if (!response.ok || !response.body) {
          const errorText = await response.text();
          throw new Error(formatChatHttpError(response, errorText));
        }
        streamConnected = true;

        await readNdjsonLines(response.body, handleStreamEvent);

        await reconcileAssistantFromServer();

        if (completedFromServer) {
          return;
        }

        if (doneStatus === "error") {
          const finalParts = extractStreamUiParts(raw);
          updateAssistantForPhase(
            {
              content:
                finalParts.chat ||
                finalParts.fallbackText ||
                "I could not complete that request.",
              reasoning,
              rawStream: raw,
              streamSequence: lastStreamSequence,
              error: sanitizeChatErrorMessage(doneError),
              status: "error"
            },
            "error"
          );
          return;
        }

        const finalParts = extractStreamUiParts(raw);
        let finalSnapshot: RenderSnapshot | undefined;
        const artifactContext =
          finalParts.hasStreamUi && finalParts.streamui.trim()
            ? buildArtifactContext(raw)
            : undefined;

        if (finalParts.hasStreamUi && finalParts.streamui.trim()) {
          renderer.replace(finalParts.streamui);
          renderer.complete();
          finalSnapshot = renderer.getSnapshot();
        }

        updateAssistantForPhase(
          {
            content: finalParts.chat || finalParts.fallbackText,
            reasoning,
            ...(finalParts.sessionTitleComplete && finalParts.sessionTitle.trim()
              ? { sessionTitle: finalParts.sessionTitle }
              : {}),
            rawStream: raw,
            streamSequence: lastStreamSequence,
            ...(finalSnapshot ? { snapshot: finalSnapshot } : {}),
            ...(artifactContext ? { artifactContext } : {}),
            hasStreamUi:
              finalParts.hasStreamUi && finalParts.streamui.trim().length > 0,
            streamUiComplete: finalParts.streamUiComplete,
            status: "complete"
          },
          "complete"
        );
        const artifactUpload = createArtifactFileUpload(
          assistantId,
          raw,
          finalSnapshot,
          artifactContext?.textSummary
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
        if (completedFromServer) {
          return;
        }
        if (
          cancelledRunIdsRef.current.has(generationRunId) ||
          streamController.signal.aborted ||
          isAbortError(error)
        ) {
          updateAssistantForPhase(
            createCancelledAssistantPatch(raw, reasoning, lastStreamSequence),
            "cancelled"
          );
          return;
        }
        const message =
          error instanceof Error
            ? sanitizeChatErrorMessage(error.message)
            : "The chat request failed.";
        if (streamConnected && doneStatus !== "error") {
          updateAssistant(assistantId, {
            reasoning,
            rawStream: raw,
            streamSequence: lastStreamSequence,
            status: "streaming"
          });
          return;
        }
        updateAssistantForPhase(
          {
            content: "I could not complete that request.",
            error: message,
            reasoning,
            rawStream: raw,
            streamSequence: lastStreamSequence,
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
      updateAssistant,
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

  const decorateGeneratedArtifactBatchPatch = useCallback(
    (
      assistantId: string,
      editId: string,
      variantId: string,
      previousEditId: string | undefined
    ) =>
      (
        patch: Partial<ClientMessage>,
        phase: "streaming" | "complete" | "error" | "cancelled"
      ): Partial<ClientMessage> => {
        if (phase === "streaming") {
          return patch;
        }

        const current = findSessionMessage(sessionStateRef.current, assistantId);
        const currentEdits = current?.artifactEdits ?? [];
        if (phase === "cancelled") {
          const artifactEdits = currentEdits.filter((edit) => edit.id !== editId);
          return {
            ...patch,
            artifactEdits: artifactEdits.length ? artifactEdits : undefined,
            activeArtifactEditId: previousEditId
          };
        }

        const rawStream = patch.rawStream ?? "";
        const errorMessage =
          typeof patch.error === "string" && patch.error.trim()
            ? patch.error
            : "The artifact regeneration failed.";
        const nextStatus: "complete" | "error" =
          phase === "complete" ? "complete" : "error";
        const artifactEdits = currentEdits.map((edit) => {
          if (edit.id !== editId) {
            return edit;
          }

          return {
            ...edit,
            status: nextStatus,
            error: phase === "complete" ? undefined : errorMessage,
            activeVariantId: variantId,
            variants: edit.variants.map((variant) =>
              variant.id === variantId
                ? {
                    ...variant,
                    status: nextStatus,
                    rawStream: phase === "complete" ? rawStream : variant.rawStream,
                    error: phase === "complete" ? undefined : errorMessage
                  }
                : variant
            )
          };
        });

        return {
          ...patch,
          artifactEdits,
          activeArtifactEditId: editId
        };
      },
    []
  );

  const startGeneratedArtifactBatch = useCallback(
    ({
      session,
      visibleMessages,
      assistantIndex,
      userIndex,
      nextUserContent,
      attachments = [],
      assistantPatch,
      initialReasoning,
      requestHistory
    }: {
      session: ChatSession;
      visibleMessages: ClientMessage[];
      assistantIndex: number;
      userIndex: number;
      nextUserContent: string;
      attachments?: ImageAttachment[];
      assistantPatch?: Partial<ClientMessage>;
      initialReasoning?: string;
      requestHistory?: SendStreamUiRequestOptions["requestHistory"];
    }) => {
      if (generationActivity.isBusy()) {
        return;
      }

      const assistant = visibleMessages[assistantIndex];
      const user = visibleMessages[userIndex];
      if (!assistant || assistant.role !== "assistant" || !user || user.role !== "user") {
        return;
      }

      const source = getArtifactEditRawStream(
        assistant,
        getResolvedArtifactEditId(assistant)
      );
      const baseRawStream = assistant.artifactEditBaseRawStream ?? assistant.rawStream;
      if (!source?.trim() && !baseRawStream?.trim()) {
        return;
      }

      const previousEditId = getResolvedArtifactEditId(assistant);
      const editId = createId("artifact-edit");
      const variantId = createId("artifact-edit-variant");
      const createdAt = Date.now();
      const pendingEdit: ArtifactEdit = {
        id: editId,
        parentId: previousEditId,
        createdAt,
        prompt: nextUserContent.trim(),
        references: [],
        promptBubble: false,
        activeVariantId: variantId,
        variants: [
          {
            id: variantId,
            createdAt,
            status: "pending"
          }
        ],
        status: "pending"
      };
      const nextArtifactEdits = [...(assistant.artifactEdits ?? []), pendingEdit];

      void sendStreamUiRequest(nextUserContent, attachments, {
        appendUserMessage: false,
        assistantMessageId: assistant.id,
        targetSessionId: session.id,
        initialReasoning: initialReasoning ?? "Thinking",
        assistantPatch: {
          ...assistantPatch,
          artifactEditBaseRawStream: baseRawStream,
          artifactEdits: nextArtifactEdits,
          activeArtifactEditId: editId
        },
        decorateAssistantPatch: decorateGeneratedArtifactBatchPatch(
          assistant.id,
          editId,
          variantId,
          previousEditId
        ),
        requestHistory:
          requestHistory ??
          ((_previousMessages, userMessage) => [
            ...visibleMessages.slice(0, userIndex),
            userMessage
          ]),
        insertMessages: (messages, _userMessage, assistantMessage) =>
          messages.map((message) =>
            message.id === assistant.id
              ? {
                  ...message,
                  ...assistantMessage
                }
              : message
          )
      });
    },
    [
      decorateGeneratedArtifactBatchPatch,
      generationActivity,
      sendStreamUiRequest
    ]
  );

  const handleVisualRepairAssistant = useCallback(
    async (assistantId: string, snapshot: RenderSnapshot, width: number) => {
      if (generationActivity.isBusy() || snapshot.status !== "complete") {
        return;
      }

      const session =
        sessionStateRef.current.sessions.find((candidate) =>
          candidate.messages.some((message) => message.id === assistantId)
        ) ??
        sessionStateRef.current.sessions.find(
          (candidate) => candidate.id === activeSessionIdRef.current
        ) ??
        sessionStateRef.current.sessions[0];
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

      const exportWidth = Math.max(320, Math.min(1100, Math.round(width || 900)));
      const requestModel = (session.model || apiSettings.model).trim();
      const canUseScreenshot = modelLikelySupportsImageInput(requestModel);

      try {
        const diagnostics = canUseScreenshot
          ? undefined
          : getSnapshotDiagnostics(snapshot, {
              exportWidth,
              themeMode
            });
        const attachments: ImageAttachment[] = [];
        if (canUseScreenshot) {
          const blob = await renderSnapshotToPngBlob(snapshot, {
            themeMode,
            width: exportWidth
          });
          const dataUrl = await blobToDataUrl(blob);
          const image: ImageAttachment = {
            id: createId("render"),
            name: `${assistantId}-render.png`,
            mimeType: "image/png",
            size: blob.size,
            dataUrl
          };
          const uploadedFile = await uploadSessionFile(
            session.id,
            imageAttachmentToFileUpload(image, assistantId, true),
            sessionClientIdRef.current
          );
          if (uploadedFile.kind !== "image") {
            throw new Error("Rendered screenshot upload did not return an image.");
          }

          attachments.push({
            ...image,
            id: uploadedFile.id,
            name: uploadedFile.name,
            mimeType: uploadedFile.mimeType,
            size: uploadedFile.size,
            width: uploadedFile.width,
            height: uploadedFile.height,
            sessionFile: uploadedFile as UploadedSessionFile,
            ownerSessionId: session.id
          });
        }
        const repairOfMessageId =
          activeAssistant.repairOfMessageId || activeAssistant.id;
        const repairAttempt = (activeAssistant.repairAttempt ?? 0) + 1;

        startGeneratedArtifactBatch({
          session,
          visibleMessages,
          assistantIndex,
          userIndex,
          nextUserContent: buildVisualRepairPrompt({
            diagnostics,
            hasScreenshot: canUseScreenshot,
            width: exportWidth
          }),
          attachments,
          assistantPatch: {
            repairOfMessageId,
            repairAttempt
          },
          initialReasoning:
            "Captured the rendered artifact screenshot for visual repair.",
          requestHistory: (_previousMessages, userMessage) => [
            ...visibleMessages.slice(0, assistantIndex + 1),
            userMessage
          ]
        });
      } catch (error) {
        console.warn("Could not start visual artifact repair.", error);
      }
    },
    [
      apiSettings.model,
      generationActivity,
      startGeneratedArtifactBatch,
      themeMode
    ]
  );

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
          session,
          visibleMessages,
          assistantIndex,
          userIndex,
          nextUserContent: visibleMessages[userIndex].content,
          initialReasoning: "Thinking",
          requestHistory: (_previousMessages, userMessage) => [
            ...visibleMessages.slice(0, userIndex),
            userMessage
          ]
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
              updateAssistant(message.id, { snapshot });
            });
          } catch (error) {
            cleanupRestoredChatActivity();
            updateAssistant(message.id, {
              content: "I could not complete that request.",
              status: "error",
              error: STREAM_INTERRUPTED_ERROR
            });
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
            updateAssistant(message.id, serverMessage);

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
              const serverMessage = findSessionMessage(serverState, message.id);
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
            const parts = extractStreamUiParts(raw);

            if (parts.hasStreamUi) {
              renderer.replace(parts.streamui);
            }

            const snapshot = parts.hasStreamUi
              ? renderer.getSnapshot()
              : undefined;
            const artifactContext =
              parts.hasStreamUi && parts.streamUiComplete && parts.streamui.trim()
                ? buildArtifactContext(raw)
                : undefined;
            const sessionTitle =
              parts.sessionTitleComplete && parts.sessionTitle.trim()
                ? parts.sessionTitle
                : undefined;

            updateAssistant(message.id, {
              content: parts.chat || (!parts.hasStreamUi ? parts.fallbackText : ""),
              rawStream: raw,
              ...(snapshot ? { snapshot } : {}),
              ...(artifactContext ? { artifactContext } : {}),
              ...(sessionTitle ? { sessionTitle } : {}),
              hasStreamUi: parts.hasStreamUi,
              streamUiComplete: parts.streamUiComplete,
              ...(typeof streamSequence === "number" ? { streamSequence } : {})
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
                  updateAssistant(message.id, { streamSequence });
                }
              },
              onMemory: (event, streamSequence) => {
                handleMemoryStreamEvent(event);
                if (typeof streamSequence === "number") {
                  updateAssistant(message.id, { streamSequence });
                }
              },
              onReasoning: (text, streamSequence) => {
                reasoning += text;
                updateAssistant(message.id, {
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
            updateAssistant(message.id, {
              content: "I could not complete that request.",
              status: "error",
              error: STREAM_INTERRUPTED_ERROR
            });
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
              updateAssistant(message.id, {
                content: "I could not complete that request.",
                reasoning,
                rawStream: raw,
                streamSequence: lastStreamSequence,
                status: "error",
                error: STREAM_INTERRUPTED_ERROR
              });
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
              const finalParts = extractStreamUiParts(raw);
              updateAssistant(message.id, {
                content:
                  finalParts.chat ||
                  finalParts.fallbackText ||
                  "I could not complete that request.",
                reasoning,
                rawStream: raw,
                streamSequence: lastStreamSequence,
                error: sanitizeChatErrorMessage(doneError),
                status: "error"
              });
              return;
            }

            const finalParts = extractStreamUiParts(raw);
            let finalSnapshot: RenderSnapshot | undefined;
            const artifactContext =
              finalParts.hasStreamUi && finalParts.streamui.trim()
                ? buildArtifactContext(raw)
                : undefined;

            if (finalParts.hasStreamUi && finalParts.streamui.trim()) {
              renderer.replace(finalParts.streamui);
              renderer.complete();
              finalSnapshot = renderer.getSnapshot();
            }

            updateAssistant(message.id, {
              content: finalParts.chat || finalParts.fallbackText,
              reasoning,
              ...(finalParts.sessionTitleComplete && finalParts.sessionTitle.trim()
                ? { sessionTitle: finalParts.sessionTitle }
                : {}),
              rawStream: raw,
              streamSequence: lastStreamSequence,
              ...(finalSnapshot ? { snapshot: finalSnapshot } : {}),
              ...(artifactContext ? { artifactContext } : {}),
              hasStreamUi:
                finalParts.hasStreamUi && finalParts.streamui.trim().length > 0,
              streamUiComplete: finalParts.streamUiComplete,
              status: "complete"
            });
          } catch (error) {
            if (completedFromServer) {
              return;
            }
            if (
              cancelledRunIdsRef.current.has(generationRunId) ||
              controller.signal.aborted ||
              isAbortError(error)
            ) {
              updateAssistant(
                message.id,
                createCancelledAssistantPatch(raw, reasoning, lastStreamSequence)
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
    sessionState.sessions,
    sessionsLoaded,
    setSessionStateAndRef,
    themeMode,
    updateAssistant
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
    isRunning: isActiveSessionSending || isLocalArtifactEditRunning,
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
