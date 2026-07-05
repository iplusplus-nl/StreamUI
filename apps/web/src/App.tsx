import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  AuiIf,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike
} from "@assistant-ui/react";
import { AssistantMessage } from "./components/AssistantMessage";
import { ChatInput } from "./components/ChatInput";
import { ChatMessage } from "./components/ChatMessage";
import { ChatShell } from "./components/ChatShell";
import {
  SessionSidebar,
  type SessionListItem,
  type ThemeMode
} from "./components/SessionSidebar";
import {
  StreamImageAttachmentAdapter,
  completeAttachmentToImage,
  imageAttachmentToCompleteAttachment
} from "./core/assistantAttachments";
import {
  hasSavedApiSettings,
  loadApiSettings,
  getSelectableModelOptions,
  normalizeApiSettings,
  saveApiSettings,
  serializeApiSettings,
  type ApiSettings,
  type ReasoningEffort
} from "./core/apiSettings";
import {
  applyMemoryStreamEvent,
  type MemoryStreamEvent
} from "./core/memoryStreamEvents";
import {
  loadSearchSettings,
  normalizeSearchSettings,
  saveSearchSettings,
  serializeSearchSettings,
  type SearchSettings
} from "./core/searchSettings";
import {
  loadRuntimeSettings,
  type RuntimeSettingsSummary
} from "./core/runtimeSettings";
import { buildArtifactContext } from "./core/artifactContext";
import {
  createEmptySession,
  createId,
  createInitialSessionState,
  hasPersistedMessages,
  initialMessages,
  normalizeStoredSession,
  normalizeStoredSessionState,
  serializeSessions,
  sortSessions,
  summarizeSession,
  type ChatSession,
  type ClientMessage,
  type SessionFile,
  type SessionState
} from "./domain/chat/sessionModel";
import { toApiMessages } from "./features/chat/apiMessages";
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

type TextStreamEvent = {
  type?: "content" | "reasoning";
  text?: string;
  runId?: string;
  seq?: number;
};

type DoneStreamEvent = {
  type: "done";
  status?: "complete" | "error";
  error?: string;
  runId?: string;
  seq?: number;
};

type SequencedMemoryStreamEvent = MemoryStreamEvent & {
  runId?: string;
  seq?: number;
};

type ChatStreamEvent =
  | TextStreamEvent
  | DoneStreamEvent
  | SequencedMemoryStreamEvent;

type SendStreamUiRequestOptions = {
  appendUserMessage?: boolean;
  assistantPatch?: Partial<ClientMessage>;
  initialReasoning?: string;
  requestHistory?: ClientMessage[];
};

const LEGACY_SESSION_STORAGE_KEY = "streamui.sessions.v1";
const LEGACY_ACTIVE_SESSION_STORAGE_KEY = "streamui.activeSession.v1";
const THEME_STORAGE_KEY = "streamui.theme.v1";
const SESSION_CLIENT_ID_STORAGE_KEY = "streamui.clientId.v1";
const SESSION_CLIENT_ID_HEADER = "X-StreamUI-Client-Id";
const SESSION_SYNC_INTERVAL_MS = 4_000;
const MAX_RUNTIME_REPAIR_ATTEMPTS = 2;
const MAX_RUNTIME_REPAIR_SOURCE_CHARS = 32_000;
const MAX_RUNTIME_REPAIR_ERROR_CHARS = 4_000;

function mergeSessionFiles(files: SessionFile[]): SessionFile[] {
  const merged = new Map<string, SessionFile>();
  for (const file of files) {
    merged.set(file.id, file);
  }

  return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
}

type SessionFileUploadInput = {
  kind: SessionFile["kind"];
  name: string;
  mimeType: string;
  dataUrl?: string;
  text?: string;
  width?: number;
  height?: number;
  sourceMessageId?: string;
  summary?: string;
  draft?: boolean;
};

function createSessionClientId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `client-${random}`;
}

function loadSessionClientId(): string {
  if (typeof window === "undefined") {
    return createSessionClientId();
  }

  const existing = window.localStorage
    .getItem(SESSION_CLIENT_ID_STORAGE_KEY)
    ?.trim();
  if (existing) {
    return existing;
  }

  const clientId = createSessionClientId();
  window.localStorage.setItem(SESSION_CLIENT_ID_STORAGE_KEY, clientId);
  return clientId;
}

function sessionRequestHeaders(
  clientId: string,
  contentType?: string
): HeadersInit {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    [SESSION_CLIENT_ID_HEADER]: clientId
  };
}

function imageAttachmentToFileUpload(
  attachment: ImageAttachment,
  sourceMessageId?: string,
  draft = false
): SessionFileUploadInput {
  return {
    kind: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    sourceMessageId,
    dataUrl: attachment.dataUrl,
    width: attachment.width,
    height: attachment.height,
    summary: `Uploaded image ${attachment.name}`,
    draft
  };
}

function createArtifactFileUpload(
  messageId: string,
  rawStream: string,
  snapshot: RenderSnapshot | undefined,
  summary: string | undefined
): SessionFileUploadInput | null {
  const source = rawStream || snapshot?.raw || snapshot?.completedHtml || "";
  if (!source.trim()) {
    return null;
  }

  return {
    kind: "artifact",
    name: `${messageId}.streamui.html`,
    mimeType: "text/html",
    sourceMessageId: messageId,
    text: source,
    summary: summary || "StreamUI artifact raw source"
  };
}

async function uploadSessionFile(
  sessionId: string,
  input: SessionFileUploadInput,
  clientId: string
): Promise<SessionFile> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/files`,
    {
      method: "POST",
      headers: sessionRequestHeaders(clientId, "application/json"),
      body: JSON.stringify({ ...input, clientId })
    }
  );

  const payload = (await response.json().catch(() => ({}))) as {
    file?: unknown;
    error?: unknown;
  };
  if (!response.ok || !payload.file) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `File upload failed with HTTP ${response.status}.`
    );
  }

  return payload.file as SessionFile;
}

async function deleteSessionFile(
  sessionId: string,
  fileId: string,
  clientId: string
): Promise<void> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(
      fileId
    )}`,
    {
      method: "DELETE",
      headers: sessionRequestHeaders(clientId)
    }
  );

  if (!response.ok) {
    throw new Error(`File delete failed with HTTP ${response.status}.`);
  }
}

function commitUploadedImageFile(
  attachment: ImageAttachment,
  sourceMessageId: string
): SessionFile | null {
  if (!attachment.sessionFile) {
    return null;
  }

  const { draft: _draft, ...file } = attachment.sessionFile;
  const shouldKeepInlineDataUrl = !file.storageKey && !file.embedUrl;
  return {
    ...file,
    kind: "image",
    sourceMessageId,
    ...(shouldKeepInlineDataUrl ? { dataUrl: attachment.dataUrl } : {}),
    width: file.width ?? attachment.width,
    height: file.height ?? attachment.height
  };
}

function serializeSessionStateForSave(
  state: SessionState,
  clientId: string,
  deletedSessionIds: string[] = []
): string {
  return JSON.stringify({
    clientId,
    deletedSessionIds,
    sessions: serializeSessions(state.sessions),
    activeSessionId: state.activeSessionId
  });
}

function saveSerializedSessionState(
  serializedState: string,
  clientId: string,
  signal?: AbortSignal
): Promise<Response> {
  return fetch("/api/sessions", {
    method: "PUT",
    headers: sessionRequestHeaders(clientId, "application/json"),
    signal,
    body: serializedState
  });
}

function saveSessionStateOnPageExit(
  serializedState: string,
  clientId: string
): void {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function"
  ) {
    const body = new Blob([serializedState], { type: "application/json" });
    if (navigator.sendBeacon("/api/sessions", body)) {
      return;
    }
  }

  void fetch("/api/sessions", {
    method: "PUT",
    headers: sessionRequestHeaders(clientId, "application/json"),
    keepalive: true,
    body: serializedState
  }).catch((error) => {
    console.warn("Could not flush StreamUI sessions before page exit.", error);
  });
}

function renderErrorKey(error: Pick<RenderError, "kind" | "message">): string {
  return `${error.kind}:${error.message}`;
}

function hasRenderError(
  errors: RenderError[] | undefined,
  error: RenderError
): boolean {
  const key = renderErrorKey(error);
  return Boolean(errors?.some((item) => renderErrorKey(item) === key));
}

function isRepairableRuntimeError(error: RenderError): boolean {
  return error.kind === "runtime" || error.kind === "console";
}

function getRepairRootId(message: ClientMessage): string {
  return message.repairOfMessageId || message.id;
}

function getRuntimeRepairAttempt(
  messages: ClientMessage[],
  rootMessageId: string
): number {
  return messages
    .filter(
      (message) =>
        message.role === "assistant" &&
        (message.id === rootMessageId ||
          message.repairOfMessageId === rootMessageId)
    )
    .reduce((maxAttempt, message) => {
      return Math.max(maxAttempt, message.repairAttempt ?? 0);
    }, 0);
}

function clipMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const half = Math.floor((maxChars - 120) / 2);
  return `${value.slice(0, half)}\n\n<!-- ... clipped for repair prompt ... -->\n\n${value.slice(
    -half
  )}`;
}

function formatRuntimeErrors(errors: RenderError[]): string {
  return errors
    .map((error, index) => {
      return `${index + 1}. ${error.kind}: ${error.message}`;
    })
    .join("\n")
    .slice(0, MAX_RUNTIME_REPAIR_ERROR_CHARS);
}

function buildRuntimeRepairPrompt(
  message: ClientMessage,
  errors: RenderError[],
  attempt: number
): string {
  const rawArtifact = message.rawStream || message.snapshot?.raw || "";
  const completedHtml = message.snapshot?.completedHtml || "";
  const source = rawArtifact || completedHtml;

  return `A previous StreamUI artifact rendered with runtime errors. Repair it now.

Requirements:
- Return a complete StreamUI response using the normal protocol: <sessiontitle>, empty <chat></chat>, and exactly one <streamui> block.
- Preserve the user's original intent, visible content, layout, and style as much as possible.
- Fix the runtime/console errors listed below.
- Avoid repeating the same failing script pattern.
- Do not explain the repair process in user-facing text.

Repair attempt: ${attempt}/${MAX_RUNTIME_REPAIR_ATTEMPTS}

Runtime errors:
${formatRuntimeErrors(errors)}

Previous artifact source:
\`\`\`html
${clipMiddle(source, MAX_RUNTIME_REPAIR_SOURCE_CHARS)}
\`\`\``;
}

function loadThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "night";
  }

  return window.localStorage.getItem(THEME_STORAGE_KEY) === "day"
    ? "day"
    : "night";
}

function loadLegacyLocalSessionState(): SessionState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(LEGACY_SESSION_STORAGE_KEY) ?? "[]"
    ) as unknown;
    const sessions = Array.isArray(parsed)
      ? parsed
          .map(normalizeStoredSession)
          .filter((session): session is ChatSession => session !== null)
      : [];

    if (!sessions.length) {
      return null;
    }

    const sorted = sortSessions(sessions);
    const storedActiveId = window.localStorage.getItem(
      LEGACY_ACTIVE_SESSION_STORAGE_KEY
    );
    const activeSessionId = sorted.some((session) => session.id === storedActiveId)
      ? storedActiveId ?? sorted[0].id
      : sorted[0].id;

    return { sessions: sorted, activeSessionId };
  } catch {
    return null;
  }
}

function clearLegacyLocalSessions(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_ACTIVE_SESSION_STORAGE_KEY);
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

function toAssistantStatus(message: ClientMessage): ThreadMessageLike["status"] {
  if (message.role !== "assistant") {
    return undefined;
  }

  if (message.status === "streaming") {
    return { type: "running" };
  }

  if (message.status === "error") {
    return {
      type: "incomplete",
      reason: "error",
      error: message.error ?? "The chat request failed."
    };
  }

  return { type: "complete", reason: "stop" };
}

function convertMessage(message: ClientMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.content
      ? [{ type: "text", text: message.content }]
      : [],
    status: toAssistantStatus(message),
    attachments:
      message.role === "user"
        ? message.attachments?.map(imageAttachmentToCompleteAttachment)
        : undefined
  };
}

function getAppendMessageText(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

function findSessionMessage(
  state: SessionState,
  messageId: string
): ClientMessage | undefined {
  for (const session of state.sessions) {
    const message = session.messages.find((candidate) => candidate.id === messageId);
    if (message) {
      return message;
    }
  }

  return undefined;
}

function isTerminalAssistantStatus(
  status: ClientMessage["status"] | undefined
): status is "complete" | "error" {
  return status === "complete" || status === "error";
}

function isImageAttachment(
  attachment: ImageAttachment | null
): attachment is ImageAttachment {
  return attachment !== null;
}

function getAppendMessageImages(message: AppendMessage): ImageAttachment[] {
  const fromAttachments =
    message.attachments
      ?.map(completeAttachmentToImage)
      .filter(isImageAttachment) ?? [];
  const fromInlineParts = message.content
    .map((part): ImageAttachment | null => {
      if (part.type !== "image") {
        return null;
      }
      return {
        id: createId("inline-image"),
        name: part.filename ?? "image",
        mimeType: "image/png",
        size: Math.floor(((part.image.split(",")[1] ?? "").length * 3) / 4),
        dataUrl: part.image
      };
    })
    .filter(isImageAttachment);

  return [...fromAttachments, ...fromInlineParts];
}

type StreamThreadProps = {
  activeSessionId: string;
  messages: ClientMessage[];
  files: SessionFile[];
  themeMode: ThemeMode;
  model: string;
  modelOptions: string[];
  reasoningEffort: ReasoningEffort;
  onRuntimeError(id: string, error: RenderError): void;
  onModelChange(model: string): void;
  onReasoningEffortChange(reasoningEffort: ReasoningEffort): void;
};

const SESSION_OUTPUT_SCROLL_SETTLE_MS = 900;
const SESSION_OUTPUT_SCROLL_RETRY_MS = [0, 80, 240, 520];

function scrollToLastOutputStart(viewport: HTMLElement): boolean {
  const outputs = Array.from(
    viewport.querySelectorAll<HTMLElement>(".assistant-canvas")
  );
  const assistantRows = Array.from(
    viewport.querySelectorAll<HTMLElement>(".chat-row.assistant")
  );
  const target =
    outputs[outputs.length - 1] ?? assistantRows[assistantRows.length - 1];

  if (!target) {
    return false;
  }

  const viewportRect = viewport.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const paddingTop = Number.parseFloat(getComputedStyle(viewport).paddingTop) || 0;
  const top =
    viewport.scrollTop + targetRect.top - viewportRect.top - paddingTop;

  viewport.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  return true;
}

function StreamThread({
  activeSessionId,
  messages,
  files,
  themeMode,
  model,
  modelOptions,
  reasoningEffort,
  onRuntimeError,
  onModelChange,
  onReasoningEffortChange
}: StreamThreadProps) {
  const isNewChat = useAuiState((state) => state.thread.messages.length === 0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  );
  const fileById = useMemo(
    () => new Map(files.map((file) => [file.id, file])),
    [files]
  );

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return undefined;
    }

    const timeoutIds: number[] = [];
    const animationFrameId = window.requestAnimationFrame(() => {
      scrollToLastOutputStart(viewport);
    });

    SESSION_OUTPUT_SCROLL_RETRY_MS.forEach((delay) => {
      timeoutIds.push(
        window.setTimeout(() => scrollToLastOutputStart(viewport), delay)
      );
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => scrollToLastOutputStart(viewport));

    if (resizeObserver) {
      viewport
        .querySelectorAll<HTMLElement>(
          ".chat-row, .assistant-canvas, .preview-frame"
        )
        .forEach((element) => resizeObserver.observe(element));
    }

    const settleTimeoutId = window.setTimeout(() => {
      resizeObserver?.disconnect();
    }, SESSION_OUTPUT_SCROLL_SETTLE_MS);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      window.clearTimeout(settleTimeoutId);
      resizeObserver?.disconnect();
    };
  }, [activeSessionId]);

  return (
    <ThreadPrimitive.Root
      className={`thread-root ${isNewChat ? "is-new" : "has-messages"}`}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        className={`message-list ${isNewChat ? "is-new" : "has-messages"}`}
        scrollToBottomOnRunStart
        scrollToBottomOnInitialize
      >
        <AuiIf condition={(state) => state.thread.messages.length === 0}>
          <section className="thread-welcome">
            <p>StreamUI Runtime</p>
            <h2>How can I help you today?</h2>
          </section>
        </AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) => {
            const clientMessage = messageById.get(message.id);
            if (!clientMessage) {
              return null;
            }

            if (clientMessage.role === "assistant") {
              return (
                <AssistantMessage
                  id={clientMessage.id}
                  content={clientMessage.content}
                  reasoning={clientMessage.reasoning}
                  rawStream={clientMessage.rawStream}
                  hasStreamUi={clientMessage.hasStreamUi}
                  snapshot={clientMessage.snapshot}
                  runtimeErrors={clientMessage.runtimeErrors}
                  themeMode={themeMode}
                  status={clientMessage.status}
                  error={clientMessage.error}
                  onRuntimeError={onRuntimeError}
                />
              );
            }

            return (
              <ChatMessage
                role={clientMessage.role}
                files={clientMessage.fileIds
                  ?.map((fileId) => fileById.get(fileId))
                  .filter((file): file is SessionFile => Boolean(file))}
              >
                {clientMessage.content}
              </ChatMessage>
            );
          }}
        </ThreadPrimitive.Messages>
        <ThreadPrimitive.ViewportFooter
          className={`composer-footer ${isNewChat ? "is-new" : "has-messages"}`}
        >
          <ChatInput
            model={model}
            modelOptions={modelOptions}
            reasoningEffort={reasoningEffort}
            onModelChange={onModelChange}
            onReasoningEffortChange={onReasoningEffortChange}
          />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

export default function App() {
  const [sessionState, setSessionState] =
    useState<SessionState>(createInitialSessionState);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  const [apiSettings, setApiSettings] = useState<ApiSettings>(loadApiSettings);
  const [searchSettings, setSearchSettings] =
    useState<SearchSettings>(loadSearchSettings);
  const [runtimeSettings, setRuntimeSettings] =
    useState<RuntimeSettingsSummary | null>(null);
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
  const messages = activeSession?.messages ?? initialMessages;
  const activeFiles = activeSession?.files ?? [];
  const selectableModels = useMemo(
    () => getSelectableModelOptions(apiSettings),
    [apiSettings]
  );
  const sessionClientIdRef = useRef(loadSessionClientId());
  const sessionStateRef = useRef(sessionState);
  const deletedSessionIdsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef(messages);
  const activeSessionIdRef = useRef(sessionState.activeSessionId);
  const isSendingRef = useRef(isSending);
  const sessionsLoadedRef = useRef(sessionsLoaded);
  const saveAbortRef = useRef<AbortController | null>(null);
  const lastSavedSessionPayloadRef = useRef<string | null>(null);
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());
  const runConnectionsRef = useRef<Map<string, AbortController>>(new Map());
  const runtimeRepairQueueRef = useRef<
    ((id: string, error: RenderError) => void) | null
  >(null);
  const runtimeRepairInFlightRef = useRef<Set<string>>(new Set());
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

  useEffect(() => {
    sessionStateRef.current = sessionState;
    messagesRef.current = messages;
    activeSessionIdRef.current = sessionState.activeSessionId;
  }, [messages, sessionState]);

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
    if (typeof window === "undefined") {
      return undefined;
    }

    let cancelled = false;
    const hadSavedApiSettings = hasSavedApiSettings();

    loadRuntimeSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        setRuntimeSettings(settings);
        if (!hadSavedApiSettings) {
          setApiSettings(normalizeApiSettings(settings.api.defaults));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Could not load StreamUI runtime settings.", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveApiSettings(apiSettings);
  }, [apiSettings]);

  useEffect(() => {
    saveSearchSettings(searchSettings);
  }, [searchSettings]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let cancelled = false;

    fetch("/api/sessions", {
      headers: sessionRequestHeaders(sessionClientIdRef.current)
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Session load failed with HTTP ${response.status}.`);
        }
        return response.json() as Promise<unknown>;
      })
      .then((data) => {
        if (!cancelled) {
          const serverState = normalizeStoredSessionState(data);
          const legacyState = loadLegacyLocalSessionState();
          setSessionStateAndRef(
            !hasPersistedMessages(serverState) &&
              legacyState &&
              hasPersistedMessages(legacyState)
              ? legacyState
              : serverState
          );
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Could not load StreamUI sessions.", error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          sessionsLoadedRef.current = true;
          setSessionsLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setSessionStateAndRef]);

  useEffect(() => {
    if (typeof window === "undefined" || !sessionsLoaded) {
      return undefined;
    }

    let cancelled = false;

    const syncSessions = async () => {
      if (runConnectionsRef.current.size > 0) {
        return;
      }

      try {
        const response = await fetch("/api/sessions", {
          headers: sessionRequestHeaders(sessionClientIdRef.current)
        });
        if (!response.ok) {
          throw new Error(`Session sync failed with HTTP ${response.status}.`);
        }

        const serverState = normalizeStoredSessionState(await response.json());
        if (cancelled) {
          return;
        }

        setSessionStateAndRef((current) => {
          const activeSessionId = serverState.sessions.some(
            (session) => session.id === current.activeSessionId
          )
            ? current.activeSessionId
            : serverState.activeSessionId;
          const next = {
            ...serverState,
            activeSessionId
          };
          const deletedSessionIds = Array.from(deletedSessionIdsRef.current);
          const currentPayload = serializeSessionStateForSave(
            current,
            sessionClientIdRef.current,
            deletedSessionIds
          );
          const nextPayload = serializeSessionStateForSave(
            next,
            sessionClientIdRef.current,
            deletedSessionIds
          );

          return currentPayload === nextPayload ? current : next;
        });
      } catch (error) {
        if (!cancelled) {
          console.warn("Could not sync StreamUI sessions.", error);
        }
      }
    };

    const intervalId = window.setInterval(
      () => void syncSessions(),
      SESSION_SYNC_INTERVAL_MS
    );
    void syncSessions();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [sessionsLoaded, setSessionStateAndRef]);

  useEffect(() => {
    if (typeof window === "undefined" || !sessionsLoaded) {
      return undefined;
    }

    const controller = new AbortController();
    saveAbortRef.current?.abort();
    saveAbortRef.current = controller;
    const serializedState = serializeSessionStateForSave(
      sessionState,
      sessionClientIdRef.current,
      Array.from(deletedSessionIdsRef.current)
    );

    const timeout = window.setTimeout(() => {
      saveSerializedSessionState(
        serializedState,
        sessionClientIdRef.current,
        controller.signal
      )
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Session save failed with HTTP ${response.status}.`);
          }

          lastSavedSessionPayloadRef.current = serializedState;
          clearLegacyLocalSessions();
        })
        .catch((error) => {
          if ((error as { name?: unknown }).name !== "AbortError") {
            console.warn("Could not save StreamUI sessions.", error);
          }
        });
    }, 350);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sessionState, sessionsLoaded]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const flushSessions = () => {
      if (!sessionsLoadedRef.current) {
        return;
      }

      const serializedState = serializeSessionStateForSave(
        sessionStateRef.current,
        sessionClientIdRef.current,
        Array.from(deletedSessionIdsRef.current)
      );
      if (serializedState === lastSavedSessionPayloadRef.current) {
        return;
      }

      lastSavedSessionPayloadRef.current = serializedState;
      saveSessionStateOnPageExit(serializedState, sessionClientIdRef.current);
    };

    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        flushSessions();
      }
    };

    window.addEventListener("pagehide", flushSessions);
    window.addEventListener("beforeunload", flushSessions);
    document.addEventListener("visibilitychange", flushWhenHidden);

    return () => {
      window.removeEventListener("pagehide", flushSessions);
      window.removeEventListener("beforeunload", flushSessions);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, []);

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

  const updateAssistant = useCallback(
    (id: string, patch: Partial<ClientMessage>) => {
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
            return { ...message, ...patch };
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

  const handleRuntimeError = useCallback(
    (id: string, error: RenderError) => {
      const currentMessage = messagesRef.current.find(
        (message) => message.id === id
      );
      const isKnownError =
        hasRenderError(currentMessage?.runtimeErrors, error) ||
        hasRenderError(currentMessage?.snapshot?.errors, error);

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

      if (!isKnownError) {
        window.setTimeout(() => {
          runtimeRepairQueueRef.current?.(id, error);
        }, 0);
      }
    },
    [setSessionStateAndRef]
  );

  const handleNewSession = useCallback(() => {
    if (isSendingRef.current) {
      return;
    }

    setSessionStateAndRef((current) => {
      const active = current.sessions.find(
        (session) => session.id === current.activeSessionId
      );
      if (active && active.messages.length === 0) {
        return current;
      }

      const session = createEmptySession();
      return {
        sessions: [session, ...current.sessions],
        activeSessionId: session.id
      };
    });
  }, [setSessionStateAndRef]);

  const handleSelectSession = useCallback((id: string) => {
    setSessionStateAndRef((current) =>
      current.sessions.some((session) => session.id === id)
        ? { ...current, activeSessionId: id }
        : current
    );
  }, [setSessionStateAndRef]);

  const handleDeleteSession = useCallback((id: string) => {
    if (isSendingRef.current) {
      return;
    }

    deletedSessionIdsRef.current.add(id);
    setSessionStateAndRef((current) => {
      const remaining = current.sessions.filter((session) => session.id !== id);
      if (!remaining.length) {
        const session = createEmptySession();
        return {
          sessions: [session],
          activeSessionId: session.id
        };
      }

      const activeSessionId =
        current.activeSessionId === id ? remaining[0].id : current.activeSessionId;

      return {
        sessions: remaining,
        activeSessionId
      };
    });
  }, [setSessionStateAndRef]);

  const handleApiSettingsChange = useCallback((next: ApiSettings) => {
    setApiSettings(normalizeApiSettings(next));
  }, []);

  const handleSearchSettingsChange = useCallback((next: SearchSettings) => {
    setSearchSettings(normalizeSearchSettings(next));
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        model
      })
    );
  }, []);

  const handleReasoningEffortChange = useCallback(
    (reasoningEffort: ReasoningEffort) => {
      setApiSettings((current) =>
        normalizeApiSettings({
          ...current,
          reasoningEffort
        })
      );
    },
    []
  );

  const handleMemoryStreamEvent = useCallback((event: MemoryStreamEvent) => {
    setApiSettings((current) => applyMemoryStreamEvent(current, event));
  }, []);

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
      const userMessageId = createId("user");
      const previousMessages = messagesRef.current;
      const uploadedFiles = attachments
        .map((attachment) => commitUploadedImageFile(attachment, userMessageId))
        .filter((file): file is SessionFile => file !== null);
      const hasUnuploadedAttachments = uploadedFiles.length !== attachments.length;
      const userMessage: ClientMessage = {
        id: userMessageId,
        role: "user",
        content: trimmed,
        fileIds: uploadedFiles.length
          ? uploadedFiles.map((file) => file.id)
          : undefined,
        status: "complete"
      };
      const assistantId = createId("assistant");
      const generationRunId = createId("run");
      const assistantMessage: ClientMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        rawStream: "",
        generationRunId,
        streamSequence: 0,
        status: "streaming",
        ...(options.initialReasoning
          ? { reasoning: options.initialReasoning }
          : {}),
        ...options.assistantPatch
      };
      const renderer = createStreamingRenderer(themeMode);
      renderersRef.current.set(assistantId, renderer);
      const streamController = new AbortController();
      runConnectionsRef.current.set(generationRunId, streamController);

      const unsubscribeSnapshot = renderer.onSnapshot((snapshot) => {
        updateAssistant(assistantId, { snapshot });
      });

      updateActiveSession((session) => {
        const nextMessages = appendUserMessage
          ? [...session.messages, userMessage, assistantMessage]
          : [...session.messages, assistantMessage];

        return {
          ...session,
          title: summarizeSession(nextMessages),
          updatedAt: Date.now(),
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
        if (serverMessage.role !== "assistant") {
          return;
        }
        if (
          serverMessage.generationRunId &&
          serverMessage.generationRunId !== generationRunId
        ) {
          return;
        }

        const serverSequence = serverMessage.streamSequence ?? 0;
        const serverRaw = serverMessage.rawStream ?? "";
        const serverReasoning = serverMessage.reasoning ?? "";
        const terminalStatus = isTerminalAssistantStatus(serverMessage.status)
          ? serverMessage.status
          : undefined;
        const hasNewerStream =
          serverSequence > lastStreamSequence ||
          serverRaw.length > raw.length ||
          serverReasoning.length > reasoning.length;
        const hasTerminalUpdate =
          Boolean(terminalStatus) && doneStatus !== terminalStatus;

        if (!hasNewerStream && !hasTerminalUpdate) {
          return;
        }

        raw = serverRaw || raw;
        reasoning = serverReasoning || reasoning;
        lastStreamSequence = Math.max(lastStreamSequence, serverSequence);
        updateAssistant(assistantId, serverMessage);

        if (terminalStatus) {
          doneStatus = terminalStatus;
          doneError = serverMessage.error ?? "";
          completedFromServer = true;
          streamController.abort();
        }
      };

      const reconcileAssistantFromServer = async () => {
        if (serverSyncInFlight || completedFromServer) {
          return;
        }

        serverSyncInFlight = true;
        try {
          const response = await fetch("/api/sessions", {
            headers: sessionRequestHeaders(sessionClientIdRef.current)
          });
          if (!response.ok) {
            throw new Error(`Session sync failed with HTTP ${response.status}.`);
          }

          const serverState = normalizeStoredSessionState(await response.json());
          const serverMessage = findSessionMessage(serverState, assistantId);
          if (serverMessage) {
            applyServerAssistantMessage(serverMessage);
          }
        } catch (error) {
          if ((error as { name?: unknown }).name !== "AbortError") {
            console.warn("Could not reconcile StreamUI stream state.", error);
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

      const handleStreamEvent = (line: string) => {
        if (!line.trim()) {
          return;
        }

        try {
          const event = JSON.parse(line) as ChatStreamEvent;
          const streamSequence =
            typeof event.seq === "number" && Number.isFinite(event.seq)
              ? Math.max(0, Math.round(event.seq))
              : undefined;
          if (typeof streamSequence === "number") {
            lastStreamSequence = streamSequence;
          }
          if (event.type === "done") {
            doneStatus = event.status === "error" ? "error" : "complete";
            doneError = event.error ?? "";
            if (typeof streamSequence === "number") {
              updateAssistant(assistantId, { streamSequence });
            }
            return;
          }
          if (event.type === "memory") {
            handleMemoryStreamEvent(event);
            if (typeof streamSequence === "number") {
              updateAssistant(assistantId, { streamSequence });
            }
            return;
          }
          if (event.type === "reasoning" && event.text) {
            reasoning += event.text;
            updateAssistant(assistantId, {
              reasoning,
              ...(typeof streamSequence === "number" ? { streamSequence } : {})
            });
            return;
          }
          if (event.type === "content" && event.text) {
            handleContentChunk(event.text, streamSequence);
            return;
          }
        } catch {
          handleContentChunk(line);
        }
      };

      try {
        if (hasUnuploadedAttachments) {
          throw new Error("Image upload is still in progress. Please wait before sending.");
        }

        const requestSessionId = activeSessionIdRef.current;
        const requestHistory = options.requestHistory ?? [...previousMessages, userMessage];
        const requestSession = sessionStateRef.current.sessions.find(
          (session) => session.id === requestSessionId
        );
        const requestFiles = mergeSessionFiles([
          ...(requestSession?.files ?? []),
          ...uploadedFiles
        ]);
        startServerReconcile();

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: sessionRequestHeaders(
            sessionClientIdRef.current,
            "application/json"
          ),
          signal: streamController.signal,
          body: JSON.stringify({
            clientId: sessionClientIdRef.current,
            sessionId: requestSessionId,
            runId: generationRunId,
            userMessage: appendUserMessage ? userMessage : undefined,
            assistantMessage,
            messages: toApiMessages(requestHistory),
            files: requestFiles,
            canvas: getCanvasContext(),
            themeMode,
            apiSettings: serializeApiSettings(apiSettings),
            searchSettings: serializeSearchSettings(searchSettings)
          })
        });

        if (!response.ok || !response.body) {
          const errorText = await response.text();
          throw new Error(errorText || `Request failed with ${response.status}.`);
        }
        streamConnected = true;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let streamBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          streamBuffer += decoder.decode(value, { stream: true });
          const lines = streamBuffer.split("\n");
          streamBuffer = lines.pop() ?? "";
          lines.forEach(handleStreamEvent);
        }

        const tail = decoder.decode();
        if (tail) {
          streamBuffer += tail;
        }
        if (streamBuffer.trim()) {
          streamBuffer.split("\n").forEach(handleStreamEvent);
        }

        await reconcileAssistantFromServer();

        if (completedFromServer) {
          return;
        }

        if (doneStatus === "error") {
          const finalParts = extractStreamUiParts(raw);
          updateAssistant(assistantId, {
            content:
              finalParts.chat ||
              finalParts.fallbackText ||
              "I could not complete that request.",
            reasoning,
            rawStream: raw,
            streamSequence: lastStreamSequence,
            error: doneError || "The chat request failed.",
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

        updateAssistant(assistantId, {
          content: finalParts.chat || finalParts.fallbackText,
          reasoning,
          ...(finalParts.sessionTitleComplete && finalParts.sessionTitle.trim()
            ? { sessionTitle: finalParts.sessionTitle }
            : {}),
          rawStream: raw,
          streamSequence: lastStreamSequence,
          ...(finalSnapshot ? { snapshot: finalSnapshot } : {}),
          ...(artifactContext ? { artifactContext } : {}),
          hasStreamUi: finalParts.hasStreamUi && finalParts.streamui.trim().length > 0,
          streamUiComplete: finalParts.streamUiComplete,
          status: "complete"
        });
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
            console.warn("Could not persist StreamUI artifact file.", uploadError);
          }
        }
      } catch (error) {
        if (completedFromServer) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "The chat request failed.";
        if (streamConnected && doneStatus !== "error") {
          updateAssistant(assistantId, {
            reasoning,
            rawStream: raw,
            streamSequence: lastStreamSequence,
            status: "streaming"
          });
          return;
        }
        updateAssistant(assistantId, {
          content: "I could not complete that request.",
          error: message,
          reasoning,
          rawStream: raw,
          streamSequence: lastStreamSequence,
          status: "error"
        });
      } finally {
        if (typeof serverSyncIntervalId === "number") {
          window.clearInterval(serverSyncIntervalId);
        }
        unsubscribeSnapshot();
        renderersRef.current.delete(assistantId);
        runConnectionsRef.current.delete(generationRunId);
        setIsSending(runConnectionsRef.current.size > 0);
      }
    },
    [
      apiSettings,
      handleMemoryStreamEvent,
      searchSettings,
      themeMode,
      updateActiveSession,
      updateAssistant,
      upsertSessionFiles
    ]
  );

  useEffect(() => {
    if (!sessionsLoaded) {
      return;
    }

    const refreshSessionsFromServer = async () => {
      const response = await fetch("/api/sessions", {
        headers: sessionRequestHeaders(sessionClientIdRef.current)
      });
      if (!response.ok) {
        throw new Error(`Session load failed with HTTP ${response.status}.`);
      }
      setSessionStateAndRef(normalizeStoredSessionState(await response.json()));
    };

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
            if (serverMessage.role !== "assistant") {
              return;
            }
            if (
              serverMessage.generationRunId &&
              serverMessage.generationRunId !== generationRunId
            ) {
              return;
            }

            const serverSequence = serverMessage.streamSequence ?? 0;
            const serverRaw = serverMessage.rawStream ?? "";
            const serverReasoning = serverMessage.reasoning ?? "";
            const terminalStatus = isTerminalAssistantStatus(serverMessage.status)
              ? serverMessage.status
              : undefined;
            const hasNewerStream =
              serverSequence > lastStreamSequence ||
              serverRaw.length > raw.length ||
              serverReasoning.length > reasoning.length;
            const hasTerminalUpdate =
              Boolean(terminalStatus) && doneStatus !== terminalStatus;

            if (!hasNewerStream && !hasTerminalUpdate) {
              return;
            }

            raw = serverRaw || raw;
            reasoning = serverReasoning || reasoning;
            lastStreamSequence = Math.max(lastStreamSequence, serverSequence);
            updateAssistant(message.id, serverMessage);

            if (terminalStatus) {
              doneStatus = terminalStatus;
              doneError = serverMessage.error ?? "";
              completedFromServer = true;
              controller.abort();
            }
          };

          const reconcileAssistantFromServer = async () => {
            if (serverSyncInFlight || completedFromServer) {
              return;
            }

            serverSyncInFlight = true;
            try {
              const response = await fetch("/api/sessions", {
                headers: sessionRequestHeaders(sessionClientIdRef.current)
              });
              if (!response.ok) {
                throw new Error(`Session sync failed with HTTP ${response.status}.`);
              }

              const serverState = normalizeStoredSessionState(await response.json());
              const serverMessage = findSessionMessage(serverState, message.id);
              if (serverMessage) {
                applyServerAssistantMessage(serverMessage);
              }
            } catch (error) {
              if ((error as { name?: unknown }).name !== "AbortError") {
                console.warn("Could not reconcile StreamUI stream state.", error);
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

          const handleStreamEvent = (line: string) => {
            if (!line.trim()) {
              return;
            }

            try {
              const event = JSON.parse(line) as ChatStreamEvent;
              const streamSequence =
                typeof event.seq === "number" && Number.isFinite(event.seq)
                  ? Math.max(0, Math.round(event.seq))
                  : undefined;
              if (typeof streamSequence === "number") {
                lastStreamSequence = streamSequence;
              }
              if (event.type === "done") {
                doneStatus = event.status === "error" ? "error" : "complete";
                doneError = event.error ?? "";
                if (typeof streamSequence === "number") {
                  updateAssistant(message.id, { streamSequence });
                }
                return;
              }
              if (event.type === "memory") {
                handleMemoryStreamEvent(event);
                if (typeof streamSequence === "number") {
                  updateAssistant(message.id, { streamSequence });
                }
                return;
              }
              if (event.type === "reasoning" && event.text) {
                reasoning += event.text;
                updateAssistant(message.id, {
                  reasoning,
                  ...(typeof streamSequence === "number"
                    ? { streamSequence }
                    : {})
                });
                return;
              }
              if (event.type === "content" && event.text) {
                handleContentChunk(event.text, streamSequence);
                return;
              }
            } catch {
              handleContentChunk(line);
            }
          };

          try {
            startServerReconcile();
            const response = await fetch(
              `/api/chat/runs/${encodeURIComponent(
                generationRunId
              )}/events?after=${encodeURIComponent(String(lastStreamSequence))}`,
              {
                headers: sessionRequestHeaders(sessionClientIdRef.current),
                signal: controller.signal
              }
            );

            if (response.status === 404) {
              await refreshSessionsFromServer();
              return;
            }

            if (!response.ok || !response.body) {
              const errorText = await response.text();
              throw new Error(
                errorText || `Run resume failed with HTTP ${response.status}.`
              );
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let streamBuffer = "";

            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }

              streamBuffer += decoder.decode(value, { stream: true });
              const lines = streamBuffer.split("\n");
              streamBuffer = lines.pop() ?? "";
              lines.forEach(handleStreamEvent);
            }

            const tail = decoder.decode();
            if (tail) {
              streamBuffer += tail;
            }
            if (streamBuffer.trim()) {
              streamBuffer.split("\n").forEach(handleStreamEvent);
            }

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
                error: doneError || "The chat request failed.",
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
            if ((error as { name?: unknown }).name !== "AbortError") {
              console.warn("Could not resume StreamUI run.", error);
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

  const requestRuntimeRepair = useCallback(
    async (id: string, error: RenderError) => {
      if (!isRepairableRuntimeError(error)) {
        return;
      }

      if (isSendingRef.current) {
        window.setTimeout(() => {
          void requestRuntimeRepair(id, error);
        }, 500);
        return;
      }

      const messages = messagesRef.current;
      const target = messages.find((message) => message.id === id);
      if (
        !target ||
        target.role !== "assistant" ||
        target.status === "streaming" ||
        !target.hasStreamUi ||
        (!target.rawStream && !target.snapshot?.raw)
      ) {
        return;
      }

      const rootMessageId = getRepairRootId(target);
      const attempt = getRuntimeRepairAttempt(messages, rootMessageId) + 1;
      if (attempt > MAX_RUNTIME_REPAIR_ATTEMPTS) {
        return;
      }

      const repairErrors = [
        ...(target.runtimeErrors ?? target.snapshot?.errors ?? []),
        error
      ];
      const repairKey = `${rootMessageId}:${attempt}:${renderErrorKey(error)}`;
      if (runtimeRepairInFlightRef.current.has(repairKey)) {
        return;
      }

      runtimeRepairInFlightRef.current.add(repairKey);
      try {
        const repairPrompt = buildRuntimeRepairPrompt(
          target,
          repairErrors,
          attempt
        );
        const repairUserMessage: ClientMessage = {
          id: createId("runtime-repair"),
          role: "user",
          content: repairPrompt,
          status: "complete"
        };
        const initialReasoning = `Auto repair ${attempt}/${MAX_RUNTIME_REPAIR_ATTEMPTS}: ${error.kind} error detected. Retrying artifact generation...\n`;

        await sendStreamUiRequest(repairPrompt, [], {
          appendUserMessage: false,
          requestHistory: [...messages, repairUserMessage],
          initialReasoning,
          assistantPatch: {
            repairOfMessageId: rootMessageId,
            repairAttempt: attempt
          }
        });
      } finally {
        runtimeRepairInFlightRef.current.delete(repairKey);
      }
    },
    [sendStreamUiRequest]
  );

  useEffect(() => {
    runtimeRepairQueueRef.current = (id, error) => {
      void requestRuntimeRepair(id, error);
    };

    return () => {
      runtimeRepairQueueRef.current = null;
    };
  }, [requestRuntimeRepair]);

  const handleNewMessage = useCallback(
    async (message: AppendMessage) => {
      if (
        attachmentUploadGate.inFlight > 0 ||
        attachmentUploadGate.errorIds.length > 0
      ) {
        return;
      }

      await sendStreamUiRequest(
        getAppendMessageText(message),
        getAppendMessageImages(message)
      );
    },
    [attachmentUploadGate.errorIds.length, attachmentUploadGate.inFlight, sendStreamUiRequest]
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: isSending,
    isSendDisabled:
      isSending ||
      attachmentUploadGate.inFlight > 0 ||
      attachmentUploadGate.errorIds.length > 0,
    convertMessage,
    onNew: handleNewMessage,
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatShell
        themeMode={themeMode}
        sidebar={
          <SessionSidebar
            sessions={sessionItems}
            activeSessionId={sessionState.activeSessionId}
            isSending={isSending}
            themeMode={themeMode}
            apiSettings={apiSettings}
            searchSettings={searchSettings}
            runtimeSettings={runtimeSettings}
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            onThemeModeChange={setThemeMode}
            onApiSettingsChange={handleApiSettingsChange}
            onSearchSettingsChange={handleSearchSettingsChange}
          />
        }
      >
        <StreamThread
          activeSessionId={sessionState.activeSessionId}
          messages={messages}
          files={activeFiles}
          themeMode={themeMode}
          model={apiSettings.model}
          modelOptions={selectableModels}
          reasoningEffort={apiSettings.reasoningEffort}
          onRuntimeError={handleRuntimeError}
          onModelChange={handleModelChange}
          onReasoningEffortChange={handleReasoningEffortChange}
        />
      </ChatShell>
    </AssistantRuntimeProvider>
  );
}
