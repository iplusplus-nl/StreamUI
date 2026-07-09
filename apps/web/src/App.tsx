import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { CheckCircle2, LoaderCircle, X } from "lucide-react";
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
import { BugReportDialog } from "./components/BugReportDialog";
import { stripSyntheticReasoningStatus } from "./core/reasoningText";
import {
  SessionSidebar,
  type SessionListItem,
  type ThemeMode
} from "./components/SessionSidebar";
import { AuthOverlay } from "./components/AuthOverlay";
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
  normalizeUiComplexity,
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
import {
  loadAuthSummary,
  logout as logoutAuth,
  type AuthSummary,
  type AuthUser
} from "./core/cloudAuth";
import {
  loadDisplaySettings,
  normalizeDisplaySettings,
  saveDisplaySettings,
  type DisplaySettings
} from "./core/displaySettings";
import { buildArtifactContext } from "./core/artifactContext";
import {
  MAX_ARTIFACT_SELECTIONS,
  type ArtifactSelection,
  type ArtifactSelectionPayload
} from "./core/artifactSelection";
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
  filterDeletedSessionState,
  getSessionStreamingRunIds,
  hasPersistedMessages,
  interruptStaleArtifactEditsInSessionState,
  initialMessages,
  isSessionEmpty,
  mergeSyncedSessionState,
  normalizeStoredSession,
  normalizeStoredSessionState,
  normalizeBugReportDraft,
  serializeSessions,
  sortSessions,
  MAX_BUG_REPORT_IMAGES,
  STALE_ARTIFACT_EDIT_SWEEP_INTERVAL_MS,
  STREAM_INTERRUPTED_ERROR,
  summarizeSession,
  type ArtifactEdit,
  type ArtifactEditReference,
  type BugReportDraft,
  type BugReportImage,
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
  PageThemeMode,
  RenderError,
  RenderSnapshot,
  StreamUiAction,
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

type ArtifactEditResponse = {
  rawStream: string;
  summary?: string;
  edits?: Array<{
    note?: string;
    occurrence?: number;
    findLength?: number;
    replaceLength?: number;
  }>;
};

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

type MessageBranchInfo = {
  groupId: string;
  activeIndex: number;
  total: number;
  previousVariantId?: string;
  nextVariantId?: string;
};

type ArtifactVersionInfo = {
  activeIndex: number;
  total: number;
  previousEditId?: string | null;
  nextEditId?: string | null;
  disabled?: boolean;
};

const LEGACY_SESSION_STORAGE_KEY = "streamui.sessions.v1";
const LEGACY_ACTIVE_SESSION_STORAGE_KEY = "streamui.activeSession.v1";
const THEME_STORAGE_KEY = "streamui.theme.v1";
const SESSION_CLIENT_ID_STORAGE_KEY = "streamui.clientId.v1";
const SESSION_INDEX_CACHE_KEY = "streamui.sessionIndex.v1";
const SESSION_CLIENT_ID_HEADER = "X-ChatHTML-Client-Id";
const SESSION_SYNC_INTERVAL_MS = 4_000;
const CHAT_CANCELLED_MESSAGE = "Generation stopped.";

type SessionListPreview = {
  activeSessionId: string;
  sessions: SessionListItem[];
};

function coerceApiSettingsForRuntime(
  settings: ApiSettings,
  runtimeSettings: RuntimeSettingsSummary | null
): ApiSettings {
  const normalized = normalizeApiSettings(settings);
  const managedProviderEnabled = Boolean(
    runtimeSettings?.cloud?.enabled &&
      runtimeSettings.cloud.managedProviderEnabled
  );

  if (normalized.apiKeySource !== "managed" || managedProviderEnabled) {
    return normalized;
  }

  const defaults = normalizeApiSettings(runtimeSettings?.api.defaults);
  return normalizeApiSettings({
    ...defaults,
    model: normalized.model || defaults.model,
    modelOptions: normalized.modelOptions.length
      ? normalized.modelOptions
      : defaults.modelOptions,
    reasoningEffort: normalized.reasoningEffort,
    uiComplexity: normalized.uiComplexity,
    userPreferencePrompt: normalized.userPreferencePrompt,
    memoryItems: normalized.memoryItems
  });
}

function mergeSessionFiles(files: SessionFile[]): SessionFile[] {
  const merged = new Map<string, SessionFile>();
  for (const file of files) {
    merged.set(file.id, file);
  }

  return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
}

function normalizeSessionListPreview(input: unknown): SessionListPreview | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const state = input as {
    activeSessionId?: unknown;
    sessions?: unknown;
  };
  if (!Array.isArray(state.sessions)) {
    return null;
  }

  const seen = new Set<string>();
  const sessions: SessionListItem[] = [];
  for (const item of state.sessions) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const session = item as { id?: unknown; title?: unknown };
    const id = typeof session.id === "string" ? session.id.trim() : "";
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    sessions.push({
      id,
      title:
        typeof session.title === "string" && session.title.trim()
          ? session.title.trim()
          : "New Session"
    });
  }

  if (!sessions.length) {
    return null;
  }

  const requestedActiveId =
    typeof state.activeSessionId === "string" ? state.activeSessionId : "";
  const activeSessionId = sessions.some(
    (session) => session.id === requestedActiveId
  )
    ? requestedActiveId
    : sessions[0].id;

  return {
    activeSessionId,
    sessions
  };
}

function sessionListPreviewFromState(state: SessionState): SessionListPreview | null {
  const sessions = state.sessions
    .filter((session) => !isSessionEmpty(session))
    .map((session) => ({
      id: session.id,
      title: session.title || summarizeSession(session.messages)
    }));

  if (!sessions.length) {
    return null;
  }

  const activeSessionId = sessions.some(
    (session) => session.id === state.activeSessionId
  )
    ? state.activeSessionId
    : sessions[0].id;

  return {
    activeSessionId,
    sessions
  };
}

function loadCachedSessionListPreview(): SessionListPreview | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return normalizeSessionListPreview(
      JSON.parse(window.localStorage.getItem(SESSION_INDEX_CACHE_KEY) ?? "null")
    );
  } catch {
    return null;
  }
}

function saveCachedSessionListPreview(preview: SessionListPreview | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (!preview) {
      window.localStorage.removeItem(SESSION_INDEX_CACHE_KEY);
      return;
    }

    window.localStorage.setItem(SESSION_INDEX_CACHE_KEY, JSON.stringify(preview));
  } catch {
    // Sidebar cache is only a startup hint.
  }
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Could not encode the rendered screenshot."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Could not read the rendered screenshot."));
    });
    reader.readAsDataURL(blob);
  });
}

const MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS = 7_000;

function clipVisualRepairDiagnostics(value: string): string {
  if (value.length <= MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS) {
    return value;
  }

  return `${value
    .slice(0, MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS - 120)
    .trimEnd()}\n\n[Diagnostics truncated; prioritize fixing layout, scale, overlap, clipping, and blur.]`;
}

function buildVisualRepairPrompt({
  diagnostics,
  hasScreenshot,
  width
}: {
  diagnostics?: string;
  hasScreenshot: boolean;
  width: number;
}): string {
  const lines = [
    hasScreenshot
      ? "Repair the previous ChatHTML artifact using the attached rendering screenshot."
      : "Repair the previous ChatHTML artifact using the textual render diagnostics below. The selected model cannot inspect image inputs, so infer visual failures from the artifact source, visible text, render errors, and layout intent.",
    hasScreenshot
      ? `The screenshot shows the actual rendered output at about ${Math.round(width)}px wide.`
      : `The diagnostics describe the rendered artifact at about ${Math.round(width)}px wide.`,
    "Inspect the screenshot or diagnostics for visual failures such as overlapping labels, clustered or unreadable content, clipped elements, bad scaling, excessive blur, tiny text, or poor use of space.",
    "Use the previous artifact source and the original user intent from the conversation as context.",
    "Generate a complete corrected ChatHTML artifact. Preserve the user's intent, but change the visual mapping if needed; do not keep realistic proportions when they make the result unreadable.",
    "Prefer readable compressed/log scales, callouts, legends, exploded views, or separated annotation lanes when exact spatial scale would collapse details.",
    "Do not explain the repair process outside the artifact."
  ];

  if (diagnostics) {
    lines.push(
      "",
      "Render diagnostics and artifact source:",
      clipVisualRepairDiagnostics(diagnostics)
    );
  }

  return lines.join("\n");
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
    name: `${messageId}.chathtml.html`,
    mimeType: "text/html",
    sourceMessageId: messageId,
    text: source,
    summary: summary || "ChatHTML artifact raw source"
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

async function submitBugReport(
  input: {
    sessionId: string;
    sessionTitle: string;
    draft: BugReportDraft;
  },
  clientId: string
): Promise<string> {
  const response = await fetch("/api/bug-reports", {
    method: "POST",
    headers: sessionRequestHeaders(clientId, "application/json"),
    body: JSON.stringify({
      clientId,
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      text: input.draft.text,
      images: input.draft.images,
      pageUrl: window.location.href,
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    })
  });

  const payload = (await response.json().catch(() => ({}))) as {
    id?: unknown;
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Bug report failed with HTTP ${response.status}.`
    );
  }

  return typeof payload.id === "string" ? payload.id : "";
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
  const compactedState = compactEmptySessions(state);

  return JSON.stringify({
    clientId,
    deletedSessionIds,
    sessions: serializeSessions(compactedState.sessions),
    activeSessionId: compactedState.activeSessionId
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
    console.warn("Could not flush ChatHTML sessions before page exit.", error);
  });
}

function compactErrorText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtmlErrorText(value: string): string {
  return compactErrorText(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
  );
}

function looksLikeHtmlError(value: string): boolean {
  return /<!doctype\s+html|<html\b|<head\b|<body\b|<\/?[a-z][\s\S]*>/i.test(
    value
  );
}

function extractHtmlErrorTitle(value: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  return match ? stripHtmlErrorText(match[1]) : "";
}

function safeErrorJsonMessage(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return "";
    }

    const error = parsed as { error?: unknown; message?: unknown };
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message.trim();
    }
    if (typeof error.error === "string" && error.error.trim()) {
      return error.error.trim();
    }
    if (error.error && typeof error.error === "object") {
      const nested = error.error as { message?: unknown };
      return typeof nested.message === "string" ? nested.message.trim() : "";
    }
  } catch {
    return "";
  }

  return "";
}

function sanitizeChatErrorMessage(
  value: string | undefined,
  fallback = "The chat request failed."
): string {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return fallback;
  }

  const jsonMessage = safeErrorJsonMessage(raw);
  if (jsonMessage) {
    return compactErrorText(jsonMessage).slice(0, 500);
  }

  if (looksLikeHtmlError(raw)) {
    return (
      extractHtmlErrorTitle(raw) ||
      stripHtmlErrorText(raw) ||
      fallback
    ).slice(0, 180);
  }

  return compactErrorText(raw).slice(0, 500);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isChatCancelledMessage(value: string | undefined): boolean {
  return compactErrorText(value ?? "") === CHAT_CANCELLED_MESSAGE;
}

function createCancelledAssistantPatch(
  raw: string,
  reasoning: string,
  streamSequence: number
): Partial<ClientMessage> {
  const parts = extractStreamUiParts(raw);

  return {
    content:
      parts.chat ||
      (!parts.hasStreamUi ? parts.fallbackText : "") ||
      CHAT_CANCELLED_MESSAGE,
    reasoning: reasoning || undefined,
    rawStream: raw,
    streamSequence,
    hasStreamUi: parts.hasStreamUi,
    streamUiComplete: parts.streamUiComplete,
    status: "complete",
    error: undefined
  };
}

function formatChatHttpError(response: Response, bodyText: string): string {
  const statusText = compactErrorText(response.statusText || "");
  const status = `HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`;
  const detail = sanitizeChatErrorMessage(bodyText, "");
  const prefix = `Request failed with ${status}.`;

  if (!detail || detail.toLowerCase().includes(String(response.status))) {
    return prefix;
  }

  return `${prefix} ${detail}`;
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
          .map((session) => normalizeStoredSession(session))
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

function artifactSelectionToReference(
  selection: ArtifactSelection
): ArtifactEditReference {
  return {
    kind: selection.kind,
    key: selection.key,
    selector: selection.selector,
    label: selection.label,
    preview: selection.preview,
    tagName: selection.tagName,
    text: selection.text,
    html: selection.html
  };
}

function buildCompletedAssistantPatchFromRawStream(
  rawStream: string,
  themeMode: PageThemeMode
): Partial<ClientMessage> {
  const parts = extractStreamUiParts(rawStream);
  const hasVisibleStreamUi =
    parts.hasStreamUi && parts.streamui.trim().length > 0;
  let snapshot: RenderSnapshot | undefined;

  if (hasVisibleStreamUi) {
    const renderer = createStreamingRenderer(themeMode);
    renderer.replace(parts.streamui);
    renderer.complete();
    snapshot = renderer.getSnapshot();
  }

  return {
    content: parts.chat || parts.fallbackText,
    rawStream,
    ...(snapshot ? { snapshot } : {}),
    ...(hasVisibleStreamUi ? { artifactContext: buildArtifactContext(rawStream) } : {}),
    hasStreamUi: hasVisibleStreamUi,
    streamUiComplete: parts.streamUiComplete,
    runtimeErrors: undefined,
    status: "complete",
    error: undefined
  };
}

function getArtifactEditRawStream(
  message: ClientMessage,
  editId: string | undefined
): string | undefined {
  if (!editId) {
    return message.artifactEditBaseRawStream ?? message.rawStream;
  }

  const edit = message.artifactEdits?.find((item) => item.id === editId);
  return edit ? getArtifactEditCompleteRawStream(edit) : undefined;
}

function getArtifactEditDisplayRawStream(
  message: ClientMessage,
  editId: string | undefined
): string | undefined {
  const rawStream = getArtifactEditRawStream(message, editId);
  if (rawStream || !editId) {
    return rawStream;
  }

  const edits = message.artifactEdits ?? [];
  const edit = edits.find((item) => item.id === editId);
  if (!edit || edit.status !== "error") {
    return undefined;
  }

  return getArtifactEditRawStream(
    message,
    getArtifactEditParentId(edits, edit)
  );
}

function getArtifactEditActiveVariant(edit: ArtifactEdit) {
  return (
    edit.variants.find((item) => item.id === edit.activeVariantId) ??
    edit.variants[0]
  );
}

function getArtifactEditCompleteRawStream(
  edit: ArtifactEdit
): string | undefined {
  if (edit.status !== "complete") {
    return undefined;
  }

  const variant = getArtifactEditActiveVariant(edit);
  return variant?.status === "complete" ? variant.rawStream : undefined;
}

function hasUsableArtifactEditVariant(edit: ArtifactEdit): boolean {
  return Boolean(getArtifactEditCompleteRawStream(edit));
}

function hasPendingArtifactEditVariant(edit: ArtifactEdit): boolean {
  return (
    edit.status === "pending" ||
    edit.variants.some((variant) => variant.status === "pending")
  );
}

function shouldShowArtifactEditPromptBubble(edit: ArtifactEdit): boolean {
  return edit.promptBubble !== false;
}

function shouldKeepFailedArtifactEditVersion(edit: ArtifactEdit): boolean {
  return edit.status === "error" && shouldShowArtifactEditPromptBubble(edit);
}

function getArtifactEditParentId(
  edits: ArtifactEdit[],
  edit: ArtifactEdit
): string | undefined {
  if (edit.parentId && edits.some((candidate) => candidate.id === edit.parentId)) {
    return edit.parentId;
  }

  const index = edits.findIndex((candidate) => candidate.id === edit.id);
  return index > 0 ? edits[index - 1].id : undefined;
}

function getArtifactEditChain(
  edits: ArtifactEdit[],
  editId: string | undefined
): ArtifactEdit[] {
  if (!editId) {
    return [];
  }

  const byId = new Map(edits.map((edit) => [edit.id, edit]));
  const chain: ArtifactEdit[] = [];
  const seen = new Set<string>();
  let current = byId.get(editId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const parentId = getArtifactEditParentId(edits, current);
    current = parentId ? byId.get(parentId) : undefined;
  }

  return chain.reverse();
}

function getResolvedArtifactEditId(message: ClientMessage): string | undefined {
  const edits = message.artifactEdits ?? [];
  if (
    message.activeArtifactEditId &&
    edits.some((edit) => edit.id === message.activeArtifactEditId)
  ) {
    return message.activeArtifactEditId;
  }

  if (!message.rawStream) {
    return undefined;
  }

  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit.status !== "complete") {
      continue;
    }

    const variant =
      edit.variants.find((item) => item.id === edit.activeVariantId) ??
      edit.variants[0];
    if (variant?.status === "complete" && variant.rawStream === message.rawStream) {
      return edit.id;
    }
  }

  return undefined;
}

function getActiveArtifactEditChain(message: ClientMessage): ArtifactEdit[] {
  return getArtifactEditChain(
    message.artifactEdits ?? [],
    getResolvedArtifactEditId(message)
  );
}

function getArtifactVersionInfo(
  message: ClientMessage
): ArtifactVersionInfo | undefined {
  const activeEditId = getResolvedArtifactEditId(message) ?? null;
  const hasOriginal = Boolean(
    (message.artifactEditBaseRawStream ?? message.rawStream)?.trim()
  );
  const edits = message.artifactEdits ?? [];
  const versions: Array<{ editId: string | null }> = hasOriginal
    ? [{ editId: null }]
    : [];

  for (const edit of edits) {
    if (
      hasUsableArtifactEditVariant(edit) ||
      hasPendingArtifactEditVariant(edit) ||
      shouldKeepFailedArtifactEditVersion(edit) ||
      edit.id === activeEditId
    ) {
      versions.push({ editId: edit.id });
    }
  }

  if (versions.length <= 1) {
    return undefined;
  }

  const activeIndex = versions.findIndex(
    (version) => version.editId === activeEditId
  );
  const resolvedActiveIndex = activeIndex >= 0 ? activeIndex : 0;
  const isVersionSwitchDisabled =
    message.status === "streaming" || edits.some(hasPendingArtifactEditVariant);

  return {
    activeIndex: resolvedActiveIndex,
    total: versions.length,
    previousEditId: isVersionSwitchDisabled
      ? undefined
      : versions[resolvedActiveIndex - 1]?.editId,
    nextEditId: isVersionSwitchDisabled
      ? undefined
      : versions[resolvedActiveIndex + 1]?.editId,
    disabled: isVersionSwitchDisabled
  };
}

function getPendingArtifactEditReferences(
  message: ClientMessage
): ArtifactEditReference[] {
  const seen = new Set<string>();
  const references: ArtifactEditReference[] = [];

  for (const edit of message.artifactEdits ?? []) {
    if (edit.status !== "pending") {
      continue;
    }

    for (const reference of edit.references) {
      const key = `${reference.kind}:${reference.selector}:${reference.key}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      references.push(reference);
    }
  }

  return references;
}

function normalizeArtifactEditResponse(input: unknown): ArtifactEditResponse {
  if (!input || typeof input !== "object") {
    throw new Error("The artifact edit response was empty.");
  }

  const response = input as Partial<ArtifactEditResponse>;
  if (typeof response.rawStream !== "string" || !response.rawStream.trim()) {
    throw new Error("The artifact edit did not return updated source.");
  }

  return {
    rawStream: response.rawStream,
    summary:
      typeof response.summary === "string" && response.summary.trim()
        ? response.summary.trim().slice(0, 500)
        : undefined,
    edits: Array.isArray(response.edits) ? response.edits : undefined
  };
}

function didArtifactEditChangeSource(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}

function buildArtifactActionMessage(action: StreamUiAction): string {
  return action.type === "prompt" ? action.prompt.trim().slice(0, 2000) : "";
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

function findSessionIdForMessage(
  state: SessionState,
  messageId: string
): string | undefined {
  for (const session of state.sessions) {
    if (session.messages.some((candidate) => candidate.id === messageId)) {
      return session.id;
    }
  }

  return undefined;
}

function getMessageBranchGroup(message: ClientMessage): string | undefined {
  return message.branchGroupId && message.branchVariantId
    ? message.branchGroupId
    : undefined;
}

function getBranchVariantOrder(
  messages: ClientMessage[],
  groupId: string,
  options: { anchorsOnly?: boolean } = {}
): string[] {
  const seen = new Set<string>();
  const variants: string[] = [];

  for (const message of messages) {
    if (
      message.branchGroupId !== groupId ||
      !message.branchVariantId ||
      (options.anchorsOnly && !(message.role === "assistant" && message.branchAnchor))
    ) {
      continue;
    }

    if (!seen.has(message.branchVariantId)) {
      seen.add(message.branchVariantId);
      variants.push(message.branchVariantId);
    }
  }

  return variants;
}

function getBranchTurnInsertionIndex(
  messages: ClientMessage[],
  groupId: string,
  branchStartId: string,
  branchAnchorId?: string
): number {
  const firstBranchIndex = messages.findIndex(
    (message) => message.branchGroupId === groupId
  );
  if (firstBranchIndex >= 0) {
    let index = firstBranchIndex;
    while (index < messages.length && messages[index].branchGroupId === groupId) {
      index += 1;
    }
    return index;
  }

  const anchorIndex = branchAnchorId
    ? messages.findIndex((message) => message.id === branchAnchorId)
    : -1;
  if (anchorIndex >= 0) {
    return anchorIndex + 1;
  }

  const startIndex = messages.findIndex((message) => message.id === branchStartId);
  return startIndex >= 0 ? startIndex + 1 : messages.length;
}

function getSelectedBranchVariant(
  session: ChatSession,
  groupId: string
): string | undefined {
  const variants = getBranchVariantOrder(session.messages, groupId);
  if (!variants.length) {
    return undefined;
  }

  const selected = session.branchSelections?.[groupId];
  return selected && variants.includes(selected) ? selected : variants[0];
}

function isMessageVisibleInSession(
  session: ChatSession,
  message: ClientMessage
): boolean {
  const groupId = getMessageBranchGroup(message);
  if (!groupId || !message.branchVariantId) {
    return true;
  }

  return getSelectedBranchVariant(session, groupId) === message.branchVariantId;
}

function getVisibleSessionMessages(session: ChatSession | undefined): ClientMessage[] {
  if (!session) {
    return initialMessages;
  }

  return session.messages.filter((message) =>
    isMessageVisibleInSession(session, message)
  );
}

function getAssistantForUserTurn(
  messages: ClientMessage[],
  userIndex: number
): ClientMessage | undefined {
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      return undefined;
    }
    if (message.role === "assistant") {
      return message;
    }
  }

  return undefined;
}

function getAssistantBranchInfo(
  session: ChatSession | undefined,
  messageId: string
): MessageBranchInfo | undefined {
  if (!session) {
    return undefined;
  }

  const message = session.messages.find((candidate) => candidate.id === messageId);
  if (
    !message ||
    message.role !== "assistant" ||
    !message.branchAnchor ||
    !message.branchGroupId ||
    !message.branchVariantId ||
    !isMessageVisibleInSession(session, message)
  ) {
    return undefined;
  }

  const variants = getBranchVariantOrder(session.messages, message.branchGroupId, {
    anchorsOnly: true
  });
  if (variants.length <= 1) {
    return undefined;
  }

  const activeIndex = variants.indexOf(message.branchVariantId);
  if (activeIndex < 0) {
    return undefined;
  }

  return {
    groupId: message.branchGroupId,
    activeIndex,
    total: variants.length,
    previousVariantId: variants[activeIndex - 1],
    nextVariantId: variants[activeIndex + 1]
  };
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
  getBranchInfo(messageId: string): MessageBranchInfo | undefined;
  themeMode: ThemeMode;
  showRawStream: boolean;
  model: string;
  modelOptions: string[];
  reasoningEffort: ReasoningEffort;
  uiComplexity: number;
  artifactSelectionClearVersion: number;
  onRuntimeError(id: string, error: RenderError): void;
  onArtifactAction(id: string, action: StreamUiAction): void;
  onVisualRepairAssistant(id: string, snapshot: RenderSnapshot, width: number): void;
  onRegenerateAssistant(id: string): void;
  onEditUserMessage(id: string, content: string): void;
  onSelectBranch(groupId: string, variantId: string): void;
  onSelectArtifactEdit(assistantId: string, editId?: string): void;
  onEditArtifactEditPrompt(
    assistantId: string,
    editId: string,
    prompt: string
  ): boolean;
  onArtifactSelectionsChange(selections: ArtifactSelection[]): void;
  onModelChange(model: string): void;
  onReasoningEffortChange(reasoningEffort: ReasoningEffort): void;
  onUiComplexityChange(uiComplexity: number): void;
};

const SESSION_OUTPUT_SCROLL_SETTLE_MS = 900;
const SESSION_OUTPUT_SCROLL_RETRY_MS = [0, 80, 240, 520];
const AUTO_SCROLL_BOTTOM_THRESHOLD = 160;
const THINKING_ACTIVITY_ANIMATION_MS = 220;

function ThinkingActivityPanel({
  message,
  isClosing,
  onClose
}: {
  message: ClientMessage;
  isClosing?: boolean;
  onClose(): void;
}) {
  const reasoning = stripSyntheticReasoningStatus(message.reasoning ?? "").trim();
  const isStreaming = message.status === "streaming";

  return (
    <aside
      className={`thinking-activity-panel ${isClosing ? "is-closing" : ""}`}
      aria-labelledby="thinking-activity-title"
    >
      <header className="thinking-activity-header">
        <h2 id="thinking-activity-title">Activity</h2>
        <span className="thinking-activity-header-status">
          {isStreaming ? "Thinking" : "Complete"}
        </span>
        <button
          className="thinking-activity-close"
          type="button"
          aria-label="Close activity"
          onClick={onClose}
        >
          <X size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>
      <div className="thinking-activity-body">
        <section className="thinking-activity-section">
          <h3>Thinking</h3>
          <div className="thinking-activity-step">
            {isStreaming ? (
              <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
            )}
            <div>
              <strong>{isStreaming ? "Thinking" : "Thought"}</strong>
              <span>{isStreaming ? "In progress" : "Complete"}</span>
            </div>
          </div>
          {reasoning ? (
            <pre className="thinking-activity-text">{reasoning}</pre>
          ) : null}
        </section>
      </div>
    </aside>
  );
}

function isNearScrollBottom(viewport: HTMLElement): boolean {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    AUTO_SCROLL_BOTTOM_THRESHOLD
  );
}

function scrollToBottom(viewport: HTMLElement): void {
  viewport.scrollTo({
    top: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    behavior: "auto"
  });
}

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

function focusComposerInput(): void {
  window.setTimeout(() => {
    const input = document.querySelector<HTMLElement>(".chat-input-textarea");
    input?.focus({ preventScroll: true });
  }, 0);
}

function StreamThread({
  activeSessionId,
  messages,
  files,
  getBranchInfo,
  themeMode,
  showRawStream,
  model,
  modelOptions,
  reasoningEffort,
  uiComplexity,
  artifactSelectionClearVersion,
  onRuntimeError,
  onArtifactAction,
  onVisualRepairAssistant,
  onRegenerateAssistant,
  onEditUserMessage,
  onSelectBranch,
  onSelectArtifactEdit,
  onEditArtifactEditPrompt,
  onArtifactSelectionsChange,
  onModelChange,
  onReasoningEffortChange,
  onUiComplexityChange
}: StreamThreadProps) {
  const isNewChat = useAuiState((state) => state.thread.messages.length === 0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowBottomRef = useRef(true);
  const reasoningActivityCloseTimerRef = useRef<number | null>(null);
  const [composerFooterElement, setComposerFooterElement] =
    useState<HTMLDivElement | null>(null);
  const lastAutoScrollTargetRef = useRef<{
    count: number;
    lastMessageId: string;
  }>({ count: 0, lastMessageId: "" });
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  );
  const hasStreamingMessage = useMemo(
    () => messages.some((message) => message.status === "streaming"),
    [messages]
  );
  const fileById = useMemo(
    () => new Map(files.map((file) => [file.id, file])),
    [files]
  );
  const [artifactSelections, setArtifactSelections] = useState<
    ArtifactSelection[]
  >([]);
  const [selectionModeMessageId, setSelectionModeMessageId] = useState<
    string | null
  >(null);
  const [activeReasoningMessageId, setActiveReasoningMessageId] = useState<
    string | null
  >(null);
  const [isReasoningActivityClosing, setIsReasoningActivityClosing] =
    useState(false);
  const activeReasoningMessage = activeReasoningMessageId
    ? messageById.get(activeReasoningMessageId)
    : undefined;
  const showReasoningActivity =
    activeReasoningMessage?.role === "assistant" &&
    (activeReasoningMessage.status === "streaming" ||
      Boolean(
        stripSyntheticReasoningStatus(
          activeReasoningMessage.reasoning ?? ""
        ).trim()
      ));
  const isReasoningActivityOpen =
    Boolean(showReasoningActivity) && !isReasoningActivityClosing;
  const visibleMessageIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages]
  );
  const selectionsByMessageId = useMemo(() => {
    const grouped = new Map<string, ArtifactSelection[]>();
    for (const selection of artifactSelections) {
      const group = grouped.get(selection.messageId) ?? [];
      group.push(selection);
      grouped.set(selection.messageId, group);
    }
    return grouped;
  }, [artifactSelections]);
  const artifactEditTimelineByUserId = useMemo(() => {
    const byUserId = new Map<
      string,
      {
        assistantId: string;
        edits: ArtifactEdit[];
        activeEditId?: string;
        disabled?: boolean;
      }
    >();

    for (let index = 0; index < messages.length; index += 1) {
      const assistant = messages[index];
      if (
        assistant.role !== "assistant" ||
        !assistant.artifactEdits?.length
      ) {
        continue;
      }

      const activeEditId = getResolvedArtifactEditId(assistant);
      const timeline = {
        assistantId: assistant.id,
        edits: getActiveArtifactEditChain(assistant).filter(
          shouldShowArtifactEditPromptBubble
        ),
        activeEditId,
        disabled:
          assistant.status === "streaming" ||
          assistant.artifactEdits.some(hasPendingArtifactEditVariant)
      };

      for (let userIndex = index - 1; userIndex >= 0; userIndex -= 1) {
        const user = messages[userIndex];
        if (user.role !== "user") {
          continue;
        }

        byUserId.set(user.id, timeline);
        break;
      }
    }

    return byUserId;
  }, [messages]);

  const clearReasoningActivityCloseTimer = useCallback(() => {
    if (reasoningActivityCloseTimerRef.current !== null) {
      window.clearTimeout(reasoningActivityCloseTimerRef.current);
      reasoningActivityCloseTimerRef.current = null;
    }
  }, []);

  const openReasoningActivity = useCallback(
    (messageId: string) => {
      clearReasoningActivityCloseTimer();
      setActiveReasoningMessageId(messageId);
      setIsReasoningActivityClosing(false);
    },
    [clearReasoningActivityCloseTimer]
  );

  const closeReasoningActivity = useCallback(() => {
    if (!activeReasoningMessageId) {
      return;
    }

    clearReasoningActivityCloseTimer();
    setIsReasoningActivityClosing(true);
    reasoningActivityCloseTimerRef.current = window.setTimeout(() => {
      setActiveReasoningMessageId(null);
      setIsReasoningActivityClosing(false);
      reasoningActivityCloseTimerRef.current = null;
    }, THINKING_ACTIVITY_ANIMATION_MS);
  }, [activeReasoningMessageId, clearReasoningActivityCloseTimer]);

  useEffect(() => {
    return clearReasoningActivityCloseTimer;
  }, [clearReasoningActivityCloseTimer]);

  useEffect(() => {
    setArtifactSelections([]);
    setSelectionModeMessageId(null);
    clearReasoningActivityCloseTimer();
    setActiveReasoningMessageId(null);
    setIsReasoningActivityClosing(false);
  }, [activeSessionId, clearReasoningActivityCloseTimer]);

  useEffect(() => {
    setArtifactSelections((current) => {
      const next = current.filter((selection) =>
        visibleMessageIds.has(selection.messageId)
      );
      return next.length === current.length ? current : next;
    });
    setSelectionModeMessageId((current) => {
      if (!current || !visibleMessageIds.has(current)) {
        return null;
      }

      const activeMessage = messages.find((message) => message.id === current);
      return activeMessage?.role === "assistant" &&
        activeMessage.status === "complete"
        ? current
        : null;
    });
    setActiveReasoningMessageId((current) => {
      if (!current || !visibleMessageIds.has(current)) {
        if (current) {
          clearReasoningActivityCloseTimer();
          setIsReasoningActivityClosing(false);
        }
        return null;
      }

      const activeMessage = messages.find((message) => message.id === current);
      const canShow = Boolean(
        activeMessage?.role === "assistant" &&
        (activeMessage.status === "streaming" ||
          stripSyntheticReasoningStatus(activeMessage.reasoning ?? "").trim())
      );
      if (!canShow) {
        clearReasoningActivityCloseTimer();
        setIsReasoningActivityClosing(false);
        return null;
      }
      return current;
    });
  }, [clearReasoningActivityCloseTimer, messages, visibleMessageIds]);

  const addArtifactSelection = useCallback(
    (messageId: string, selection: ArtifactSelectionPayload) => {
      setArtifactSelections((current) => {
        const nextSelection: ArtifactSelection = {
          ...selection,
          id: createId("artifact-selection"),
          messageId,
          createdAt: Date.now()
        };
        const next = current
          .filter(
            (item) => item.messageId === messageId && item.key !== selection.key
          )
          .concat(nextSelection);

        return next.slice(Math.max(0, next.length - MAX_ARTIFACT_SELECTIONS));
      });
      focusComposerInput();
    },
    []
  );

  const handleArtifactSelection = useCallback(
    (messageId: string, selection: ArtifactSelectionPayload) => {
      addArtifactSelection(messageId, selection);
    },
    [addArtifactSelection]
  );

  const handleArtifactSelectionModeChange = useCallback(
    (messageId: string, enabled: boolean) => {
      setSelectionModeMessageId((current) =>
        enabled
          ? current === messageId
            ? null
            : messageId
          : current === messageId
            ? null
            : current
      );
    },
    []
  );

  const handleRemoveArtifactSelection = useCallback((id: string) => {
    setArtifactSelections((current) =>
      current.filter((selection) => selection.id !== id)
    );
  }, []);

  const handleClearArtifactSelections = useCallback(() => {
    setArtifactSelections([]);
  }, []);

  useEffect(() => {
    onArtifactSelectionsChange(artifactSelections);
  }, [artifactSelections, onArtifactSelectionsChange]);

  useEffect(() => {
    if (artifactSelectionClearVersion <= 0) {
      return;
    }

    setArtifactSelections([]);
    setSelectionModeMessageId(null);
  }, [artifactSelectionClearVersion]);

  useEffect(() => {
    if (!selectionModeMessageId) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectionModeMessageId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [selectionModeMessageId]);

  useEffect(() => {
    if (!selectionModeMessageId) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".artifact-select-action")
      ) {
        return;
      }

      if (
        event.target instanceof HTMLIFrameElement &&
        event.target.classList.contains("preview-frame")
      ) {
        return;
      }

      setSelectionModeMessageId(null);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [selectionModeMessageId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const footer = composerFooterElement;

    if (!viewport || !footer) {
      return undefined;
    }

    const updateComposerFooterHeight = () => {
      viewport.style.setProperty(
        "--composer-footer-height",
        `${Math.ceil(footer.getBoundingClientRect().height)}px`
      );
    };

    updateComposerFooterHeight();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateComposerFooterHeight);
    resizeObserver?.observe(footer);
    window.addEventListener("resize", updateComposerFooterHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateComposerFooterHeight);
      viewport.style.removeProperty("--composer-footer-height");
    };
  }, [composerFooterElement]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport || !hasStreamingMessage) {
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
  }, [activeSessionId, hasStreamingMessage]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return undefined;
    }

    const handleScroll = () => {
      shouldFollowBottomRef.current = isNearScrollBottom(viewport);
    };

    handleScroll();
    viewport.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
    };
  }, [activeSessionId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const lastMessage = messages[messages.length - 1];
    const isNewMessageTarget =
      lastAutoScrollTargetRef.current.count !== messages.length ||
      lastAutoScrollTargetRef.current.lastMessageId !== (lastMessage?.id ?? "");
    lastAutoScrollTargetRef.current = {
      count: messages.length,
      lastMessageId: lastMessage?.id ?? ""
    };

    if (
      !viewport ||
      !shouldFollowBottomRef.current ||
      !hasStreamingMessage ||
      !isNewMessageTarget
    ) {
      return undefined;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      if (shouldFollowBottomRef.current) {
        scrollToBottom(viewport);
      }
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [activeSessionId, messages]);

  return (
    <ThreadPrimitive.Root
      className={`thread-root ${isNewChat ? "is-new" : "has-messages"} ${
        showReasoningActivity ? "has-thinking-activity" : ""
      } ${
        isReasoningActivityOpen ? "is-thinking-activity-open" : ""
      }`}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        className={`message-list ${isNewChat ? "is-new" : "has-messages"}`}
        autoScroll={false}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnThreadSwitch={false}
      >
        <AuiIf condition={(state) => state.thread.messages.length === 0}>
          <section className="thread-welcome">
            <p>ChatHTML Runtime</p>
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
              const branchInfo = getBranchInfo(clientMessage.id);
              const artifactVersionInfo =
                getArtifactVersionInfo(clientMessage);
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
                  showRawStream={showRawStream}
                  status={clientMessage.status}
                  error={clientMessage.error}
                  artifactSelections={
                    selectionsByMessageId.get(clientMessage.id) ?? []
                  }
                  artifactBusySelections={
                    getPendingArtifactEditReferences(clientMessage)
                  }
                  isArtifactSelectionModeActive={
                    selectionModeMessageId === clientMessage.id
                  }
                  branchInfo={branchInfo}
                  artifactVersionInfo={artifactVersionInfo}
                  activeReasoningMessageId={activeReasoningMessageId ?? undefined}
                  onRuntimeError={onRuntimeError}
                  onArtifactAction={onArtifactAction}
                  onArtifactSelection={handleArtifactSelection}
                  onArtifactSelectionModeChange={
                    handleArtifactSelectionModeChange
                  }
                  onOpenReasoningActivity={openReasoningActivity}
                  onVisualRepair={onVisualRepairAssistant}
                  onRegenerate={onRegenerateAssistant}
                  onSelectBranch={onSelectBranch}
                  onSelectArtifactEdit={onSelectArtifactEdit}
                />
              );
            }

            return (
              <ChatMessage
                id={clientMessage.id}
                role={clientMessage.role}
                files={clientMessage.fileIds
                  ?.map((fileId) => fileById.get(fileId))
                  .filter((file): file is SessionFile => Boolean(file))}
                artifactEditTimeline={artifactEditTimelineByUserId.get(
                  clientMessage.id
                )}
                onEdit={onEditUserMessage}
                onEditArtifactEditPrompt={onEditArtifactEditPrompt}
              >
                {clientMessage.content}
              </ChatMessage>
            );
          }}
        </ThreadPrimitive.Messages>
        <ThreadPrimitive.ViewportFooter
          ref={setComposerFooterElement}
          className={`composer-footer ${isNewChat ? "is-new" : "has-messages"}`}
        >
          <ChatInput
            model={model}
            modelOptions={modelOptions}
            reasoningEffort={reasoningEffort}
            uiComplexity={uiComplexity}
            artifactSelections={artifactSelections}
            onRemoveArtifactSelection={handleRemoveArtifactSelection}
            onClearArtifactSelections={handleClearArtifactSelections}
            onModelChange={onModelChange}
            onReasoningEffortChange={onReasoningEffortChange}
            onUiComplexityChange={onUiComplexityChange}
          />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      {showReasoningActivity && activeReasoningMessage ? (
        <ThinkingActivityPanel
          message={activeReasoningMessage}
          isClosing={isReasoningActivityClosing}
          onClose={closeReasoningActivity}
        />
      ) : null}
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
  const [displaySettings, setDisplaySettings] =
    useState<DisplaySettings>(loadDisplaySettings);
  const [sessionListPreview, setSessionListPreview] =
    useState<SessionListPreview | null>(loadCachedSessionListPreview);
  const [runtimeSettings, setRuntimeSettings] =
    useState<RuntimeSettingsSummary | null>(null);
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
  const cloudEnabled = Boolean(runtimeSettings?.cloud?.enabled);
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
  const saveAbortRef = useRef<AbortController | null>(null);
  const lastSavedSessionPayloadRef = useRef<string | null>(null);
  const lastSessionListPreviewPayloadRef = useRef<string | null>(
    sessionListPreview ? JSON.stringify(sessionListPreview) : null
  );
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
        setApiSettings((current) =>
          !hadSavedApiSettings
            ? normalizeApiSettings(settings.api.defaults)
            : coerceApiSettingsForRuntime(current, settings)
        );
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Could not load ChatHTML runtime settings.", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    saveApiSettings(apiSettings);
  }, [apiSettings]);

  useEffect(() => {
    saveSearchSettings(searchSettings);
  }, [searchSettings]);

  useEffect(() => {
    saveDisplaySettings(displaySettings);
  }, [displaySettings]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let cancelled = false;

    fetch("/api/sessions/index", {
      headers: sessionRequestHeaders(sessionClientIdRef.current)
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Session index load failed with HTTP ${response.status}.`);
        }
        return response.json() as Promise<unknown>;
      })
      .then((data) => {
        if (cancelled) {
          return;
        }

        const preview = normalizeSessionListPreview(data);
        lastSessionListPreviewPayloadRef.current = preview
          ? JSON.stringify(preview)
          : null;
        setSessionListPreview(preview);
        saveCachedSessionListPreview(preview);
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Could not load ChatHTML session index.", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
          const serverState = normalizeStoredSessionState(data, Date.now(), {
            rebuildSnapshots: false,
            interruptPendingArtifactEdits: true
          });
          const legacyState = loadLegacyLocalSessionState();
          const loadedState =
            !hasPersistedMessages(serverState) &&
            legacyState &&
            hasPersistedMessages(legacyState)
              ? legacyState
              : serverState;

          setSessionStateAndRef((current) => {
            const deletedSessionIds = Array.from(deletedSessionIdsRef.current);
            const filteredLoadedState = filterDeletedSessionState(
              loadedState,
              deletedSessionIds,
              current
            );
            const transientId = transientEmptySessionIdRef.current;
            const active = current.sessions.find(
              (session) => session.id === current.activeSessionId
            );

            return transientId &&
              active?.id === transientId &&
              isSessionEmpty(active)
              ? mergeSyncedSessionState(
                  current,
                  filteredLoadedState,
                  deletedSessionIds
                )
              : filteredLoadedState;
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Could not load ChatHTML sessions.", error);
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
      if (
        runConnectionsRef.current.size > 0 ||
        cancelledRunIdsRef.current.size > 0
      ) {
        return;
      }

      const currentState = sessionStateRef.current;
      const active = currentState.sessions.find(
        (session) => session.id === currentState.activeSessionId
      );
      if (
        active?.id === transientEmptySessionIdRef.current &&
        isSessionEmpty(active)
      ) {
        return;
      }

      try {
        const response = await fetch("/api/sessions", {
          headers: sessionRequestHeaders(sessionClientIdRef.current)
        });
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
        if (cancelled) {
          return;
        }

        setSessionStateAndRef((current) => {
          const deletedSessionIds = Array.from(deletedSessionIdsRef.current);
          const next = mergeSyncedSessionState(
            current,
            serverState,
            deletedSessionIds
          );
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
          console.warn("Could not sync ChatHTML sessions.", error);
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
    if (serializedState === lastSavedSessionPayloadRef.current) {
      return undefined;
    }

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
            console.warn("Could not save ChatHTML sessions.", error);
          }
        });
    }, 350);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sessionState, sessionsLoaded]);

  const saveCurrentSessionStateNow = useCallback(() => {
    if (typeof window === "undefined" || !sessionsLoadedRef.current) {
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

    void saveSerializedSessionState(
      serializedState,
      sessionClientIdRef.current
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Session save failed with HTTP ${response.status}.`);
        }

        lastSavedSessionPayloadRef.current = serializedState;
        clearLegacyLocalSessions();
      })
      .catch((error) => {
        console.warn("Could not save ChatHTML sessions.", error);
      });
  }, []);

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
      fetch(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: sessionRequestHeaders(sessionClientIdRef.current)
      }).catch((error) => {
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

  const handleApiSettingsChange = useCallback((next: ApiSettings) => {
    setApiSettings(normalizeApiSettings(next));
  }, []);

  const handleSearchSettingsChange = useCallback((next: SearchSettings) => {
    setSearchSettings(normalizeSearchSettings(next));
  }, []);

  const handleDisplaySettingsChange = useCallback((next: DisplaySettings) => {
    setDisplaySettings(normalizeDisplaySettings(next));
  }, []);

  const handleModelChange = useCallback((model: string) => {
    const nextModel = model.trim();
    if (!nextModel) {
      return;
    }

    setApiSettings((current) =>
      normalizeApiSettings({
        ...current,
        model: nextModel
      })
    );
    updateActiveSession((session) => ({
      ...session,
      model: nextModel
    }));
  }, [updateActiveSession]);

  const handleReasoningEffortChange = useCallback(
    (reasoningEffort: ReasoningEffort) => {
      setApiSettings((current) =>
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
    [updateActiveSession]
  );

  const handleUiComplexityChange = useCallback(
    (uiComplexity: number) => {
      const normalizedUiComplexity = normalizeUiComplexity(uiComplexity);
      setApiSettings((current) =>
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
    [updateActiveSession]
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
        updateAssistantForPhase(
          serverMessage,
          terminalStatus ?? "streaming"
        );

        if (terminalStatus) {
          doneStatus = terminalStatus;
          doneError = sanitizeChatErrorMessage(serverMessage.error, "");
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
            doneStatus =
              event.status === "error" && !isChatCancelledMessage(event.error)
                ? "error"
                : "complete";
            doneError = sanitizeChatErrorMessage(event.error, "");
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
          })
        });

        if (!response.ok || !response.body) {
          const errorText = await response.text();
          throw new Error(formatChatHttpError(response, errorText));
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
        const response = await fetch("/api/artifact-edits", {
          method: "POST",
          headers: sessionRequestHeaders(
            sessionClientIdRef.current,
            "application/json"
          ),
          signal: controller.signal,
          body: JSON.stringify({
            source,
            prompt,
            references: edit.references,
            apiSettings: serializeApiSettings(requestApiSettings)
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(formatChatHttpError(response, errorText));
        }

        const result = normalizeArtifactEditResponse(await response.json());
        if (!didArtifactEditChangeSource(source, result.rawStream)) {
          throw new Error(
            "The artifact edit did not change the source. Try a more specific prompt or select a larger reference."
          );
        }
        const patch = buildCompletedAssistantPatchFromRawStream(
          result.rawStream,
          themeMode
        );
        const editCount = result.edits?.length;

        updateAssistantMessage(assistantId, (message) => ({
          ...message,
          ...patch,
          artifactEditBaseRawStream:
            message.artifactEditBaseRawStream ?? assistant.artifactEditBaseRawStream ?? source,
          artifactEdits: (message.artifactEdits ?? []).map((item) =>
            item.id === nextEditId
              ? {
                  ...item,
                  status: "complete",
                  error: undefined,
                  activeVariantId: variantId,
                  variants: item.variants.map((variant) =>
                    variant.id === variantId
                      ? {
                          ...variant,
                          status: "complete",
                          rawStream: result.rawStream,
                          summary: result.summary,
                          error: undefined,
                          editCount
                        }
                      : variant
                  )
                }
              : item
          ),
          activeArtifactEditId: nextEditId
        }));
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
        updateAssistantMessage(assistantId, (message) => ({
          ...message,
          artifactEdits: (message.artifactEdits ?? []).map((item) => {
            if (item.id !== nextEditId) {
              return item;
            }

            return {
              ...item,
              status: "error",
              error: errorMessage,
              variants: item.variants.map((variant) =>
                variant.id === variantId
                  ? {
                      ...variant,
                      status: "error",
                      error: errorMessage
                    }
                  : variant
              )
            };
          }),
          activeArtifactEditId: nextEditId
        }));
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
        updateAssistantMessage(assistantId, (message) => ({
          ...message,
          artifactEdits: (message.artifactEdits ?? []).map((edit) =>
            edit.id === editId
              ? {
                  ...edit,
                  status: "error",
                  error: errorMessage,
                  variants: edit.variants.map((variant) =>
                    variant.id === variantId
                      ? {
                          ...variant,
                          status: "error",
                          error: errorMessage
                        }
                      : variant
                  )
                }
              : edit
          ),
          activeArtifactEditId: editId
        }));
      };

      try {
        if (attachments.length > 0) {
          throw new Error(
            "Local artifact edits do not support attachments yet. Remove the attachment and try again."
          );
        }

        const response = await fetch("/api/artifact-edits", {
          method: "POST",
          headers: sessionRequestHeaders(
            sessionClientIdRef.current,
            "application/json"
          ),
          signal: controller.signal,
          body: JSON.stringify({
            source,
            prompt: trimmed,
            references,
            apiSettings: serializeApiSettings(requestApiSettings)
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(formatChatHttpError(response, errorText));
        }

        const result = normalizeArtifactEditResponse(await response.json());
        if (!didArtifactEditChangeSource(source, result.rawStream)) {
          throw new Error(
            "The artifact edit did not change the source. Try a more specific prompt or select a larger reference."
          );
        }
        const patch = buildCompletedAssistantPatchFromRawStream(
          result.rawStream,
          themeMode
        );
        const editCount = result.edits?.length;

        updateAssistantMessage(assistantId, (message) => ({
          ...message,
          ...patch,
          artifactEditBaseRawStream:
            message.artifactEditBaseRawStream ?? source,
          artifactEdits: (message.artifactEdits ?? []).map((edit) =>
            edit.id === editId
              ? {
                  ...edit,
                  status: "complete",
                  error: undefined,
                  activeVariantId: variantId,
                  variants: edit.variants.map((variant) =>
                    variant.id === variantId
                      ? {
                          ...variant,
                          status: "complete",
                          rawStream: result.rawStream,
                          summary: result.summary,
                          error: undefined,
                          editCount
                        }
                      : variant
                  )
                }
              : edit
          ),
          activeArtifactEditId: editId
        }));
      } catch (error) {
        if (isAbortError(error)) {
          updateAssistantMessage(assistantId, (message) => {
            const artifactEdits = (message.artifactEdits ?? []).filter(
              (edit) => edit.id !== editId
            );

            return {
              ...message,
              artifactEditBaseRawStream: artifactEdits.length
                ? message.artifactEditBaseRawStream
                : undefined,
              artifactEdits: artifactEdits.length ? artifactEdits : undefined,
              activeArtifactEditId:
                message.activeArtifactEditId === editId
                  ? previousEditId
                  : message.activeArtifactEditId
            };
          });
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
              doneError = sanitizeChatErrorMessage(serverMessage.error, "");
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
                doneStatus =
                  event.status === "error" && !isChatCancelledMessage(event.error)
                    ? "error"
                    : "complete";
                doneError = sanitizeChatErrorMessage(event.error, "");
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

  useEffect(() => {
    if (!sessionsLoaded) {
      return;
    }

    const preview = sessionListPreviewFromState(sessionState);
    const payload = preview ? JSON.stringify(preview) : null;
    if (payload === lastSessionListPreviewPayloadRef.current) {
      return;
    }

    lastSessionListPreviewPayloadRef.current = payload;
    setSessionListPreview(preview);
    saveCachedSessionListPreview(preview);
  }, [sessionState, sessionsLoaded]);

  return (
    <>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatShell
          themeMode={themeMode}
          sidebar={
            <SessionSidebar
              sessions={sidebarSessionItems}
              activeSessionId={sidebarActiveSessionId}
              isSending={isSending}
              themeMode={themeMode}
              apiSettings={apiSettings}
              searchSettings={searchSettings}
              displaySettings={displaySettings}
              runtimeSettings={runtimeSettings}
              cloudEnabled={cloudEnabled}
              authUser={authenticatedUser}
              onNewSession={handleNewSession}
              onSelectSession={handleSelectSession}
              onDeleteSession={handleDeleteSession}
              onThemeModeChange={setThemeMode}
              onApiSettingsChange={handleApiSettingsChange}
              onSearchSettingsChange={handleSearchSettingsChange}
              onDisplaySettingsChange={handleDisplaySettingsChange}
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
