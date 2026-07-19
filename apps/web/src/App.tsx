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
import { AuthChoiceDialog } from "./components/AuthChoiceDialog";
import { BugReportDialog } from "./components/BugReportDialog";
import { LocalSessionMergeDialog } from "./components/LocalSessionMergeDialog";
import { SessionPersistenceStatus } from "./components/SessionPersistenceStatus";
import { SessionSidebar } from "./components/SessionSidebar";
import {
  loadAccountMode,
  saveAccountMode,
  type AccountMode
} from "./core/accountMode";
import {
  deleteAccount as deleteCloudAccount,
  downloadAccountExport,
  generateRecoveryCode
} from "./core/cloudAuth";
import { providerSupportsReasoning } from "./core/apiSettings";
import type { MemoryStreamEvent } from "./core/memoryStreamEvents";
import {
  createId,
  isSessionEmpty,
  type SessionState
} from "./domain/chat/sessionModel";
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
  getAssistantForUserTurn,
  getVisibleSessionMessages
} from "./features/chat/branching";
import {
  getArtifactEditSubmissionError,
  submitComposerMessage
} from "./features/chat/composerSubmissionController";
import {
  clearLegacyLocalSessions,
  loadLegacyLocalSessionState,
  loadSessionClientId,
  saveCachedSessionListPreview
} from "./features/sessions/sessionPersistence";
import { normalizeAdminSessionArchive } from "./features/sessions/adminSessionArchive";
import {
  deleteSessionFile,
  requestAdminSessions,
  requestSessions,
  saveSerializedSessionState,
  saveSessionStateOnPageExit,
  uploadSessionFile
} from "./features/sessions/sessionApi";
import {
  createBrowserLocalSessionFile,
  BROWSER_LOCAL_WORKSPACE_STORAGE_KEY,
  browserLocalWorkspaceSignature,
  browserLocalWorkspaceStorageVersion,
  clearBrowserLocalWorkspaceIfUnchanged,
  flushBrowserLocalWorkspace,
  loadBrowserLocalWorkspace,
  requestBrowserLocalWorkspace,
  saveBrowserLocalWorkspace
} from "./features/sessions/browserLocalWorkspace";
import { mergeLocalWorkspaceIntoAccount } from "./features/sessions/localWorkspaceMerge";
import {
  clearKeptLocalWorkspace,
  hasKeptLocalWorkspace,
  rememberKeptLocalWorkspace
} from "./features/sessions/localWorkspaceDecision";
import { useSessionSync } from "./features/sessions/useSessionSync";
import { useSessionSave } from "./features/sessions/useSessionSave";
import { useSessionIndex } from "./features/sessions/useSessionIndex";
import { useSessionActions } from "./features/sessions/useSessionActions";
import { createDeferredSessionSelectionController } from "./features/sessions/deferredSessionSelection";
import { useComposerSessionDrafts } from "./features/sessions/useComposerSessionDrafts";
import { useSessionAttachmentController } from "./features/sessions/useSessionAttachmentController";
import { useSessionStateController } from "./features/sessions/useSessionStateController";
import { useSessionMessageMutations } from "./features/sessions/useSessionMessageMutations";
import {
  deriveSessionListItems,
  useSessionViewModel
} from "./features/sessions/useSessionViewModel";
import {
  useGeneratedArtifactBatchRecovery,
  useStaleArtifactEditSweep
} from "./features/sessions/useSessionMaintenance";
import { useFreshChatRunSender } from "./features/chat/useFreshChatRunSender";
import { usesBrowserDirectProvider } from "./features/providers/browserDirectProvider";
import { useRestoredChatRuns } from "./features/chat/useRestoredChatRuns";
import { useArtifactSelections } from "./features/artifacts/useArtifactSelections";
import { isArtifactSelectionTargetActive } from "./features/artifacts/artifactSelectionController";
import { useArtifactActions } from "./features/artifacts/useArtifactActions";
import { useArtifactEditController } from "./features/artifacts/useArtifactEditController";
import { useArtifactEditSelection } from "./features/artifacts/useArtifactEditSelection";
import { artifactSelectionToReference } from "./features/artifacts/artifactMessageProjection";
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
import { selectContinueLocalApiSettings } from "./features/settings/settingsDraftModel";
import { resolveAccountLoginApiSettings } from "./features/settings/appSettingsPolicy";
import { useCloudAuthController } from "./features/auth/useCloudAuthController";
import type { SessionSaveStatus } from "./features/sessions/sessionSaveCoordinator";
import type {
  RenderSnapshot,
  StreamingRenderer
} from "./runtime/streamui/types";

const SESSION_SYNC_INTERVAL_MS = 4_000;
const SESSION_SAVE_DEBOUNCE_MS = 350;

type AuthenticatedWorkspaceScope = "account" | "local";

function meaningfulLocalState(state: SessionState | null): SessionState | null {
  if (!state) {
    return null;
  }
  const sessions = state.sessions.filter((session) => !isSessionEmpty(session));
  if (!sessions.length) {
    return null;
  }
  return {
    sessions,
    activeSessionId: sessions.some(
      (session) => session.id === state.activeSessionId
    )
      ? state.activeSessionId
      : sessions[0].id
  };
}

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
    reset: resetSessionState,
    setSessionsLoaded,
    setSessionsHydrated
  } = useSessionStateController();
  const [themeMode, setThemeMode] = usePersistentThemeMode();
  const {
    apiSettings: storedApiSettings,
    searchSettings,
    displaySettings,
    profileSettings,
    runtimeSettings,
    cloudEnabled,
    authRequired,
    replaceApiSettings: handleApiSettingsChange,
    replaceSearchSettings: handleSearchSettingsChange,
    replaceDisplaySettings: handleDisplaySettingsChange,
    replaceProfileSettings: handleProfileSettingsChange,
    updateApiSettings,
    applyMemoryEvent,
    memoryOwnerId,
    selectMemoryOwner
  } = useAppSettings();
  const {
    user: authenticatedUser,
    loaded: authLoaded,
    open: startOAuthAuthentication,
    close: closeAuthOverlay,
    refresh: refreshAuthSummary,
    logout: logoutCloudAccount
  } = useCloudAuthController({ cloudEnabled });
  const expectedMemoryOwnerId = authenticatedUser?.id ?? null;
  const isMemoryOwnerChanging = memoryOwnerId !== expectedMemoryOwnerId;
  const apiSettings = useMemo(
    () =>
      isMemoryOwnerChanging
        ? {
            ...storedApiSettings,
            userPreferencePrompt: "",
            memoryItems: []
          }
        : storedApiSettings,
    [isMemoryOwnerChanging, storedApiSettings]
  );
  const handleMemoryStreamEvent = useCallback(
    (event: MemoryStreamEvent) =>
      applyMemoryEvent(event, expectedMemoryOwnerId),
    [applyMemoryEvent, expectedMemoryOwnerId]
  );

  useEffect(() => {
    selectMemoryOwner(expectedMemoryOwnerId);
  }, [expectedMemoryOwnerId, selectMemoryOwner]);

  const [accountMode, setAccountMode] = useState<AccountMode>(loadAccountMode);
  const [authenticatedWorkspaceScope, setAuthenticatedWorkspaceScope] =
    useState<AuthenticatedWorkspaceScope>("account");
  const [localWorkspaceSnapshot, setLocalWorkspaceSnapshot] =
    useState<SessionState | null>(() => loadBrowserLocalWorkspace());
  const [accountWorkspaceSnapshot, setAccountWorkspaceSnapshot] =
    useState<SessionState | null>(null);
  const [isWorkspaceSwitching, setIsWorkspaceSwitching] = useState(false);
  const [isLocalMergeOpen, setIsLocalMergeOpen] = useState(false);
  const [isLocalMergeBusy, setIsLocalMergeBusy] = useState(false);
  const [localMergeError, setLocalMergeError] = useState<string | null>(null);
  const authenticatedUserIdRef = useRef<string | null>(null);
  const loginProviderDefaultUserIdRef = useRef<string | null>(null);
  const isAuthenticatedUserChanging =
    authenticatedUserIdRef.current !== (authenticatedUser?.id ?? null);
  const browserLocalWorkspace =
    authenticatedUser
      ? authenticatedWorkspaceScope === "local"
      : accountMode === "local" && apiSettings.apiKeySource === "manual";
  const adminSessionArchive = Boolean(
    authenticatedUser?.role === "admin" && !browserLocalWorkspace
  );
  const browserDirectProvider = usesBrowserDirectProvider(apiSettings);
  const sessionAccessEnabled = Boolean(
    runtimeSettings &&
      !isMemoryOwnerChanging &&
      (browserLocalWorkspace ||
        !authRequired ||
        (authLoaded && authenticatedUser))
  );
  const [isAuthChoiceOpen, setIsAuthChoiceOpen] = useState(false);
  const [providerSettingsRequestVersion, setProviderSettingsRequestVersion] =
    useState(0);
  const [sessionSaveStatus, setSessionSaveStatus] =
    useState<SessionSaveStatus>("idle");
  const [sessionSyncError, setSessionSyncError] = useState<string | null>(null);
  const [sessionSyncRetryVersion, setSessionSyncRetryVersion] = useState(0);
  const openAuthChoice = useCallback(() => {
    setIsAuthChoiceOpen(true);
  }, []);
  const [isSending, setIsSending] = useState(false);
  const [composerSubmissionError, setComposerSubmissionError] = useState<
    string | null
  >(null);
  const [composerAttachmentSafetyBlocked, setComposerAttachmentSafetyBlocked] =
    useState(false);
  const [composerAttachmentSafetyError, setComposerAttachmentSafetyError] =
    useState<string | null>(null);
  const handleSessionSyncError = useCallback(
    (phase: "load" | "sync") => {
      setSessionSyncError(
        phase === "load"
          ? "Sessions could not be loaded."
          : "Sessions could not sync."
      );
    },
    []
  );
  const handleSessionSyncSuccess = useCallback(() => {
    setSessionSyncError(null);
  }, []);
  const {
    activeSession,
    messages,
    sessionItems,
    getBranchInfo,
    activeFiles,
    isActiveSessionSending
  } = useSessionViewModel(sessionState);
  const sessionClientIdRef = useRef(loadSessionClientId());
  const browserLocalWorkspaceRef = useRef(browserLocalWorkspace);
  browserLocalWorkspaceRef.current = browserLocalWorkspace;
  const sessionSyncDependencies = useMemo(
    () =>
      browserLocalWorkspace
        ? {
            requestSessions: () => requestBrowserLocalWorkspace(),
            loadLegacyState: () => null
          }
        : adminSessionArchive
          ? {
              requestSessions: requestAdminSessions,
              normalizeServerState: normalizeAdminSessionArchive,
              loadLegacyState: () => null
            }
          : {
              requestSessions,
              loadLegacyState: loadLegacyLocalSessionState
            },
    [adminSessionArchive, browserLocalWorkspace]
  );
  const sessionSaveDependencies = useMemo(
    () =>
      browserLocalWorkspace
        ? {
            persist: (serializedState: string) =>
              saveBrowserLocalWorkspace(serializedState),
            flush: (serializedState: string) =>
              flushBrowserLocalWorkspace(serializedState)
          }
        : {
            persist: (
              serializedState: string,
              clientId: string,
              signal?: AbortSignal
            ) => saveSerializedSessionState(serializedState, clientId, signal),
            flush: (serializedState: string, clientId: string) =>
              saveSessionStateOnPageExit(serializedState, clientId)
          },
    [browserLocalWorkspace]
  );
  const attachmentDependencies = useMemo(
    () => ({
      uploadFile: async (
        sessionId: string,
        input: Parameters<typeof uploadSessionFile>[1],
        clientId: string
      ) =>
        browserLocalWorkspaceRef.current
          ? createBrowserLocalSessionFile(input)
          : uploadSessionFile(sessionId, input, clientId),
      deleteFile: (sessionId: string, fileId: string, clientId: string) =>
        browserLocalWorkspaceRef.current
          ? Promise.resolve()
          : deleteSessionFile(sessionId, fileId, clientId)
    }),
    []
  );
  const composerRuntimeRef = useRef<{ setText(text: string): void } | null>(null);
  const isSendingRef = useRef(isSending);
  const sessionNewOrDeleteBlockedRef = useRef(isSending);
  const sessionSelectionBlockedRef = useRef(false);
  const attachmentDraftsRef = useRef(false);
  const composerDraftSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const composerAttachmentSafetyBlockedRef = useRef(false);
  const sessionSaveReadyRef = useRef(sessionsLoaded && sessionsHydrated);
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
    sessionClientIdRef,
    dependencies: attachmentDependencies
  });
  attachmentDraftsRef.current = hasComposerAttachmentDrafts;
  sessionSaveReadyRef.current =
    !adminSessionArchive &&
    !isAuthenticatedUserChanging &&
    sessionsLoaded &&
    sessionsHydrated;
  sessionNewOrDeleteBlockedRef.current = isSending || adminSessionArchive;
  sessionSelectionBlockedRef.current = false;
  const handleAuthOverlayRequest = useCallback(() => {
    pendingVisualRepairSlot.clear();
    openManualAuth(pendingManagedRequestSlot, openAuthChoice);
  }, [openAuthChoice, pendingManagedRequestSlot, pendingVisualRepairSlot]);
  const handleAuthChoiceClose = useCallback(() => {
    setIsAuthChoiceOpen(false);
    pendingManagedRequestSlot.clear();
    pendingVisualRepairSlot.clear();
  }, [pendingManagedRequestSlot, pendingVisualRepairSlot]);
  const handleAuthChoiceSignIn = useCallback(() => {
    setIsAuthChoiceOpen(false);
    setAccountMode("unselected");
    saveAccountMode("unselected");
    startOAuthAuthentication();
  }, [startOAuthAuthentication]);
  const handleContinueLocal = useCallback(() => {
    setIsAuthChoiceOpen(false);
    pendingManagedRequestSlot.clear();
    pendingVisualRepairSlot.clear();
    resetSessionState();
    setAccountMode("local");
    saveAccountMode("local");
    updateApiSettings((current) =>
      selectContinueLocalApiSettings(current, runtimeSettings)
    );
    setProviderSettingsRequestVersion((current) => current + 1);
  }, [
    pendingManagedRequestSlot,
    pendingVisualRepairSlot,
    resetSessionState,
    runtimeSettings,
    updateApiSettings
  ]);
  const handleLogout = useCallback(async () => {
    try {
      await logoutCloudAccount();
    } finally {
      resetSessionState();
      pendingManagedRequestSlot.clear();
      pendingVisualRepairSlot.clear();
    }
  }, [
    logoutCloudAccount,
    pendingManagedRequestSlot,
    pendingVisualRepairSlot,
    resetSessionState
  ]);
  const handleExportAccount = useCallback(() => {
    void downloadAccountExport().catch((error) => {
      setSessionSyncError(
        error instanceof Error ? error.message : "Account export failed."
      );
    });
  }, []);
  const handleDeleteAccount = useCallback(async () => {
    if (
      !window.confirm(
        "Permanently delete this account, all sessions, and uploaded files? This cannot be undone."
      )
    ) {
      return;
    }
    try {
      await deleteCloudAccount();
      await refreshAuthSummary();
      resetSessionState();
    } catch (error) {
      setSessionSyncError(
        error instanceof Error ? error.message : "Account deletion failed."
      );
    }
  }, [refreshAuthSummary, resetSessionState]);

  useEffect(() => {
    const nextUserId = authenticatedUser?.id ?? null;
    if (authenticatedUserIdRef.current !== nextUserId) {
      resetSessionState();
      setAuthenticatedWorkspaceScope("account");
      setAccountWorkspaceSnapshot(null);
      setLocalWorkspaceSnapshot(loadBrowserLocalWorkspace());
      setIsWorkspaceSwitching(false);
      setIsLocalMergeOpen(false);
      setIsLocalMergeBusy(false);
      setLocalMergeError(null);
      authenticatedUserIdRef.current = nextUserId;
    }
  }, [authenticatedUser?.id, resetSessionState]);

  useEffect(() => {
    const userId = authenticatedUser?.id ?? null;
    if (!userId) {
      loginProviderDefaultUserIdRef.current = null;
      return;
    }
    if (
      !runtimeSettings?.cloud?.enabled ||
      !runtimeSettings.cloud.managedProviderEnabled ||
      loginProviderDefaultUserIdRef.current === userId
    ) {
      return;
    }

    loginProviderDefaultUserIdRef.current = userId;
    updateApiSettings((current) =>
      resolveAccountLoginApiSettings(current, runtimeSettings)
    );
  }, [authenticatedUser?.id, runtimeSettings, updateApiSettings]);

  useEffect(() => {
    const handleBrowserWorkspaceChange = (event: StorageEvent) => {
      if (event.key === BROWSER_LOCAL_WORKSPACE_STORAGE_KEY) {
        setLocalWorkspaceSnapshot(loadBrowserLocalWorkspace());
      }
    };
    window.addEventListener("storage", handleBrowserWorkspaceChange);
    return () =>
      window.removeEventListener("storage", handleBrowserWorkspaceChange);
  }, []);

  useEffect(() => {
    if (
      authRequired &&
      authLoaded &&
      !authenticatedUser &&
      !browserLocalWorkspace
    ) {
      setIsAuthChoiceOpen(true);
    }
  }, [authLoaded, authRequired, authenticatedUser, browserLocalWorkspace]);

  useEffect(() => {
    if (!authRequired) {
      return;
    }
    saveCachedSessionListPreview(null);
    clearLegacyLocalSessions();
  }, [authRequired]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

  useEffect(() => {
    setComposerSubmissionError(null);
  }, [sessionState.activeSessionId]);

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
    enabled:
      sessionAccessEnabled &&
      !isAuthenticatedUserChanging &&
      !browserLocalWorkspace &&
      !adminSessionArchive,
    cacheEnabled: Boolean(runtimeSettings && !authRequired),
    sessionState,
    sessionsHydrated,
    sessionClientIdRef,
    sessionsHydratedRef
  });

  useSessionSync({
    enabled:
      sessionAccessEnabled &&
      !isAuthenticatedUserChanging &&
      !isLocalMergeBusy,
    sessionsLoaded,
    intervalMs: SESSION_SYNC_INTERVAL_MS,
    sessionClientIdRef,
    sessionStateRef,
    sessionsLoadedRef,
    sessionsHydratedRef,
    deletedSessionIdsRef,
    transientEmptySessionIdRef,
    protectedEmptySessionIdsRef: composerDraftSessionIdsRef,
    runConnectionsRef,
    cancelledRunIdsRef,
    attachmentDraftsRef,
    updateState: setSessionStateAndRef,
    setSessionsLoaded,
    setSessionsHydrated,
    retryVersion: sessionSyncRetryVersion,
    onError: handleSessionSyncError,
    onSuccess: handleSessionSyncSuccess,
    dependencies: sessionSyncDependencies
  });

  useStaleArtifactEditSweep(
    sessionAccessEnabled &&
      !isAuthenticatedUserChanging &&
      !isLocalMergeBusy &&
      !adminSessionArchive &&
      sessionsLoaded,
    setSessionStateAndRef
  );

  const saveCurrentSessionStateNow = useSessionSave({
    sessionState,
    sessionsLoaded:
      sessionAccessEnabled &&
      !adminSessionArchive &&
      !isAuthenticatedUserChanging &&
      !isLocalMergeBusy &&
      sessionsLoaded &&
      sessionsHydrated,
    debounceMs: SESSION_SAVE_DEBOUNCE_MS,
    sessionStateRef,
    sessionsLoadedRef: sessionSaveReadyRef,
    sessionClientIdRef,
    deletedSessionIdsRef,
    onStatusChange: setSessionSaveStatus,
    dependencies: sessionSaveDependencies
  });

  useEffect(() => {
    if (isAuthenticatedUserChanging || !sessionsHydrated) {
      return;
    }
    if (browserLocalWorkspace) {
      setLocalWorkspaceSnapshot(meaningfulLocalState(sessionState));
    } else if (authenticatedUser) {
      setAccountWorkspaceSnapshot(sessionState);
    }
  }, [
    authenticatedUser,
    browserLocalWorkspace,
    isAuthenticatedUserChanging,
    sessionState,
    sessionsHydrated
  ]);

  const localStateAvailableToAccount = useMemo(
    () => meaningfulLocalState(localWorkspaceSnapshot),
    [localWorkspaceSnapshot]
  );
  const localWorkspaceDecisionSignature = useMemo(
    () =>
      localStateAvailableToAccount
        ? browserLocalWorkspaceSignature(localStateAvailableToAccount)
        : "",
    [localStateAvailableToAccount]
  );

  useEffect(() => {
    if (
      !authenticatedUser ||
      authenticatedUser.role === "admin" ||
      isAuthenticatedUserChanging ||
      authenticatedWorkspaceScope !== "account" ||
      !sessionsLoaded ||
      !sessionsHydrated ||
      !localStateAvailableToAccount ||
      isLocalMergeOpen ||
      hasKeptLocalWorkspace(
        authenticatedUser.id,
        localWorkspaceDecisionSignature
      )
    ) {
      return;
    }
    setLocalMergeError(null);
    setIsLocalMergeOpen(true);
  }, [
    authenticatedUser,
    authenticatedWorkspaceScope,
    isAuthenticatedUserChanging,
    isLocalMergeOpen,
    localStateAvailableToAccount,
    localWorkspaceDecisionSignature,
    sessionsHydrated,
    sessionsLoaded
  ]);

  const handleKeepLocalWorkspace = useCallback(() => {
    if (!authenticatedUser || !localStateAvailableToAccount) {
      setIsLocalMergeOpen(false);
      return;
    }
    rememberKeptLocalWorkspace(
      authenticatedUser.id,
      browserLocalWorkspaceSignature(localStateAvailableToAccount)
    );
    setLocalMergeError(null);
    setIsLocalMergeOpen(false);
  }, [authenticatedUser, localStateAvailableToAccount]);

  const handleMergeLocalWorkspace = useCallback(async () => {
    if (!authenticatedUser || !localStateAvailableToAccount) {
      setIsLocalMergeOpen(false);
      return;
    }
    setIsLocalMergeBusy(true);
    setLocalMergeError(null);
    try {
      const saveOutcome = await saveCurrentSessionStateNow();
      if (saveOutcome === "failed") {
        throw new Error(
          "Your account workspace could not be saved before the merge."
        );
      }
      const importedLocalVersion = browserLocalWorkspaceStorageVersion();
      const latestLocalState =
        loadBrowserLocalWorkspace() ?? localStateAvailableToAccount;
      const mergedState = await mergeLocalWorkspaceIntoAccount(
        latestLocalState,
        sessionClientIdRef.current
      );
      setAccountWorkspaceSnapshot(mergedState);
      setSessionStateAndRef(mergedState);
      setSessionSyncError(null);
      if (
        !clearBrowserLocalWorkspaceIfUnchanged(importedLocalVersion)
      ) {
        setLocalWorkspaceSnapshot(loadBrowserLocalWorkspace());
        throw new Error(
          "Local sessions changed in another tab during the merge. The " +
            "imported snapshot is safe in your account and the newer browser " +
            "copy was kept; merge again to bring it up to date."
        );
      }
      clearKeptLocalWorkspace(authenticatedUser.id);
      setLocalWorkspaceSnapshot(null);
      setIsLocalMergeOpen(false);
    } catch (error) {
      setLocalMergeError(
        error instanceof Error
          ? error.message
          : "The local sessions could not be saved to your account."
      );
    } finally {
      setIsLocalMergeBusy(false);
    }
  }, [
    authenticatedUser,
    localStateAvailableToAccount,
    saveCurrentSessionStateNow,
    sessionClientIdRef,
    setSessionStateAndRef
  ]);
  const handleSessionPersistenceRetry = useCallback(() => {
    setSessionSyncError(null);
    setSessionSyncRetryVersion((current) => current + 1);
    void saveCurrentSessionStateNow();
  }, [saveCurrentSessionStateNow]);

  useGeneratedArtifactBatchRecovery({
    sessions: sessionState.sessions,
    sessionsLoaded: sessionsLoaded && !adminSessionArchive,
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
    protectedEmptySessionIdsRef: composerDraftSessionIdsRef,
    deletedSessionIdsRef,
    replaceState: setSessionStateAndRef,
    saveNow: saveCurrentSessionStateNow,
    defaultModel: apiSettings.model,
    defaultReasoningEffort: apiSettings.reasoningEffort,
    defaultUiComplexity: apiSettings.uiComplexity
  });
  const selectSessionRef = useRef(handleSelectSession);
  selectSessionRef.current = handleSelectSession;
  const [deferredSessionSelection] = useState(() =>
    createDeferredSessionSelectionController({
      hasSession: (sessionId) =>
        sessionStateRef.current.sessions.some(
          (session) => session.id === sessionId
        ),
      selectSession: (sessionId) => selectSessionRef.current(sessionId)
    })
  );
  const requestSidebarSessionSelection = useCallback(
    (sessionId: string) => {
      deferredSessionSelection.request(
        sessionId,
        sessionsHydratedRef.current
      );
    },
    [deferredSessionSelection, sessionsHydratedRef]
  );

  useEffect(() => {
    if (sessionsHydrated) {
      deferredSessionSelection.flush(true);
      return;
    }
    if (sessionsLoaded) {
      deferredSessionSelection.clear();
    }
  }, [deferredSessionSelection, sessionsHydrated, sessionsLoaded]);

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
    isCapturing: isBugReportCapturing,
    isSubmitting: isBugReportSubmitting,
    isSubmitted: isBugReportSubmitted,
    captureError: bugReportCaptureError,
    submitError: bugReportSubmitError,
    open: handleBugReportOpen,
    captureScreenshot: handleBugReportScreenshotCapture,
    changeDraft: handleBugReportDraftChange,
    close: handleBugReportClose,
    discard: handleBugReportDiscard,
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
    openAuthentication: openAuthChoice,
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
    openAuthOverlay: openAuthChoice,
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
        return false;
      }

      const activeUser = visibleMessages[userIndex];
      if (!activeUser || activeUser.role !== "user") {
        return false;
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
      return true;
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
    openAuthentication: openAuthChoice
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
    getActiveVisualRepairRun,
    browserDirect: browserDirectProvider
  });

  const messageRevisionController = useMemo(
    () =>
      createMessageRevisionController({
        getState: () => sessionStateRef.current,
        getActiveSessionId: () => activeSessionIdRef.current,
        isBusy: generationActivity.isBusy,
        regenerateArtifactEdit: regenerateArtifactEditNode,
        startGeneratedArtifactBatch,
        startVisualRepair: handleVisualRepairAssistant,
        startBranchedTurn
      }),
    [
      handleVisualRepairAssistant,
      generationActivity,
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
    sessionsLoaded:
      sessionsLoaded && !browserLocalWorkspace && !adminSessionArchive,
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
      if (adminSessionArchive) {
        return;
      }
      if (
        isAttachmentSendBlocked ||
        composerAttachmentSafetyBlockedRef.current
      ) {
        setComposerAttachmentSafetyError(
          "Attachments are still switching between sessions. Retry cleanup before sending."
        );
        return;
      }

      const text = getAppendMessageText(message);
      const attachments = getAppendMessageImages(message);
      const submission = await submitComposerMessage(text, attachments, {
        getSelections: getArtifactSelections,
        runSourceEdit: runArtifactSourceEdit,
        startArtifactGeneration: async (
          prompt,
          artifactSelections,
          artifactAttachments
        ) => {
          const selectedMessageIds = Array.from(
            new Set(artifactSelections.map((selection) => selection.messageId))
          );
          const assistantId = selectedMessageIds[0];
          const session = sessionStateRef.current.sessions.find(
            (candidate) => candidate.id === activeSessionIdRef.current
          );
          if (!session || !assistantId || selectedMessageIds.length !== 1) {
            return false;
          }

          const visibleMessages = getVisibleSessionMessages(session);
          const assistantIndex = visibleMessages.findIndex(
            (candidate) =>
              candidate.id === assistantId && candidate.role === "assistant"
          );
          let sourceUserMessageId = "";
          for (let index = assistantIndex - 1; index >= 0; index -= 1) {
            if (visibleMessages[index]?.role === "user") {
              sourceUserMessageId = visibleMessages[index].id;
              break;
            }
          }
          if (assistantIndex < 0 || !sourceUserMessageId || !prompt.trim()) {
            return false;
          }

          const result = startGeneratedArtifactBatch({
            sessionId: session.id,
            assistantId,
            sourceUserMessageId,
            prompt,
            references: artifactSelections.map(artifactSelectionToReference),
            attachments: artifactAttachments,
            ephemeralAttachments: true,
            historyMode: "through-target-assistant",
            initialReasoning: "Thinking",
            onRunInitialized: () => undefined,
            onRunAccepted: clearArtifactSelections
          });
          if (result.status !== "started") {
            return false;
          }
          return result.initialization;
        },
        sendChat: (chatText, chatAttachments) => {
          clearArtifactSelections();
          return sendStreamUiRequest(chatText, chatAttachments);
        }
      });
      if (submission.kind === "artifact-edit") {
        const error = getArtifactEditSubmissionError(submission.editOutcome);
        setComposerSubmissionError(error);
        if (error) {
          composerRuntimeRef.current?.setText(text);
        }
        return;
      }
      setComposerSubmissionError(null);
    },
    [
      activeSessionIdRef,
      adminSessionArchive,
      clearArtifactSelections,
      isAttachmentSendBlocked,
      getArtifactSelections,
      runArtifactSourceEdit,
      sendStreamUiRequest,
      sessionStateRef,
      startGeneratedArtifactBatch
    ]
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning:
      isActiveSessionSending ||
      isLocalArtifactEditRunning ||
      isVisualRepairRunning,
    isSendDisabled:
      adminSessionArchive ||
      isSending ||
      isAttachmentSendBlocked ||
      composerAttachmentSafetyBlocked,
    convertMessage,
    onNew: handleNewMessage,
    onCancel: handleCancelRun,
    adapters: {
      attachments: attachmentAdapter
    }
  });

  const composerSessionDrafts = useComposerSessionDrafts({
    composer: runtime.thread.composer,
    activeSessionId: sessionState.activeSessionId,
    onError: (message, error) => {
      console.warn(message, error);
      setComposerAttachmentSafetyError(message);
    },
    onAttachmentSafetyChange: (blocked) => {
      composerAttachmentSafetyBlockedRef.current = blocked;
      setComposerAttachmentSafetyBlocked(blocked);
      if (!blocked) {
        setComposerAttachmentSafetyError(null);
      }
    },
    onDraftSessionIdsChange: (sessionIds) => {
      composerDraftSessionIdsRef.current = sessionIds;
    }
  });
  composerRuntimeRef.current = runtime.thread.composer;
  const handleSidebarNewSession = useCallback(() => {
    composerSessionDrafts.capture();
    handleNewSession();
  }, [composerSessionDrafts, handleNewSession]);
  const workspaceSelectionPendingRef = useRef<{
    scope: AuthenticatedWorkspaceScope;
    sessionId: string;
  } | null>(null);
  const switchAuthenticatedWorkspace = useCallback(
    async (scope: AuthenticatedWorkspaceScope, sessionId: string) => {
      if (
        !authenticatedUser ||
        scope === authenticatedWorkspaceScope ||
        isWorkspaceSwitching
      ) {
        return;
      }
      setIsWorkspaceSwitching(true);
      const saveOutcome = await saveCurrentSessionStateNow();
      if (saveOutcome === "failed") {
        setSessionSyncError(
          "Sessions could not sync before switching workspace."
        );
        setIsWorkspaceSwitching(false);
        return;
      }

      if (authenticatedWorkspaceScope === "local") {
        setLocalWorkspaceSnapshot(
          meaningfulLocalState(sessionStateRef.current)
        );
      } else {
        setAccountWorkspaceSnapshot(sessionStateRef.current);
      }
      workspaceSelectionPendingRef.current = { scope, sessionId };
      resetSessionState();
      setAuthenticatedWorkspaceScope(scope);
      requestSidebarSessionSelection(sessionId);
    },
    [
      authenticatedUser,
      authenticatedWorkspaceScope,
      isWorkspaceSwitching,
      requestSidebarSessionSelection,
      resetSessionState,
      saveCurrentSessionStateNow,
      sessionStateRef
    ]
  );
  const handleSidebarSelectSession = useCallback(
    (sessionId: string, local: boolean) => {
      composerSessionDrafts.capture();
      if (
        authenticatedUser &&
        local !== (authenticatedWorkspaceScope === "local")
      ) {
        void switchAuthenticatedWorkspace(
          local ? "local" : "account",
          sessionId
        );
        return;
      }
      requestSidebarSessionSelection(sessionId);
    },
    [
      authenticatedUser,
      authenticatedWorkspaceScope,
      composerSessionDrafts,
      requestSidebarSessionSelection,
      switchAuthenticatedWorkspace
    ]
  );
  const handleSidebarDeleteSession = useCallback(
    (sessionId: string, local: boolean) => {
      if (
        authenticatedUser &&
        local !== (authenticatedWorkspaceScope === "local")
      ) {
        return;
      }
      composerSessionDrafts.capture();
      const outcome = handleDeleteSession(sessionId);
      if (outcome === "deleted" || outcome === "tombstoned-only") {
        composerSessionDrafts.discardSession(sessionId);
      }
    },
    [
      authenticatedUser,
      authenticatedWorkspaceScope,
      composerSessionDrafts,
      handleDeleteSession
    ]
  );

  useEffect(() => {
    const pending = workspaceSelectionPendingRef.current;
    if (
      !pending ||
      pending.scope !== authenticatedWorkspaceScope ||
      !sessionsLoaded
    ) {
      return;
    }
    setIsWorkspaceSwitching(false);
    if (sessionsHydrated) {
      workspaceSelectionPendingRef.current = null;
    }
  }, [authenticatedWorkspaceScope, sessionsHydrated, sessionsLoaded]);

  const sidebarPreview =
    !browserLocalWorkspace && !sessionsLoaded && sessionListPreview
      ? sessionListPreview
      : null;
  const currentSidebarItems = sidebarPreview?.sessions ?? sessionItems;
  const accountSidebarItems =
    authenticatedWorkspaceScope === "account"
      ? currentSidebarItems
      : deriveSessionListItems(accountWorkspaceSnapshot?.sessions ?? []);
  const localSidebarItems =
    authenticatedWorkspaceScope === "local"
      ? currentSidebarItems
      : deriveSessionListItems(localStateAvailableToAccount?.sessions ?? []);
  const sidebarSessionItems = authenticatedUser
    ? [
        ...accountSidebarItems.map((session) => ({ ...session, local: false })),
        ...localSidebarItems.map((session) => ({ ...session, local: true }))
      ]
    : currentSidebarItems;
  const sidebarActiveSessionId =
    sidebarPreview?.activeSessionId ?? sessionState.activeSessionId;
  return (
    <>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatShell
          themeMode={themeMode}
          onThemeModeChange={setThemeMode}
          workspaceStatus={
            <SessionPersistenceStatus
              saveStatus={sessionSaveStatus}
              syncError={sessionSyncError}
              onRetry={handleSessionPersistenceRetry}
            />
          }
          sidebar={
            <SessionSidebar
              sessions={sidebarSessionItems}
              activeSessionId={sidebarActiveSessionId}
              activeSessionLocal={
                Boolean(authenticatedUser) &&
                authenticatedWorkspaceScope === "local"
              }
              isSending={isSending}
              readOnly={adminSessionArchive}
              isSessionSelectionBlocked={isWorkspaceSwitching}
              themeMode={themeMode}
              apiSettings={apiSettings}
              searchSettings={searchSettings}
              displaySettings={displaySettings}
              profileSettings={profileSettings}
              runtimeSettings={runtimeSettings}
              cloudEnabled={cloudEnabled}
              accountMode={accountMode}
              authUser={authenticatedUser}
              onNewSession={handleSidebarNewSession}
              onSelectSession={handleSidebarSelectSession}
              onDeleteSession={handleSidebarDeleteSession}
              onApiSettingsChange={handleApiSettingsChange}
              onSearchSettingsChange={handleSearchSettingsChange}
              onDisplaySettingsChange={handleDisplaySettingsChange}
              onProfileSettingsChange={handleProfileSettingsChange}
              onLoginRequest={handleAuthOverlayRequest}
              onLogout={handleLogout}
              onExportAccount={handleExportAccount}
              onDeleteAccount={() => void handleDeleteAccount()}
              onGenerateRecoveryCode={generateRecoveryCode}
              onBugReportOpen={() => void handleBugReportOpen()}
              isBugReportCapturing={isBugReportCapturing}
              providerSettingsRequestVersion={providerSettingsRequestVersion}
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
              displaySettings.artifactEditingEnabled && !adminSessionArchive
            }
            readOnly={adminSessionArchive}
            model={activeSessionModel}
            modelOptions={selectableModels}
            reasoningEffort={activeSessionReasoningEffort}
            reasoningSupported={providerSupportsReasoning(apiSettings.providerId)}
            composerSubmissionError={composerSubmissionError}
            composerAttachmentSafetyBlocked={composerAttachmentSafetyBlocked}
            composerAttachmentSafetyError={composerAttachmentSafetyError}
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
            onDismissComposerSubmissionError={() =>
              setComposerSubmissionError(null)
            }
            onRetryComposerAttachmentCleanup={() =>
              composerSessionDrafts.retryAttachmentCleanup()
            }
            onUiComplexityChange={handleUiComplexityChange}
          />
        </ChatShell>
      </AssistantRuntimeProvider>
      {isAuthChoiceOpen ? (
        <AuthChoiceDialog
          themeMode={themeMode}
          onClose={handleAuthChoiceClose}
          onSignIn={handleAuthChoiceSignIn}
          onContinueLocal={handleContinueLocal}
          required={authRequired}
        />
      ) : null}
      {isLocalMergeOpen && localStateAvailableToAccount ? (
        <LocalSessionMergeDialog
          themeMode={themeMode}
          sessionCount={localStateAvailableToAccount.sessions.length}
          isMerging={isLocalMergeBusy}
          error={localMergeError}
          onMerge={() => void handleMergeLocalWorkspace()}
          onKeepLocal={handleKeepLocalWorkspace}
        />
      ) : null}
      {isBugReportOpen && bugReportSession ? (
        <BugReportDialog
          draft={bugReportDraft}
          themeMode={themeMode}
          captureError={bugReportCaptureError}
          submitError={bugReportSubmitError}
          isCapturing={isBugReportCapturing}
          isSubmitting={isBugReportSubmitting}
          isSubmitted={isBugReportSubmitted}
          onChange={handleBugReportDraftChange}
          onCapture={() => void handleBugReportScreenshotCapture()}
          onClose={handleBugReportClose}
          onDiscard={handleBugReportDiscard}
          onSubmit={(draft) => void handleBugReportSubmit(draft)}
        />
      ) : null}
    </>
  );
}
