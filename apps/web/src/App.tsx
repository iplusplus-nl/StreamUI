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
import { StreamImageAttachmentAdapter } from "./core/assistantAttachments";
import { blobToDataUrl } from "./core/blob";
import {
  getSelectableModelOptions,
  normalizeApiSettings,
  normalizeUiComplexity,
  serializeApiSettings,
  type ReasoningEffort
} from "./core/apiSettings";
import { serializeSearchSettings } from "./core/searchSettings";
import {
  loadAuthSummary,
  logout as logoutAuth,
  type AuthSummary,
  type AuthUser
} from "./core/cloudAuth";
import { buildArtifactContext } from "./core/artifactContext";
import type { ArtifactSelection } from "./core/artifactSelection";
import {
  getSnapshotDiagnostics,
  renderSnapshotToPngBlob
} from "./core/artifactExport";
import { captureCurrentPageScreenshotBlob } from "./core/pageScreenshot";
import { modelLikelySupportsImageInput } from "./core/modelCapabilities";
import {
  compactEmptySessions,
  createEmptyBugReportDraft,
  createEmptySession,
  createId,
  createInitialSessionState,
  getSessionStreamingRunIds,
  interruptStaleArtifactEditsInSessionState,
  initialMessages,
  isSessionEmpty,
  normalizeStoredSessionState,
  normalizeBugReportDraft,
  sortSessions,
  MAX_BUG_REPORT_IMAGES,
  STALE_ARTIFACT_EDIT_SWEEP_INTERVAL_MS,
  STREAM_INTERRUPTED_ERROR,
  summarizeSession,
  type ArtifactEdit,
  type BugReportDraft,
  type BugReportImage,
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
import {
  convertMessage,
  getAppendMessageImages,
  getAppendMessageText
} from "./features/chat/assistantRuntimeAdapter";
import { StreamThread } from "./features/chat/ui/StreamThread";
import { submitBugReport } from "./features/bug-reports/bugReportApi";
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
  deleteSessionFile,
  requestSessions,
  uploadSessionFile
} from "./features/sessions/sessionApi";
import {
  loadSessionClientId
} from "./features/sessions/sessionPersistence";
import {
  findSessionIdForMessage,
  findSessionMessage,
  mergeSessionFiles
} from "./features/sessions/sessionSelectors";
import { useSessionSync } from "./features/sessions/useSessionSync";
import { useSessionSave } from "./features/sessions/useSessionSave";
import { useSessionIndex } from "./features/sessions/useSessionIndex";
import {
  commitUploadedImageFile,
  createArtifactFileUpload,
  imageAttachmentToFileUpload
} from "./features/sessions/sessionFileModel";
import {
  getArtifactEditActiveVariant,
  getArtifactEditCompleteRawStream,
  getArtifactEditDisplayRawStream,
  getArtifactEditParentId,
  getArtifactEditRawStream,
  getResolvedArtifactEditId,
  hasUsableArtifactEditVariant
} from "./features/artifacts/artifactEditModel";
import { requestArtifactEdit } from "./features/artifacts/artifactEditApi";
import {
  completeArtifactEditVariant,
  failArtifactEditVariant,
  removeArtifactEdit
} from "./features/artifacts/artifactEditTransitions";
import {
  artifactSelectionToReference,
  buildArtifactActionMessage,
  buildCompletedAssistantPatchFromRawStream
} from "./features/artifacts/artifactMessageProjection";
import { hasRenderError } from "./features/artifacts/renderErrors";
import { buildVisualRepairPrompt } from "./features/artifacts/visualRepair";
import { coerceApiSettingsForRuntime } from "./features/settings/appSettingsPolicy";
import { useAppSettings } from "./features/settings/useAppSettings";
import type {
  ImageAttachment,
  UploadedSessionFile
} from "./core/imageAttachments";
import { extractStreamUiParts } from "./runtime/streamui/protocol";
import { createStreamingRenderer } from "./runtime/streamui/streamingRenderer";
import type {
  RenderError,
  RenderSnapshot,
  StreamUiAction,
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

type PendingArtifactAction = {
  messageId: string;
  action: StreamUiAction;
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
  const [authSummary, setAuthSummary] = useState<AuthSummary | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [isAuthOverlayOpen, setIsAuthOverlayOpen] = useState(false);
  const [isBugReportOpen, setIsBugReportOpen] = useState(false);
  const [bugReportSessionId, setBugReportSessionId] = useState<string | null>(
    null
  );
  const [isBugReportCapturing, setIsBugReportCapturing] = useState(false);
  const [isBugReportSubmitting, setIsBugReportSubmitting] = useState(false);
  const [isBugReportSubmitted, setIsBugReportSubmitted] = useState(false);
  const [bugReportCaptureError, setBugReportCaptureError] = useState<
    string | null
  >(null);
  const [bugReportSubmitError, setBugReportSubmitError] = useState<string | null>(
    null
  );
  const [isSending, setIsSending] = useState(false);
  const [attachmentUploadGate, setAttachmentUploadGate] = useState<{
    inFlight: number;
    errorIds: string[];
  }>({
    inFlight: 0,
    errorIds: []
  });
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
  const bugReportSession =
    sessionState.sessions.find(
      (session) => session.id === (bugReportSessionId ?? sessionState.activeSessionId)
    ) ?? activeSession;
  const bugReportDraft =
    bugReportSession?.bugReportDraft ?? createEmptyBugReportDraft();
  const activeSessionModel = activeSession?.model || apiSettings.model;
  const activeSessionReasoningEffort =
    activeSession?.reasoningEffort ?? apiSettings.reasoningEffort;
  const activeSessionUiComplexity = normalizeUiComplexity(
    activeSession?.uiComplexity ?? apiSettings.uiComplexity
  );
  const authenticatedUser = cloudEnabled ? (authSummary?.user ?? null) : null;
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
  const artifactSelectionsRef = useRef<ArtifactSelection[]>([]);
  const sessionsLoadedRef = useRef(sessionsLoaded);
  const sessionsHydratedRef = useRef(sessionsHydrated);
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());
  const runConnectionsRef = useRef<Map<string, AbortController>>(new Map());
  const cancelledRunIdsRef = useRef<Set<string>>(new Set());
  const branchRunCancelCleanupRef = useRef<
    Map<string, BranchRunCancelCleanup>
  >(new Map());
  const bugReportSuccessCloseTimerRef = useRef<number | null>(null);
  const localArtifactEditAbortRef = useRef<AbortController | null>(null);
  const pendingManagedRequestRef = useRef<PendingManagedRequest | null>(null);
  const pendingArtifactActionRef = useRef<PendingArtifactAction | null>(null);
  const [artifactSelectionClearVersion, setArtifactSelectionClearVersion] =
    useState(0);
  const attachmentAdapter = useMemo(
    () =>
      new StreamImageAttachmentAdapter({
        getSessionId: () => activeSessionIdRef.current,
        uploadImage: async (sessionId, attachment) => {
          const file = await uploadSessionFile(
            sessionId,
            imageAttachmentToFileUpload(attachment, undefined, true),
            sessionClientIdRef.current
          );
          if (file.kind !== "image") {
            throw new Error("Image upload returned a non-image file.");
          }
          return file as UploadedSessionFile;
        },
        deleteFile: (sessionId, fileId) =>
          deleteSessionFile(sessionId, fileId, sessionClientIdRef.current),
        onUploadStart: (id) => {
          setAttachmentUploadGate((current) => ({
            inFlight: current.inFlight + 1,
            errorIds: current.errorIds.filter((errorId) => errorId !== id)
          }));
        },
        onUploadComplete: (id) => {
          setAttachmentUploadGate((current) => ({
            inFlight: Math.max(0, current.inFlight - 1),
            errorIds: current.errorIds.filter((errorId) => errorId !== id)
          }));
        },
        onUploadError: (id) => {
          setAttachmentUploadGate((current) => ({
            inFlight: Math.max(0, current.inFlight - 1),
            errorIds: current.errorIds.includes(id)
              ? current.errorIds
              : [...current.errorIds, id]
          }));
        },
        onRemove: (id) => {
          setAttachmentUploadGate((current) => ({
            ...current,
            errorIds: current.errorIds.filter((errorId) => errorId !== id)
          }));
        }
      }),
    []
  );
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
  const refreshAuthSummary = useCallback(async () => {
    if (!cloudEnabled) {
      setAuthSummary(null);
      setAuthLoaded(false);
      return null;
    }

    const summary = await loadAuthSummary();
    setAuthSummary(summary);
    setAuthLoaded(true);
    return summary;
  }, [cloudEnabled]);
  const handleAuthChange = useCallback((summary: AuthSummary) => {
    setAuthSummary(summary);
    setAuthLoaded(true);
    setIsAuthOverlayOpen(false);
  }, []);
  const handleAuthOverlayRequest = useCallback(() => {
    pendingManagedRequestRef.current = null;
    setIsAuthOverlayOpen(true);
  }, []);
  const handleAuthOverlayClose = useCallback(() => {
    pendingManagedRequestRef.current = null;
    setIsAuthOverlayOpen(false);
  }, []);
  const handleLogout = useCallback(async () => {
    try {
      const summary = await logoutAuth();
      setAuthSummary(summary);
    } catch (error) {
      console.warn("Could not sign out of ChatHTML Cloud.", error);
      setAuthSummary((current) =>
        current
          ? { ...current, user: null }
          : {
              user: null,
              auth: {
                available: false,
                requiresInvite: false,
                firstUser: false
              }
            }
      );
    } finally {
      setAuthLoaded(true);
      setIsAuthOverlayOpen(false);
      pendingManagedRequestRef.current = null;
    }
  }, []);
  const handleAuthUserChange = useCallback((user: AuthUser) => {
    setAuthSummary((current) =>
      current
        ? { ...current, user }
        : {
            user,
            auth: {
              available: true,
              requiresInvite: false,
              firstUser: false
            }
          }
    );
    setAuthLoaded(true);
  }, []);

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
      if (bugReportSuccessCloseTimerRef.current !== null) {
        window.clearTimeout(bugReportSuccessCloseTimerRef.current);
        bugReportSuccessCloseTimerRef.current = null;
      }
      localArtifactEditAbortRef.current?.abort();
      localArtifactEditAbortRef.current = null;
      runConnectionsRef.current.forEach((controller) => controller.abort());
      runConnectionsRef.current.clear();
      branchRunCancelCleanupRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!cloudEnabled) {
      setAuthSummary(null);
      setAuthLoaded(false);
      setIsAuthOverlayOpen(false);
      pendingManagedRequestRef.current = null;
      return undefined;
    }

    let cancelled = false;
    loadAuthSummary()
      .then((summary) => {
        if (!cancelled) {
          setAuthSummary(summary);
          setAuthLoaded(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Could not load ChatHTML Cloud account.", error);
          setAuthSummary({
            user: null,
            auth: {
              available: false,
              requiresInvite: false,
              firstUser: false
            }
          });
          setAuthLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cloudEnabled]);

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

  const updateActiveSession = useCallback(
    (updater: (session: ChatSession) => ChatSession) => {
      setSessionStateAndRef((current) => {
        let didUpdate = false;
        const sessions = current.sessions.map((session) => {
          if (session.id !== current.activeSessionId) {
            return session;
          }

          didUpdate = true;
          return updater(session);
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

  const updateSessionById = useCallback(
    (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
      setSessionStateAndRef((current) => {
        let didUpdate = false;
        const sessions = current.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          didUpdate = true;
          return updater(session);
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

  const handleBugReportDraftChange = useCallback(
    (draft: BugReportDraft) => {
      const targetSessionId = bugReportSessionId ?? activeSessionIdRef.current;
      updateSessionById(targetSessionId, (session) => {
        const now = Date.now();
        return {
          ...session,
          updatedAt: now,
          bugReportDraft: normalizeBugReportDraft(draft, now)
        };
      });
    },
    [bugReportSessionId, updateSessionById]
  );

  const handleBugReportClose = useCallback(() => {
    if (bugReportSuccessCloseTimerRef.current !== null) {
      window.clearTimeout(bugReportSuccessCloseTimerRef.current);
      bugReportSuccessCloseTimerRef.current = null;
    }
    setIsBugReportOpen(false);
    setBugReportSubmitError(null);
    setIsBugReportSubmitted(false);
    setBugReportSessionId(null);
    saveCurrentSessionStateNow();
  }, [saveCurrentSessionStateNow]);

  const handleBugReportOpen = useCallback(async () => {
    if (isBugReportCapturing) {
      return;
    }

    const targetSessionId = activeSessionIdRef.current;
    const targetSession = sessionStateRef.current.sessions.find(
      (session) => session.id === targetSessionId
    );
    if (!targetSession) {
      return;
    }

    setBugReportSessionId(targetSessionId);
    setBugReportSubmitError(null);
    setBugReportCaptureError(null);
    setIsBugReportSubmitted(false);

    const existingDraft = targetSession.bugReportDraft;
    const shouldCaptureScreenshot =
      !existingDraft?.screenshotCapturedAt &&
      !existingDraft?.images.some((image) => image.captured);
    if (!shouldCaptureScreenshot) {
      setIsBugReportOpen(true);
      return;
    }

    setIsBugReportCapturing(true);
    let screenshot: BugReportImage | null = null;
    try {
      const blob = await captureCurrentPageScreenshotBlob();
      screenshot = {
        id: createId("bug-image"),
        name: "page-screenshot.png",
        mimeType: "image/png",
        size: blob.size,
        dataUrl: await blobToDataUrl(blob),
        width: window.innerWidth,
        height: window.innerHeight,
        captured: true,
        createdAt: Date.now()
      };
    } catch (error) {
      console.warn("Could not capture bug report screenshot.", error);
      setBugReportCaptureError(
        "Could not capture the page screenshot. You can still add images manually."
      );
    } finally {
      setIsBugReportCapturing(false);
    }

    const capturedScreenshot = screenshot;
    if (capturedScreenshot) {
      updateSessionById(targetSessionId, (session) => {
        const now = Date.now();
        const currentDraft =
          session.bugReportDraft ?? createEmptyBugReportDraft(now);
        const hasRoom = currentDraft.images.length < MAX_BUG_REPORT_IMAGES;
        const nextDraft =
          hasRoom && !currentDraft.images.some((image) => image.captured)
            ? {
                ...currentDraft,
                images: [capturedScreenshot, ...currentDraft.images],
                screenshotCapturedAt: capturedScreenshot.createdAt,
                updatedAt: now
              }
            : currentDraft;

        return {
          ...session,
          updatedAt: now,
          bugReportDraft: normalizeBugReportDraft(nextDraft, now)
        };
      });
    }

    setIsBugReportOpen(true);
  }, [isBugReportCapturing, updateSessionById]);

  const handleBugReportSubmit = useCallback(async () => {
    const targetSessionId = bugReportSessionId ?? activeSessionIdRef.current;
    const targetSession = sessionStateRef.current.sessions.find(
      (session) => session.id === targetSessionId
    );
    const draft = targetSession?.bugReportDraft;
    if (!targetSession || !draft || (!draft.text.trim() && !draft.images.length)) {
      return;
    }

    setIsBugReportSubmitting(true);
    setBugReportSubmitError(null);
    try {
      await submitBugReport(
        {
          sessionId: targetSession.id,
          sessionTitle:
            targetSession.title || summarizeSession(targetSession.messages),
          draft
        },
        sessionClientIdRef.current
      );
      setBugReportCaptureError(null);
      setBugReportSubmitError(null);
      setIsBugReportSubmitted(true);
      if (bugReportSuccessCloseTimerRef.current !== null) {
        window.clearTimeout(bugReportSuccessCloseTimerRef.current);
      }
      bugReportSuccessCloseTimerRef.current = window.setTimeout(() => {
        bugReportSuccessCloseTimerRef.current = null;
        updateSessionById(targetSession.id, (session) => ({
          ...session,
          updatedAt: Date.now(),
          bugReportDraft: undefined
        }));
        setIsBugReportOpen(false);
        setBugReportSessionId(null);
        setIsBugReportSubmitted(false);
        saveCurrentSessionStateNow();
      }, 1400);
    } catch (error) {
      setBugReportSubmitError(
        error instanceof Error ? error.message : "Could not submit bug report."
      );
    } finally {
      setIsBugReportSubmitting(false);
    }
  }, [bugReportSessionId, saveCurrentSessionStateNow, updateSessionById]);

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
      if (!files.length) {
        return;
      }

      setSessionStateAndRef((current) => {
        let didUpdate = false;
        const sessions = current.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          didUpdate = true;
          return {
            ...session,
            updatedAt: Date.now(),
            files: mergeSessionFiles([...session.files, ...files])
          };
        });

        return didUpdate ? { ...current, sessions: sortSessions(sessions) } : current;
      });
    },
    [setSessionStateAndRef]
  );

  const updateAssistantMessage = useCallback(
    (id: string, updater: (message: ClientMessage) => ClientMessage) => {
      setSessionStateAndRef((current) => {
        let didUpdate = false;
        const now = Date.now();
        const sessions = current.sessions.map((session) => {
          let sessionChanged = false;
          const messages = session.messages.map((message) => {
            if (message.id !== id) {
              return message;
            }

            didUpdate = true;
            sessionChanged = true;
            return updater(message);
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
    const localArtifactEditController = localArtifactEditAbortRef.current;
    if (!runIds.length && !localArtifactEditController) {
      return;
    }

    const branchCleanupRunIds = runIds.filter((runId) =>
      branchRunCancelCleanupRef.current.has(runId)
    );
    const patchCancelledRunIds = runIds.filter(
      (runId) => !branchRunCancelCleanupRef.current.has(runId)
    );

    runIds.forEach((runId) => cancelledRunIdsRef.current.add(runId));
    localArtifactEditController?.abort();

    const cancelRequests = runIds.map((runId) =>
      cancelChatRun(runId, sessionClientIdRef.current).catch((error) => {
        console.warn("Could not cancel ChatHTML run on the server.", error);
      })
    );

    runIds.forEach((runId) => {
      const controller = runConnectionsRef.current.get(runId);
      controller?.abort();
      runConnectionsRef.current.delete(runId);
    });
    if (branchCleanupRunIds.length) {
      removeCancelledBranchRunVariants(branchCleanupRunIds);
    }
    if (patchCancelledRunIds.length) {
      markRunsCancelled(patchCancelledRunIds);
    }
    const nextIsSending =
      runConnectionsRef.current.size > 0 ||
      Boolean(localArtifactEditAbortRef.current);
    setIsSending(nextIsSending);
    isSendingRef.current = nextIsSending;

    await Promise.allSettled(cancelRequests);
    window.setTimeout(() => {
      runIds.forEach((runId) => cancelledRunIdsRef.current.delete(runId));
    }, SESSION_SYNC_INTERVAL_MS);
  }, [markRunsCancelled, removeCancelledBranchRunVariants]);

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
      artifactSelectionsRef.current = [];
      setArtifactSelectionClearVersion((version) => version + 1);
    },
    [updateActiveSession]
  );

  const handleNewSession = useCallback(() => {
    if (isSendingRef.current) {
      return;
    }

    setSessionStateAndRef((current) => {
      const compacted = compactEmptySessions(current, {
        preserveActiveEmpty: true
      });
      const active = compacted.sessions.find(
        (session) => session.id === compacted.activeSessionId
      );
      if (active && isSessionEmpty(active)) {
        transientEmptySessionIdRef.current = active.id;
        return compacted;
      }

      const session = createEmptySession(
        undefined,
        undefined,
        apiSettings.model,
        apiSettings.reasoningEffort,
        apiSettings.uiComplexity
      );
      transientEmptySessionIdRef.current = session.id;
      return {
        sessions: [session, ...compacted.sessions],
        activeSessionId: session.id
      };
    });
  }, [
    apiSettings.model,
    apiSettings.reasoningEffort,
    apiSettings.uiComplexity,
    setSessionStateAndRef
  ]);

  const handleSelectSession = useCallback((id: string) => {
    setSessionStateAndRef((current) => {
      const target = current.sessions.find((session) => session.id === id);
      if (!target) {
        return current;
      }
      if (target.id !== transientEmptySessionIdRef.current) {
        transientEmptySessionIdRef.current = null;
      }

      return compactEmptySessions(
        {
          ...current,
          activeSessionId: id
        },
        { preserveActiveEmpty: isSessionEmpty(target) }
      );
    });
  }, [setSessionStateAndRef]);

  const handleDeleteSession = useCallback((id: string) => {
    if (isSendingRef.current) {
      return;
    }

    if (transientEmptySessionIdRef.current === id) {
      transientEmptySessionIdRef.current = null;
    }
    deletedSessionIdsRef.current.add(id);
    setSessionStateAndRef((current) => {
      const remaining = current.sessions.filter((session) => session.id !== id);
      if (!remaining.length) {
        const session = createEmptySession(
          undefined,
          undefined,
          apiSettings.model,
          apiSettings.reasoningEffort,
          apiSettings.uiComplexity
        );
        return {
          sessions: [session],
          activeSessionId: session.id
        };
      }

      const activeSessionId =
        current.activeSessionId === id ? remaining[0].id : current.activeSessionId;

      return compactEmptySessions(
        {
          sessions: remaining,
          activeSessionId
        },
        {
          preserveActiveEmpty: remaining.some(
            (session) => session.id === activeSessionId && isSessionEmpty(session)
          )
        }
      );
    });
    saveCurrentSessionStateNow();
  }, [
    apiSettings.model,
    apiSettings.reasoningEffort,
    apiSettings.uiComplexity,
    saveCurrentSessionStateNow,
    setSessionStateAndRef
  ]);

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
      if ((!trimmed && attachments.length === 0) || isSendingRef.current) {
        return;
      }

      const appendUserMessage = options.appendUserMessage ?? true;
      const requestedSessionId = options.targetSessionId?.trim();
      const requestSessionId = requestedSessionId || activeSessionIdRef.current;
      if (transientEmptySessionIdRef.current === requestSessionId) {
        transientEmptySessionIdRef.current = null;
      }
      const requestSessionForModel = sessionStateRef.current.sessions.find(
        (session) => session.id === requestSessionId
      );
      if (!requestSessionForModel) {
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
        pendingManagedRequestRef.current = {
          text,
          attachments,
          options
        };
        setIsAuthOverlayOpen(true);
        return;
      }
      const userMessageId = createId("user");
      const previousMessages = getVisibleSessionMessages(requestSessionForModel);
      const uploadedFiles = attachments
        .map((attachment) => commitUploadedImageFile(attachment, userMessageId))
        .filter((file): file is SessionFile => file !== null);
      const hasUnuploadedAttachments = uploadedFiles.length !== attachments.length;
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
      if (options.cancelBranchVariant) {
        branchRunCancelCleanupRef.current.set(generationRunId, {
          sessionId: requestSessionId,
          groupId: options.cancelBranchVariant.groupId,
          variantId: options.cancelBranchVariant.variantId,
          fallbackVariantId: options.cancelBranchVariant.fallbackVariantId
        });
      }
      const renderer = createStreamingRenderer(themeMode);
      renderersRef.current.set(assistantId, renderer);
      const streamController = new AbortController();
      runConnectionsRef.current.set(generationRunId, streamController);

      const unsubscribeSnapshot = renderer.onSnapshot((snapshot) => {
        updateAssistant(assistantId, { snapshot });
      });

      updateSessionById(requestSessionId, (session) => {
        const nextMessages = options.insertMessages
          ? options.insertMessages(session.messages, userMessage, assistantMessage)
          : appendUserMessage
            ? [...session.messages, userMessage, assistantMessage]
            : [...session.messages, assistantMessage];
        const branchSelections = options.branchSelection
          ? {
              ...(session.branchSelections ?? {}),
              [options.branchSelection.groupId]: options.branchSelection.variantId
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
      setIsSending(true);

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

      const handleStreamEvent = createChatStreamLineHandler({
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
            ...(typeof streamSequence === "number" ? { streamSequence } : {})
          });
        },
        onContent: handleContentChunk
      });

      try {
        if (hasUnuploadedAttachments) {
          throw new Error("Image upload is still in progress. Please wait before sending.");
        }

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
        unsubscribeSnapshot();
        renderersRef.current.delete(assistantId);
        runConnectionsRef.current.delete(generationRunId);
        branchRunCancelCleanupRef.current.delete(generationRunId);
        setIsSending(runConnectionsRef.current.size > 0);
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
      handleMemoryStreamEvent,
      refreshAuthSummary,
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
      if (isSendingRef.current) {
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
    [sendStreamUiRequest]
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
      if (isSendingRef.current) {
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
    [decorateGeneratedArtifactBatchPatch, sendStreamUiRequest]
  );

  const handleVisualRepairAssistant = useCallback(
    async (assistantId: string, snapshot: RenderSnapshot, width: number) => {
      if (isSendingRef.current || snapshot.status !== "complete") {
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
            sessionFile: uploadedFile as UploadedSessionFile
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
    [apiSettings.model, startGeneratedArtifactBatch, themeMode]
  );

  const regenerateArtifactEditNode = useCallback(
    async (
      assistantId: string,
      editId: string,
      nextPrompt?: string
    ): Promise<boolean> => {
      if (isSendingRef.current) {
        return true;
      }

      const session =
        sessionStateRef.current.sessions.find((candidate) =>
          candidate.messages.some((message) => message.id === assistantId)
        ) ??
        sessionStateRef.current.sessions.find(
          (candidate) => candidate.id === activeSessionIdRef.current
        ) ??
        sessionStateRef.current.sessions[0];
      const assistant = session?.messages.find(
        (message) => message.id === assistantId && message.role === "assistant"
      );
      if (!session || !assistant) {
        return false;
      }

      const edits = assistant.artifactEdits ?? [];
      const editIndex = edits.findIndex((edit) => edit.id === editId);
      if (editIndex < 0) {
        return false;
      }

      if (edits.some((edit) => edit.status === "pending")) {
        return true;
      }

      const edit = edits[editIndex];
      const isPromptEdit = nextPrompt !== undefined;
      const prompt = (nextPrompt ?? edit.prompt).trim();
      const sourceEditId = getArtifactEditParentId(edits, edit);
      const source = getArtifactEditRawStream(assistant, sourceEditId) ?? "";
      if (!prompt || !source.trim()) {
        console.warn("Artifact edit regeneration requires a completed source.");
        return true;
      }

      const requestModel = (session.model || apiSettings.model).trim();
      const requestReasoningEffort =
        session.reasoningEffort ?? apiSettings.reasoningEffort;
      const requestUiComplexity = normalizeUiComplexity(
        session.uiComplexity ?? apiSettings.uiComplexity
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
        setIsAuthOverlayOpen(true);
        return true;
      }

      const retryExistingFailedEdit =
        edit.status === "error" && !hasUsableArtifactEditVariant(edit);
      const variantId =
        retryExistingFailedEdit && edit.activeVariantId
          ? edit.activeVariantId
          : createId("artifact-edit-variant");
      const nextEditId = retryExistingFailedEdit
        ? edit.id
        : createId("artifact-edit");
      const createdAt = Date.now();
      const previousActiveEditId = getResolvedArtifactEditId(assistant);
      const controller = new AbortController();
      localArtifactEditAbortRef.current = controller;
      const pendingEdit: ArtifactEdit = {
        id: nextEditId,
        parentId: sourceEditId,
        createdAt,
        prompt,
        references: edit.references,
        promptBubble: isPromptEdit ? undefined : false,
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
      const pendingArtifactEdits = retryExistingFailedEdit
        ? (assistant.artifactEdits ?? []).map((item) => {
            if (item.id !== edit.id) {
              return item;
            }

            const hasVariant = item.variants.some(
              (variant) => variant.id === variantId
            );
            const pendingVariant = {
              id: variantId,
              createdAt,
              status: "pending" as const
            };

            return {
              ...item,
              prompt,
              status: "pending" as const,
              error: undefined,
              activeVariantId: variantId,
              variants: hasVariant
                ? item.variants.map((variant) =>
                    variant.id === variantId
                      ? {
                          ...variant,
                          createdAt,
                          status: "pending" as const,
                          rawStream: undefined,
                          summary: undefined,
                          error: undefined,
                          editCount: undefined
                        }
                      : variant
                  )
                : [...item.variants, pendingVariant]
            };
          })
        : [...(assistant.artifactEdits ?? []), pendingEdit];
      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        ...buildCompletedAssistantPatchFromRawStream(source, themeMode),
        artifactEditBaseRawStream:
          message.artifactEditBaseRawStream ?? message.rawStream,
        artifactEdits: pendingArtifactEdits,
        activeArtifactEditId: nextEditId
      }));
      setIsSending(true);
      isSendingRef.current = true;

      try {
        const result = await requestArtifactEdit(
          {
            source,
            prompt,
            references: edit.references,
            apiSettings: serializeApiSettings(requestApiSettings)
          },
          sessionClientIdRef.current,
          controller.signal
        );
        const patch = buildCompletedAssistantPatchFromRawStream(
          result.rawStream,
          themeMode
        );
        const editCount = result.edits?.length;

        updateAssistantMessage(assistantId, (message) =>
          completeArtifactEditVariant(
            { ...message, ...patch },
            {
              editId: nextEditId,
              variantId,
              rawStream: result.rawStream,
              summary: result.summary,
              editCount,
              baseRawStream: assistant.artifactEditBaseRawStream ?? source
            }
          )
        );
        artifactSelectionsRef.current = [];
        setArtifactSelectionClearVersion((version) => version + 1);
      } catch (error) {
        if (isAbortError(error)) {
          updateAssistantMessage(assistantId, (message) => {
            if (retryExistingFailedEdit) {
              return {
                ...message,
                ...buildCompletedAssistantPatchFromRawStream(source, themeMode),
                artifactEdits: (message.artifactEdits ?? []).map((item) =>
                  item.id === edit.id ? edit : item
                ),
                activeArtifactEditId: previousActiveEditId
              };
            }

            const artifactEdits = (message.artifactEdits ?? []).filter(
              (item) => item.id !== nextEditId
            );
            const fallbackRawStream = getArtifactEditRawStream(
              {
                ...message,
                artifactEdits
              },
              previousActiveEditId
            );

            return {
              ...message,
              ...(fallbackRawStream
                ? buildCompletedAssistantPatchFromRawStream(
                    fallbackRawStream,
                    themeMode
                  )
                : {}),
              artifactEdits: artifactEdits.length ? artifactEdits : undefined,
              activeArtifactEditId: previousActiveEditId
            };
          });
          return true;
        }

        const errorMessage =
          error instanceof Error
            ? sanitizeChatErrorMessage(
                error.message,
                "The artifact edit regeneration failed."
              )
            : "The artifact edit regeneration failed.";
        updateAssistantMessage(assistantId, (message) =>
          failArtifactEditVariant(
            message,
            nextEditId,
            variantId,
            errorMessage
          )
        );
      } finally {
        if (localArtifactEditAbortRef.current === controller) {
          localArtifactEditAbortRef.current = null;
        }
        const nextIsSending =
          runConnectionsRef.current.size > 0 ||
          Boolean(localArtifactEditAbortRef.current);
        setIsSending(nextIsSending);
        isSendingRef.current = nextIsSending;
        saveCurrentSessionStateNow();
        if (requestApiSettings.apiKeySource === "managed") {
          void refreshAuthSummary().catch((error) => {
            console.warn("Could not refresh ChatHTML Cloud account.", error);
          });
        }
      }

      return true;
    },
    [
      apiSettings,
      authenticatedUser,
      cloudEnabled,
      refreshAuthSummary,
      runtimeSettings,
      saveCurrentSessionStateNow,
      themeMode,
      updateAssistantMessage
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

  const runArtifactAction = useCallback(
    (messageId: string, action: StreamUiAction): boolean => {
      const text = buildArtifactActionMessage(action);
      if (!text) {
        return false;
      }

      const targetSessionId =
        findSessionIdForMessage(sessionStateRef.current, messageId) ||
        activeSessionIdRef.current;

      void sendStreamUiRequest(text, [], { targetSessionId });
      return true;
    },
    [sendStreamUiRequest]
  );

  const handleArtifactAction = useCallback(
    (messageId: string, action: StreamUiAction) => {
      if (isSendingRef.current) {
        pendingArtifactActionRef.current = { messageId, action };
        return;
      }

      runArtifactAction(messageId, action);
    },
    [runArtifactAction]
  );

  useEffect(() => {
    if (isSending) {
      return;
    }

    const pending = pendingArtifactActionRef.current;
    if (!pending) {
      return;
    }

    pendingArtifactActionRef.current = null;
    runArtifactAction(pending.messageId, pending.action);
  }, [isSending, runArtifactAction]);

  const runArtifactSourceEdit = useCallback(
    async (
      prompt: string,
      selections: ArtifactSelection[],
      attachments: ImageAttachment[] = []
    ) => {
      const trimmed = prompt.trim();
      if (!trimmed || isSendingRef.current || !selections.length) {
        return;
      }

      const selectedMessageIds = Array.from(
        new Set(selections.map((selection) => selection.messageId))
      );
      const assistantId = selectedMessageIds[0];
      if (!assistantId || selectedMessageIds.length !== 1) {
        console.warn("Artifact edits require references from a single artifact.");
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
      const assistant = session?.messages.find(
        (message) => message.id === assistantId && message.role === "assistant"
      );
      if (!session || !assistant) {
        console.warn("Artifact edits require a completed artifact source.");
        return;
      }

      const previousEditId = getResolvedArtifactEditId(assistant);
      const source = getArtifactEditRawStream(assistant, previousEditId) ?? "";
      if (!source.trim()) {
        console.warn("Artifact edits require a completed artifact source.");
        return;
      }

      const requestModel = (session.model || apiSettings.model).trim();
      const requestReasoningEffort =
        session.reasoningEffort ?? apiSettings.reasoningEffort;
      const requestUiComplexity = normalizeUiComplexity(
        session.uiComplexity ?? apiSettings.uiComplexity
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
        setIsAuthOverlayOpen(true);
        return;
      }

      const editId = createId("artifact-edit");
      const variantId = createId("artifact-edit-variant");
      const createdAt = Date.now();
      const references = selections.map(artifactSelectionToReference);
      const controller = new AbortController();
      localArtifactEditAbortRef.current = controller;
      const pendingEdit: ArtifactEdit = {
        id: editId,
        parentId: previousEditId,
        createdAt,
        prompt: trimmed,
        references,
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

      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        ...buildCompletedAssistantPatchFromRawStream(source, themeMode),
        artifactEditBaseRawStream:
          message.artifactEditBaseRawStream ?? message.rawStream,
        artifactEdits: [...(message.artifactEdits ?? []), pendingEdit],
        activeArtifactEditId: editId
      }));
      artifactSelectionsRef.current = [];
      setArtifactSelectionClearVersion((version) => version + 1);
      setIsSending(true);
      isSendingRef.current = true;

      const failEdit = (errorMessage: string) => {
        updateAssistantMessage(assistantId, (message) =>
          failArtifactEditVariant(message, editId, variantId, errorMessage)
        );
      };

      try {
        if (attachments.length > 0) {
          throw new Error(
            "Local artifact edits do not support attachments yet. Remove the attachment and try again."
          );
        }

        const result = await requestArtifactEdit(
          {
            source,
            prompt: trimmed,
            references,
            apiSettings: serializeApiSettings(requestApiSettings)
          },
          sessionClientIdRef.current,
          controller.signal
        );
        const patch = buildCompletedAssistantPatchFromRawStream(
          result.rawStream,
          themeMode
        );
        const editCount = result.edits?.length;

        updateAssistantMessage(assistantId, (message) =>
          completeArtifactEditVariant(
            { ...message, ...patch },
            {
              editId,
              variantId,
              rawStream: result.rawStream,
              summary: result.summary,
              editCount,
              baseRawStream: source
            }
          )
        );
      } catch (error) {
        if (isAbortError(error)) {
          updateAssistantMessage(assistantId, (message) =>
            removeArtifactEdit(message, editId, previousEditId)
          );
          return;
        }

        const message =
          error instanceof Error
            ? sanitizeChatErrorMessage(error.message, "The artifact edit failed.")
            : "The artifact edit failed.";
        failEdit(message);
      } finally {
        if (localArtifactEditAbortRef.current === controller) {
          localArtifactEditAbortRef.current = null;
        }
        const nextIsSending =
          runConnectionsRef.current.size > 0 ||
          Boolean(localArtifactEditAbortRef.current);
        setIsSending(nextIsSending);
        isSendingRef.current = nextIsSending;
        saveCurrentSessionStateNow();
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
      refreshAuthSummary,
      runtimeSettings,
      saveCurrentSessionStateNow,
      themeMode,
      updateAssistantMessage
    ]
  );

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

        const controller = new AbortController();
        runConnectionsRef.current.set(generationRunId, controller);
        setIsSending(true);

        void (async () => {
          const renderer = createStreamingRenderer(themeMode);
          renderersRef.current.set(message.id, renderer);
          const unsubscribeSnapshot = renderer.onSnapshot((snapshot) => {
            updateAssistant(message.id, { snapshot });
          });
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

          const handleStreamEvent = createChatStreamLineHandler({
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
            unsubscribeSnapshot();
            renderersRef.current.delete(message.id);
            runConnectionsRef.current.delete(generationRunId);
            setIsSending(runConnectionsRef.current.size > 0);
          }
        })();
      }
    }
  }, [
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

    const pending = pendingManagedRequestRef.current;
    if (!pending) {
      return;
    }

    pendingManagedRequestRef.current = null;
    setIsAuthOverlayOpen(false);
    void sendStreamUiRequest(pending.text, pending.attachments, pending.options);
  }, [authenticatedUser, cloudEnabled, sendStreamUiRequest, sessionsLoaded]);

  const handleArtifactSelectionsChange = useCallback(
    (selections: ArtifactSelection[]) => {
      artifactSelectionsRef.current = selections;
    },
    []
  );

  const handleEditArtifactEditPrompt = useCallback(
    (assistantId: string, editId: string, prompt: string): boolean => {
      const trimmed = prompt.trim();
      if (!trimmed || isSendingRef.current) {
        return false;
      }

      const currentMessage = findSessionMessage(
        sessionStateRef.current,
        assistantId
      );
      if (
        !currentMessage ||
        currentMessage.role !== "assistant" ||
        !currentMessage.artifactEdits?.length
      ) {
        return false;
      }

      if (currentMessage.artifactEdits.some((edit) => edit.status === "pending")) {
        console.warn("Wait for the current artifact edit to finish before editing.");
        return false;
      }

      const edit = currentMessage.artifactEdits.find(
        (candidate) => candidate.id === editId
      );
      if (!edit || edit.status !== "complete") {
        return false;
      }

      if (trimmed === edit.prompt.trim()) {
        return true;
      }

      void regenerateArtifactEditNode(assistantId, editId, trimmed);
      return true;
    },
    [regenerateArtifactEditNode]
  );

  const handleSelectArtifactEdit = useCallback(
    (assistantId: string, editId?: string) => {
      updateAssistantMessage(assistantId, (message) => {
        if (message.role !== "assistant") {
          return message;
        }

        const rawStream = getArtifactEditDisplayRawStream(message, editId);
        if (!rawStream) {
          return message;
        }

        return {
          ...message,
          ...buildCompletedAssistantPatchFromRawStream(rawStream, themeMode),
          activeArtifactEditId: editId
        };
      });
      artifactSelectionsRef.current = [];
      setArtifactSelectionClearVersion((version) => version + 1);
    },
    [themeMode, updateAssistantMessage]
  );

  const handleNewMessage = useCallback(
    async (message: AppendMessage) => {
      if (
        attachmentUploadGate.inFlight > 0 ||
        attachmentUploadGate.errorIds.length > 0
      ) {
        return;
      }

      const text = getAppendMessageText(message);
      const attachments = getAppendMessageImages(message);
      const artifactSelections = artifactSelectionsRef.current;
      if (artifactSelections.length > 0) {
        await runArtifactSourceEdit(text, artifactSelections, attachments);
        return;
      }

      await sendStreamUiRequest(text, attachments);
    },
    [
      attachmentUploadGate.errorIds.length,
      attachmentUploadGate.inFlight,
      runArtifactSourceEdit,
      sendStreamUiRequest
    ]
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: isActiveSessionSending,
    isSendDisabled:
      isSending ||
      attachmentUploadGate.inFlight > 0 ||
      attachmentUploadGate.errorIds.length > 0,
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
              isSending={isSending}
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
