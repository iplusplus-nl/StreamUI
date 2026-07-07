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
  compactEmptySessions,
  createEmptySession,
  createId,
  createInitialSessionState,
  filterDeletedSessionState,
  hasPersistedMessages,
  initialMessages,
  isSessionEmpty,
  mergeSyncedSessionState,
  normalizeStoredSession,
  normalizeStoredSessionState,
  serializeSessions,
  sortSessions,
  STREAM_INTERRUPTED_ERROR,
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

type SendStreamUiRequestOptions = {
  appendUserMessage?: boolean;
  assistantPatch?: Partial<ClientMessage>;
  userMessagePatch?: Partial<ClientMessage>;
  initialReasoning?: string;
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

type MessageBranchInfo = {
  groupId: string;
  activeIndex: number;
  total: number;
  previousVariantId?: string;
  nextVariantId?: string;
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
  onRuntimeError(id: string, error: RenderError): void;
  onArtifactAction(id: string, action: StreamUiAction): void;
  onRegenerateAssistant(id: string): void;
  onEditUserMessage(id: string, content: string): void;
  onSelectBranch(groupId: string, variantId: string): void;
  onModelChange(model: string): void;
  onReasoningEffortChange(reasoningEffort: ReasoningEffort): void;
};

const SESSION_OUTPUT_SCROLL_SETTLE_MS = 900;
const SESSION_OUTPUT_SCROLL_RETRY_MS = [0, 80, 240, 520];
const AUTO_SCROLL_BOTTOM_THRESHOLD = 160;

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
  onRuntimeError,
  onArtifactAction,
  onRegenerateAssistant,
  onEditUserMessage,
  onSelectBranch,
  onModelChange,
  onReasoningEffortChange
}: StreamThreadProps) {
  const isNewChat = useAuiState((state) => state.thread.messages.length === 0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowBottomRef = useRef(true);
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
      className={`thread-root ${isNewChat ? "is-new" : "has-messages"}`}
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
                  branchInfo={branchInfo}
                  onRuntimeError={onRuntimeError}
                  onArtifactAction={onArtifactAction}
                  onRegenerate={onRegenerateAssistant}
                  onSelectBranch={onSelectBranch}
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
                onEdit={onEditUserMessage}
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
  const [displaySettings, setDisplaySettings] =
    useState<DisplaySettings>(loadDisplaySettings);
  const [sessionListPreview, setSessionListPreview] =
    useState<SessionListPreview | null>(loadCachedSessionListPreview);
  const [runtimeSettings, setRuntimeSettings] =
    useState<RuntimeSettingsSummary | null>(null);
  const [authSummary, setAuthSummary] = useState<AuthSummary | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [isAuthOverlayOpen, setIsAuthOverlayOpen] = useState(false);
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
  const activeFiles = activeSession?.files ?? [];
  const activeSessionModel = activeSession?.model || apiSettings.model;
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
  const sessionsLoadedRef = useRef(sessionsLoaded);
  const saveAbortRef = useRef<AbortController | null>(null);
  const lastSavedSessionPayloadRef = useRef<string | null>(null);
  const lastSessionListPreviewPayloadRef = useRef<string | null>(
    sessionListPreview ? JSON.stringify(sessionListPreview) : null
  );
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());
  const runConnectionsRef = useRef<Map<string, AbortController>>(new Map());
  const cancelledRunIdsRef = useRef<Set<string>>(new Set());
  const pendingManagedRequestRef = useRef<PendingManagedRequest | null>(null);
  const pendingArtifactActionRef = useRef<PendingArtifactAction | null>(null);
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
            rebuildSnapshots: false
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
          { rebuildSnapshots: false }
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
    const entries = Array.from(runConnectionsRef.current.entries());
    if (!entries.length) {
      return;
    }

    const runIds = entries.map(([runId]) => runId);
    runIds.forEach((runId) => cancelledRunIdsRef.current.add(runId));

    const cancelRequests = runIds.map((runId) =>
      fetch(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: sessionRequestHeaders(sessionClientIdRef.current)
      }).catch((error) => {
        console.warn("Could not cancel ChatHTML run on the server.", error);
      })
    );

    entries.forEach(([, controller]) => controller.abort());
    markRunsCancelled(runIds);
    setIsSending(false);

    await Promise.allSettled(cancelRequests);
    window.setTimeout(() => {
      runIds.forEach((runId) => cancelledRunIdsRef.current.delete(runId));
    }, SESSION_SYNC_INTERVAL_MS);
  }, [markRunsCancelled]);

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

      const session = createEmptySession(undefined, undefined, apiSettings.model);
      transientEmptySessionIdRef.current = session.id;
      return {
        sessions: [session, ...compacted.sessions],
        activeSessionId: session.id
      };
    });
  }, [apiSettings.model, setSessionStateAndRef]);

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
        const session = createEmptySession(undefined, undefined, apiSettings.model);
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
  }, [apiSettings.model, saveCurrentSessionStateNow, setSessionStateAndRef]);

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
      const requestApiSettings = coerceApiSettingsForRuntime(
        normalizeApiSettings({
          ...apiSettings,
          model: requestModel
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
      const assistantId = createId("assistant");
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
        updateAssistant(assistantId, serverMessage);

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
            { rebuildSnapshots: false }
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
            userMessage: appendUserMessage ? userMessage : undefined,
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
          updateAssistant(assistantId, {
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
          updateAssistant(
            assistantId,
            createCancelledAssistantPatch(raw, reasoning, lastStreamSequence)
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
      nextUserContent
    }: {
      session: ChatSession;
      visibleMessages: ClientMessage[];
      userIndex: number;
      assistantId?: string;
      nextUserContent: string;
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
        : visibleMessages
            .slice(userIndex + 1)
            .find((message) => message.role === "assistant");
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
      const historyBeforeUser = visibleMessages.slice(0, userIndex);

      void sendStreamUiRequest(nextUserContent, [], {
        targetSessionId: session.id,
        branchSelection: { groupId, variantId: nextVariantId },
        userMessagePatch: {
          fileIds: activeUser.fileIds,
          branchGroupId: groupId,
          branchVariantId: nextVariantId
        },
        assistantPatch: {
          branchGroupId: groupId,
          branchVariantId: nextVariantId,
          branchAnchor: true
        },
        requestHistory: (_previousMessages, userMessage) => [
          ...historyBeforeUser,
          userMessage
        ],
        insertMessages: (messages, userMessage, assistantMessage) => {
          if (!isNewGroup) {
            return [...messages, userMessage, assistantMessage];
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

          return [...annotatedMessages, userMessage, assistantMessage];
        }
      });
    },
    [sendStreamUiRequest]
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

      startBranchedTurn({
        session,
        visibleMessages,
        userIndex,
        assistantId,
        nextUserContent: visibleMessages[userIndex].content
      });
    },
    [startBranchedTurn]
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

      const activeAssistant = visibleMessages
        .slice(userIndex + 1)
        .find((message) => message.role === "assistant");
      startBranchedTurn({
        session,
        visibleMessages,
        userIndex,
        assistantId: activeAssistant?.id,
        nextUserContent
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
                { rebuildSnapshots: false }
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
            reasoningEffort={apiSettings.reasoningEffort}
            onRuntimeError={handleRuntimeError}
            onArtifactAction={handleArtifactAction}
            onRegenerateAssistant={handleRegenerateAssistant}
            onEditUserMessage={handleEditUserMessage}
            onSelectBranch={handleSelectBranch}
            onModelChange={handleModelChange}
            onReasoningEffortChange={handleReasoningEffortChange}
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
    </>
  );
}
