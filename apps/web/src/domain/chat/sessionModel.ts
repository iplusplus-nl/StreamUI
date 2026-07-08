import type { ImageAttachment } from "../../core/imageAttachments";
import {
  buildArtifactContext,
  type ArtifactContext
} from "../../core/artifactContext";
import { extractStreamUiParts } from "../../runtime/streamui/protocol";
import { createStreamingRenderer } from "../../runtime/streamui/streamingRenderer";
import type { RenderError, RenderSnapshot } from "../../runtime/streamui/types";
import { isIgnoredRuntimeError } from "../../core/ignoredRuntimeErrors";

export type ArtifactEditReference = {
  kind: "element" | "text";
  key: string;
  selector: string;
  label: string;
  preview: string;
  tagName?: string;
  text?: string;
  html?: string;
};

export type ArtifactEditVariant = {
  id: string;
  createdAt: number;
  status: "pending" | "complete" | "error";
  rawStream?: string;
  summary?: string;
  error?: string;
  editCount?: number;
};

export type ArtifactEdit = {
  id: string;
  parentId?: string;
  createdAt: number;
  prompt: string;
  references: ArtifactEditReference[];
  activeVariantId?: string;
  variants: ArtifactEditVariant[];
  status: "pending" | "complete" | "error";
  error?: string;
};

export type ClientMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ImageAttachment[];
  fileIds?: string[];
  reasoning?: string;
  sessionTitle?: string;
  rawStream?: string;
  hasStreamUi?: boolean;
  streamUiComplete?: boolean;
  artifactContext?: ArtifactContext;
  snapshot?: RenderSnapshot;
  runtimeErrors?: RenderError[];
  repairOfMessageId?: string;
  repairAttempt?: number;
  branchGroupId?: string;
  branchVariantId?: string;
  branchAnchor?: boolean;
  artifactEditBaseRawStream?: string;
  artifactEdits?: ArtifactEdit[];
  activeArtifactEditId?: string;
  generationRunId?: string;
  streamSequence?: number;
  status?: "streaming" | "complete" | "error";
  error?: string;
};

export type SessionFileKind = "image" | "artifact" | "text";

export type SessionFile = {
  id: string;
  kind: SessionFileKind;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  sourceMessageId?: string;
  storageKey?: string;
  contentHash?: string;
  accessToken?: string;
  embedUrl?: string;
  downloadUrl?: string;
  dataUrl?: string;
  text?: string;
  width?: number;
  height?: number;
  summary?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  branchSelections?: Record<string, string>;
  messages: ClientMessage[];
  files: SessionFile[];
};

export type SessionState = {
  sessions: ChatSession[];
  activeSessionId: string;
};

type NormalizeStoredSessionOptions = {
  rebuildSnapshots?: boolean;
};

export const initialMessages: ClientMessage[] = [];
export const UNTITLED_SESSION = "New Session";
export const STREAM_INTERRUPTED_ERROR =
  "The stream was interrupted before it completed.";

export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptySession(
  now = Date.now(),
  id = createId("session"),
  model?: string
): ChatSession {
  return {
    id,
    title: UNTITLED_SESSION,
    createdAt: now,
    updatedAt: now,
    model: model?.trim() || undefined,
    messages: initialMessages,
    files: []
  };
}

export function createInitialSessionState(
  now = Date.now(),
  id = createId("session"),
  model?: string
): SessionState {
  const session = createEmptySession(now, id, model);
  return { sessions: [session], activeSessionId: session.id };
}

export function isSessionEmpty(
  session: Pick<ChatSession, "messages" | "files">
): boolean {
  return session.messages.length === 0 && session.files.length === 0;
}

export function getSessionStreamingRunIds(
  session: Pick<ChatSession, "messages"> | undefined
): string[] {
  if (!session) {
    return [];
  }

  const runIds = new Set<string>();
  for (const message of session.messages) {
    if (
      message.role !== "assistant" ||
      message.status !== "streaming" ||
      !message.generationRunId
    ) {
      continue;
    }

    runIds.add(message.generationRunId);
  }

  return Array.from(runIds);
}

export function compactEmptySessions(
  state: SessionState,
  options: { preserveActiveEmpty?: boolean } = {}
): SessionState {
  const activeSession = state.sessions.find(
    (session) => session.id === state.activeSessionId
  );
  const nonEmptySessions = state.sessions.filter(
    (session) => !isSessionEmpty(session)
  );
  const preservedActiveEmpty =
    options.preserveActiveEmpty && activeSession && isSessionEmpty(activeSession)
      ? activeSession
      : null;

  if (!nonEmptySessions.length) {
    const fallback = activeSession ?? state.sessions[0];
    if (!fallback) {
      return createInitialSessionState();
    }

    return {
      sessions: [fallback],
      activeSessionId: fallback.id
    };
  }

  const sessionsById = new Map<string, ChatSession>();
  if (preservedActiveEmpty) {
    sessionsById.set(preservedActiveEmpty.id, preservedActiveEmpty);
  }
  for (const session of nonEmptySessions) {
    sessionsById.set(session.id, session);
  }

  const sessions = sortSessions(Array.from(sessionsById.values()));
  const activeSessionId = sessions.some(
    (session) => session.id === state.activeSessionId
  )
    ? state.activeSessionId
    : sessions[0].id;

  return {
    sessions,
    activeSessionId
  };
}

function normalizedDeletedSessionIdSet(
  deletedSessionIds: Iterable<string> = []
): Set<string> {
  const ids = new Set<string>();
  for (const id of deletedSessionIds) {
    const value = id.trim();
    if (value) {
      ids.add(value);
    }
  }
  return ids;
}

export function filterDeletedSessionState(
  state: SessionState,
  deletedSessionIds: Iterable<string> = [],
  fallbackState?: SessionState
): SessionState {
  const deleted = normalizedDeletedSessionIdSet(deletedSessionIds);
  if (!deleted.size) {
    return state;
  }

  const filterState = (candidate: SessionState): SessionState | null => {
    const sessions = candidate.sessions.filter(
      (session) => !deleted.has(session.id)
    );
    if (!sessions.length) {
      return null;
    }

    const activeSessionId = sessions.some(
      (session) => session.id === candidate.activeSessionId
    )
      ? candidate.activeSessionId
      : sessions[0].id;
    const activeSession = sessions.find(
      (session) => session.id === activeSessionId
    );

    return compactEmptySessions(
      {
        sessions,
        activeSessionId
      },
      { preserveActiveEmpty: Boolean(activeSession && isSessionEmpty(activeSession)) }
    );
  };

  const filtered = filterState(state);
  if (filtered) {
    return filtered;
  }

  if (fallbackState) {
    const fallback = filterState(fallbackState);
    if (fallback) {
      return fallback;
    }
  }

  return createInitialSessionState();
}

function latestStreamingAssistant(
  session: ChatSession | undefined
): ClientMessage | undefined {
  if (!session) {
    return undefined;
  }

  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === "assistant" && message.status === "streaming") {
      return message;
    }
  }

  return undefined;
}

function matchingServerMessage(
  serverSession: ChatSession | undefined,
  localMessage: ClientMessage
): ClientMessage | undefined {
  if (!serverSession) {
    return undefined;
  }

  return serverSession.messages.find(
    (message) =>
      message.id === localMessage.id ||
      (Boolean(localMessage.generationRunId) &&
        message.generationRunId === localMessage.generationRunId)
  );
}

function shouldPreserveLocalStreamingSession(
  currentSession: ChatSession | undefined,
  serverSession: ChatSession | undefined
): boolean {
  const localStreaming = latestStreamingAssistant(currentSession);
  if (!currentSession || !localStreaming) {
    return false;
  }

  const serverMessage = matchingServerMessage(serverSession, localStreaming);
  return serverMessage?.status !== "complete" && serverMessage?.status !== "error";
}

export function mergeSyncedSessionState(
  current: SessionState,
  serverState: SessionState,
  deletedSessionIds: Iterable<string> = []
): SessionState {
  current = filterDeletedSessionState(current, deletedSessionIds);
  serverState = filterDeletedSessionState(
    serverState,
    deletedSessionIds,
    current
  );

  const currentActive = current.sessions.find(
    (session) => session.id === current.activeSessionId
  );
  const serverActive = serverState.sessions.find(
    (session) => session.id === current.activeSessionId
  );

  if (
    currentActive &&
    shouldPreserveLocalStreamingSession(currentActive, serverActive)
  ) {
    const activeId = currentActive.id;
    return compactEmptySessions({
      sessions: sortSessions([
        currentActive,
        ...serverState.sessions.filter((session) => session.id !== activeId)
      ]),
      activeSessionId: activeId
    });
  }

  if (
    currentActive &&
    isSessionEmpty(currentActive) &&
    (!serverActive || isSessionEmpty(serverActive))
  ) {
    const activeId = currentActive.id;
    return compactEmptySessions(
      {
        sessions: [
          currentActive,
          ...serverState.sessions.filter(
            (session) => session.id !== activeId
          )
        ],
        activeSessionId: activeId
      },
      { preserveActiveEmpty: true }
    );
  }

  const activeSessionId = serverState.sessions.some(
    (session) => session.id === current.activeSessionId
  )
    ? current.activeSessionId
    : serverState.activeSessionId;

  return compactEmptySessions({
    ...serverState,
    activeSessionId
  });
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function stripLegacyArtifactActionPrefix(value: string): string {
  return value.replace(/^I clicked\s+"[^"\n]{1,200}"\.\s*/u, "").trim();
}

export function titleFromText(value: string): string {
  const compact = compactText(value);
  if (!compact) {
    return UNTITLED_SESSION;
  }

  const withoutProtocol = compact
    .replace(/\b(sessiontitle|chat|streamui)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence =
    withoutProtocol.split(/(?<=[.!?。！？])\s+/u)[0] ?? withoutProtocol;
  const words = firstSentence.split(/\s+/).filter(Boolean);
  const shortTitle =
    words.length > 7 ? words.slice(0, 7).join(" ") : firstSentence;

  if (shortTitle.length <= 58) {
    return shortTitle;
  }

  return `${shortTitle.slice(0, 57).trimEnd()}…`;
}

export function assistantMessageToSessionTitle(message: ClientMessage): string {
  if (message.role !== "assistant") {
    return "";
  }

  if (message.sessionTitle?.trim()) {
    return message.sessionTitle;
  }

  if (message.rawStream) {
    const parts = extractStreamUiParts(message.rawStream);
    if (parts.sessionTitleComplete && parts.sessionTitle.trim()) {
      return parts.sessionTitle;
    }
  }

  return "";
}

export function summarizeSession(messages: ClientMessage[]): string {
  const explicitTitle = messages
    .map(assistantMessageToSessionTitle)
    .find((text) => text.trim());
  if (explicitTitle) {
    return titleFromText(explicitTitle);
  }

  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return UNTITLED_SESSION;
  }

  if (firstUserMessage.content.trim()) {
    return titleFromText(firstUserMessage.content);
  }

  if (firstUserMessage.fileIds?.length || firstUserMessage.attachments?.length) {
    return "File conversation";
  }

  return UNTITLED_SESSION;
}

export function countUserPrompts(messages: ClientMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function renderErrorKey(error: Pick<RenderError, "kind" | "message">): string {
  return `${error.kind}:${error.message}`;
}

function normalizeRenderError(input: unknown): RenderError | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const error = input as Partial<RenderError>;
  const kind =
    error.kind === "html" ||
    error.kind === "runtime" ||
    error.kind === "security" ||
    error.kind === "console"
      ? error.kind
      : null;
  if (!kind || typeof error.message !== "string" || !error.message.trim()) {
    return null;
  }

  return {
    kind,
    message: error.message,
    ...(typeof error.filename === "string" && error.filename.trim()
      ? { filename: error.filename.trim().slice(0, 500) }
      : {}),
    timestamp:
      typeof error.timestamp === "number" && Number.isFinite(error.timestamp)
        ? error.timestamp
        : Date.now()
  };
}

function normalizeRenderErrors(input: unknown): RenderError[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const seen = new Set<string>();
  const errors: RenderError[] = [];

  for (const item of input) {
    const error = normalizeRenderError(item);
    if (!error || isIgnoredRuntimeError(error)) {
      continue;
    }

    const key = renderErrorKey(error);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    errors.push(error);
  }

  return errors.length ? errors : undefined;
}

function normalizeArtifactContext(input: unknown): ArtifactContext | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const context = input as Partial<ArtifactContext>;
  if (
    typeof context.id !== "string" ||
    !context.id.trim() ||
    typeof context.sourceHash !== "string" ||
    !context.sourceHash.trim()
  ) {
    return undefined;
  }

  return {
    id: context.id,
    sourceHash: context.sourceHash,
    sourceChars:
      typeof context.sourceChars === "number" && Number.isFinite(context.sourceChars)
        ? Math.max(0, Math.round(context.sourceChars))
        : 0,
    textSummary:
      typeof context.textSummary === "string" ? context.textSummary : "",
    styleSummary:
      typeof context.styleSummary === "string" ? context.styleSummary : "",
    structureSummary:
      typeof context.structureSummary === "string"
        ? context.structureSummary
        : "",
    editableSummary:
      typeof context.editableSummary === "string"
        ? context.editableSummary
        : ""
  };
}

function normalizeBoundedString(
  input: unknown,
  maxLength: number
): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const value = input.trim().slice(0, maxLength);
  return value || undefined;
}

function normalizeArtifactEditReference(
  input: unknown
): ArtifactEditReference | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const reference = input as Partial<ArtifactEditReference>;
  const kind =
    reference.kind === "element" || reference.kind === "text"
      ? reference.kind
      : null;
  const key = normalizeBoundedString(reference.key, 240);
  const selector = normalizeBoundedString(reference.selector, 500);
  if (!kind || !key || !selector) {
    return null;
  }

  return {
    kind,
    key,
    selector,
    label: normalizeBoundedString(reference.label, 160) ?? "Reference",
    preview: normalizeBoundedString(reference.preview, 500) ?? "",
    tagName: normalizeBoundedString(reference.tagName, 80),
    text: normalizeBoundedString(reference.text, 2_000),
    html: normalizeBoundedString(reference.html, 8_000)
  };
}

function normalizeArtifactEditReferences(
  input: unknown
): ArtifactEditReference[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const references: ArtifactEditReference[] = [];
  for (const item of input) {
    const reference = normalizeArtifactEditReference(item);
    if (!reference || seen.has(reference.key)) {
      continue;
    }
    seen.add(reference.key);
    references.push(reference);
    if (references.length >= 8) {
      break;
    }
  }

  return references;
}

function normalizeArtifactEditVariant(
  input: unknown,
  now = Date.now()
): ArtifactEditVariant | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const variant = input as Partial<ArtifactEditVariant>;
  const id = normalizeBoundedString(variant.id, 160);
  if (!id) {
    return null;
  }
  const status =
    variant.status === "pending" ||
    variant.status === "complete" ||
    variant.status === "error"
      ? variant.status
      : "complete";
  const restoredStatus = status === "pending" ? "error" : status;

  return {
    id,
    createdAt:
      typeof variant.createdAt === "number" && Number.isFinite(variant.createdAt)
        ? variant.createdAt
        : now,
    status: restoredStatus,
    rawStream:
      typeof variant.rawStream === "string" ? variant.rawStream : undefined,
    summary: normalizeBoundedString(variant.summary, 500),
    error:
      normalizeBoundedString(variant.error, 800) ??
      (status === "pending" ? "The local edit was interrupted." : undefined),
    editCount:
      typeof variant.editCount === "number" && Number.isFinite(variant.editCount)
        ? Math.max(0, Math.round(variant.editCount))
        : undefined
  };
}

function normalizeArtifactEdit(input: unknown, now = Date.now()): ArtifactEdit | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const edit = input as Partial<ArtifactEdit>;
  const id = normalizeBoundedString(edit.id, 160);
  const prompt = normalizeBoundedString(edit.prompt, 8_000);
  if (!id || !prompt) {
    return null;
  }
  const variants = Array.isArray(edit.variants)
    ? edit.variants
        .map((variant) => normalizeArtifactEditVariant(variant, now))
        .filter((variant): variant is ArtifactEditVariant => variant !== null)
    : [];
  const status =
    edit.status === "pending" || edit.status === "complete" || edit.status === "error"
      ? edit.status
      : variants.some((variant) => variant.status === "pending")
        ? "pending"
        : variants.some((variant) => variant.status === "error")
          ? "error"
          : "complete";
  const restoredStatus = status === "pending" ? "error" : status;
  const activeVariantId = normalizeBoundedString(edit.activeVariantId, 160);

  return {
    id,
    parentId: normalizeBoundedString(edit.parentId, 160),
    createdAt:
      typeof edit.createdAt === "number" && Number.isFinite(edit.createdAt)
        ? edit.createdAt
        : now,
    prompt,
    references: normalizeArtifactEditReferences(edit.references),
    activeVariantId:
      activeVariantId && variants.some((variant) => variant.id === activeVariantId)
        ? activeVariantId
        : variants[0]?.id,
    variants,
    status: restoredStatus,
    error:
      normalizeBoundedString(edit.error, 800) ??
      (status === "pending" ? "The local edit was interrupted." : undefined)
  };
}

function normalizeArtifactEdits(input: unknown): ArtifactEdit[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const now = Date.now();
  const seen = new Set<string>();
  const edits: ArtifactEdit[] = [];
  for (const item of input) {
    const edit = normalizeArtifactEdit(item, now);
    if (!edit || seen.has(edit.id)) {
      continue;
    }
    seen.add(edit.id);
    edits.push(edit);
  }

  return edits.length ? edits : undefined;
}

function normalizeStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }
    const value = item.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }

  return values.length ? values : undefined;
}

function normalizeBranchSelections(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const selections: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim().slice(0, 160);
    const value = typeof rawValue === "string" ? rawValue.trim().slice(0, 160) : "";
    if (key && value) {
      selections[key] = value;
    }
  }

  return Object.keys(selections).length ? selections : undefined;
}

function normalizeSessionFile(input: unknown, now = Date.now()): SessionFile | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const file = input as Partial<SessionFile>;
  const kind =
    file.kind === "image" || file.kind === "artifact" || file.kind === "text"
      ? file.kind
      : null;
  if (
    !kind ||
    typeof file.id !== "string" ||
    !file.id.trim() ||
    typeof file.name !== "string" ||
    !file.name.trim()
  ) {
    return null;
  }

  const dataUrl = typeof file.dataUrl === "string" ? file.dataUrl : undefined;
  const text = typeof file.text === "string" ? file.text : undefined;
  const storageKey =
    typeof file.storageKey === "string" && file.storageKey.trim()
      ? file.storageKey.trim()
      : undefined;
  if (kind === "image" && !dataUrl && !storageKey) {
    return null;
  }
  if ((kind === "artifact" || kind === "text") && !text && !storageKey) {
    return null;
  }

  return {
    id: file.id.trim(),
    kind,
    name: file.name.trim().slice(0, 180),
    mimeType:
      typeof file.mimeType === "string" && file.mimeType.trim()
        ? file.mimeType.trim().slice(0, 120)
        : kind === "image"
          ? "image/png"
          : "text/plain",
    size:
      typeof file.size === "number" && Number.isFinite(file.size)
        ? Math.max(0, Math.round(file.size))
        : text?.length ?? 0,
    createdAt:
      typeof file.createdAt === "number" && Number.isFinite(file.createdAt)
        ? file.createdAt
        : now,
    sourceMessageId:
      typeof file.sourceMessageId === "string" && file.sourceMessageId.trim()
        ? file.sourceMessageId.trim()
        : undefined,
    storageKey,
    contentHash:
      typeof file.contentHash === "string" && file.contentHash.trim()
        ? file.contentHash.trim()
        : undefined,
    accessToken:
      typeof file.accessToken === "string" && file.accessToken.trim()
        ? file.accessToken.trim()
        : undefined,
    embedUrl:
      typeof file.embedUrl === "string" && file.embedUrl.trim()
        ? file.embedUrl.trim()
        : undefined,
    downloadUrl:
      typeof file.downloadUrl === "string" && file.downloadUrl.trim()
        ? file.downloadUrl.trim()
        : undefined,
    dataUrl,
    text,
    width:
      typeof file.width === "number" && Number.isFinite(file.width)
        ? Math.max(1, Math.round(file.width))
        : undefined,
    height:
      typeof file.height === "number" && Number.isFinite(file.height)
        ? Math.max(1, Math.round(file.height))
        : undefined,
    summary: typeof file.summary === "string" ? file.summary.slice(0, 1_200) : undefined
  };
}

function normalizeSessionFiles(input: unknown, now = Date.now()): SessionFile[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const files: SessionFile[] = [];
  for (const item of input) {
    const file = normalizeSessionFile(item, now);
    if (!file || seen.has(file.id)) {
      continue;
    }
    seen.add(file.id);
    files.push(file);
  }

  return files;
}

function legacyAttachmentToSessionFile(
  attachment: ImageAttachment,
  messageId: string,
  now = Date.now()
): SessionFile | null {
  if (!attachment.dataUrl || !attachment.name || !attachment.id) {
    return null;
  }

  return normalizeSessionFile(
    {
      id: `file-${attachment.id}`,
      kind: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      createdAt: now,
      sourceMessageId: messageId,
      dataUrl: attachment.dataUrl,
      width: attachment.width,
      height: attachment.height,
      summary: `Uploaded image ${attachment.name}`
    },
    now
  );
}

function assistantArtifactToSessionFile(
  message: ClientMessage,
  now = Date.now()
): SessionFile | null {
  if (
    message.role !== "assistant" ||
    !message.rawStream ||
    (!message.hasStreamUi && !/<streamui\b/i.test(message.rawStream))
  ) {
    return null;
  }

  const context = message.artifactContext;
  return normalizeSessionFile(
    {
      id: `file-artifact-${message.id}`,
      kind: "artifact",
      name: `${message.id}.chathtml.html`,
      mimeType: "text/html",
      size: message.rawStream.length,
      createdAt: now,
      sourceMessageId: message.id,
      text: message.rawStream,
      summary: context?.textSummary || "ChatHTML artifact raw source"
    },
    now
  );
}

function migrateMessageFiles(
  messages: ClientMessage[],
  files: SessionFile[],
  now = Date.now()
): { messages: ClientMessage[]; files: SessionFile[] } {
  const fileMap = new Map(files.map((file) => [file.id, file]));

  const migratedMessages = messages.map((message) => {
    const fileIds = new Set(message.fileIds ?? []);

    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        const file = legacyAttachmentToSessionFile(attachment, message.id, now);
        if (!file) {
          continue;
        }
        fileMap.set(file.id, file);
        fileIds.add(file.id);
      }
    }

    const artifactFile = assistantArtifactToSessionFile(message, now);
    if (artifactFile) {
      fileMap.set(artifactFile.id, artifactFile);
    }

    const { attachments: _attachments, ...rest } = message;
    return {
      ...rest,
      fileIds: fileIds.size ? Array.from(fileIds) : undefined
    };
  });

  return {
    messages: migratedMessages,
    files: Array.from(fileMap.values()).sort((a, b) => a.createdAt - b.createdAt)
  };
}

function mergeSnapshotRuntimeErrors(
  snapshot: RenderSnapshot,
  runtimeErrors: RenderError[] | undefined
): RenderSnapshot {
  if (!runtimeErrors?.length) {
    return snapshot;
  }

  const seen = new Set(snapshot.errors.map(renderErrorKey));
  const mergedErrors = [...snapshot.errors];

  for (const error of runtimeErrors) {
    const key = renderErrorKey(error);
    if (!seen.has(key)) {
      seen.add(key);
      mergedErrors.push(error);
    }
  }

  return {
    ...snapshot,
    errors: mergedErrors
  };
}

export function rebuildAssistantSnapshot(message: ClientMessage): ClientMessage {
  if (message.role !== "assistant" || !message.rawStream) {
    return message;
  }

  const parts = extractStreamUiParts(message.rawStream);
  if (!parts.hasStreamUi || !parts.streamui.trim()) {
    return {
      ...message,
      status: message.status === "streaming" ? "complete" : message.status
    };
  }

  const renderer = createStreamingRenderer();
  renderer.replace(parts.streamui);
  renderer.complete();

  const snapshot = mergeSnapshotRuntimeErrors(
    renderer.getSnapshot(),
    message.runtimeErrors
  );

  const shouldCompletePartialStream =
    message.status === "streaming" && !message.generationRunId;

  return {
    ...message,
    snapshot,
    hasStreamUi: true,
    streamUiComplete: parts.streamUiComplete,
    artifactContext: message.artifactContext ?? buildArtifactContext(message.rawStream),
    status: shouldCompletePartialStream ? "complete" : message.status
  };
}

export function normalizeStoredMessage(
  message: unknown,
  options: NormalizeStoredSessionOptions = {}
): ClientMessage | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const input = message as Partial<ClientMessage>;
  if (
    typeof input.id !== "string" ||
    (input.role !== "user" && input.role !== "assistant")
  ) {
    return null;
  }

  const rawStream = typeof input.rawStream === "string" ? input.rawStream : undefined;
  const streamParts =
    rawStream && options.rebuildSnapshots === false
      ? extractStreamUiParts(rawStream)
      : null;
  const normalized: ClientMessage = {
    id: input.id,
    role: input.role,
    content:
      input.role === "user" && typeof input.content === "string"
        ? stripLegacyArtifactActionPrefix(input.content)
        : typeof input.content === "string"
          ? input.content
          : "",
    attachments: Array.isArray(input.attachments) ? input.attachments : undefined,
    fileIds: normalizeStringArray(input.fileIds),
    reasoning: typeof input.reasoning === "string" ? input.reasoning : undefined,
    sessionTitle:
      typeof input.sessionTitle === "string" ? input.sessionTitle : undefined,
    rawStream,
    hasStreamUi: Boolean(input.hasStreamUi || streamParts?.hasStreamUi),
    streamUiComplete: Boolean(input.streamUiComplete || streamParts?.streamUiComplete),
    artifactContext: normalizeArtifactContext(input.artifactContext),
    runtimeErrors: normalizeRenderErrors(input.runtimeErrors),
    repairOfMessageId:
      typeof input.repairOfMessageId === "string"
        ? input.repairOfMessageId
        : undefined,
    repairAttempt:
      typeof input.repairAttempt === "number" && Number.isFinite(input.repairAttempt)
        ? Math.max(1, Math.round(input.repairAttempt))
        : undefined,
    branchGroupId:
      typeof input.branchGroupId === "string" && input.branchGroupId.trim()
        ? input.branchGroupId.trim().slice(0, 160)
        : undefined,
    branchVariantId:
      typeof input.branchVariantId === "string" && input.branchVariantId.trim()
        ? input.branchVariantId.trim().slice(0, 160)
        : undefined,
    branchAnchor: input.branchAnchor ? true : undefined,
    artifactEditBaseRawStream:
      typeof input.artifactEditBaseRawStream === "string"
        ? input.artifactEditBaseRawStream
        : undefined,
    artifactEdits: normalizeArtifactEdits(input.artifactEdits),
    activeArtifactEditId:
      typeof input.activeArtifactEditId === "string" &&
      input.activeArtifactEditId.trim()
        ? input.activeArtifactEditId.trim().slice(0, 160)
        : undefined,
    generationRunId:
      typeof input.generationRunId === "string" && input.generationRunId.trim()
        ? input.generationRunId.trim()
        : undefined,
    streamSequence:
      typeof input.streamSequence === "number" && Number.isFinite(input.streamSequence)
        ? Math.max(0, Math.round(input.streamSequence))
        : undefined,
    status:
      input.status === "streaming" ||
      input.status === "complete" ||
      input.status === "error"
          ? input.status
          : input.role === "assistant"
            ? "complete"
            : undefined,
    error: typeof input.error === "string" ? input.error : undefined
  };

  if (
    normalized.role === "assistant" &&
    normalized.status === "streaming" &&
    !normalized.generationRunId
  ) {
    normalized.status = "complete";
  }

  return options.rebuildSnapshots === false
    ? normalized
    : rebuildAssistantSnapshot(normalized);
}

export function normalizeStoredSession(
  session: unknown,
  now = Date.now(),
  options: NormalizeStoredSessionOptions = {}
): ChatSession | null {
  if (!session || typeof session !== "object") {
    return null;
  }

  const input = session as Partial<ChatSession>;
  if (typeof input.id !== "string") {
    return null;
  }

  const messages = Array.isArray(input.messages)
    ? input.messages
        .map((message) => normalizeStoredMessage(message, options))
        .filter((message): message is ClientMessage => message !== null)
    : [];
  const migrated = migrateMessageFiles(
    messages,
    normalizeSessionFiles(input.files, now),
    now
  );
  const createdAt =
    typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
      ? input.createdAt
      : now;
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : createdAt;
  const summarizedTitle = summarizeSession(migrated.messages);

  return {
    id: input.id,
    title:
      summarizedTitle !== UNTITLED_SESSION
        ? summarizedTitle
        : typeof input.title === "string" && input.title.trim()
          ? input.title.trim()
          : UNTITLED_SESSION,
    createdAt,
    updatedAt,
    model:
      typeof input.model === "string" && input.model.trim()
        ? input.model.trim().slice(0, 180)
        : undefined,
    branchSelections: normalizeBranchSelections(input.branchSelections),
    messages: migrated.messages,
    files: migrated.files
  };
}

export function normalizeStoredSessionState(
  input: unknown,
  now = Date.now(),
  options: NormalizeStoredSessionOptions = {}
): SessionState {
  if (!input || typeof input !== "object") {
    return createInitialSessionState(now);
  }

  const state = input as Partial<SessionState>;
  const sessions = Array.isArray(state.sessions)
    ? state.sessions
        .map((session) => normalizeStoredSession(session, now, options))
        .filter((session): session is ChatSession => session !== null)
    : [];

  if (!sessions.length) {
    return createInitialSessionState(now);
  }

  const sorted = sortSessions(sessions);
  const activeSessionId =
    typeof state.activeSessionId === "string" &&
    sorted.some((session) => session.id === state.activeSessionId)
      ? state.activeSessionId
      : sorted[0].id;

  return compactEmptySessions({
    sessions: sorted,
    activeSessionId
  });
}

export function hasPersistedMessages(state: SessionState): boolean {
  return state.sessions.some((session) => session.messages.length > 0);
}

export function serializeMessage(
  message: ClientMessage
): Omit<ClientMessage, "snapshot"> {
  const {
    snapshot: _snapshot,
    attachments: _attachments,
    ...serializable
  } = message;

  return {
    ...serializable
  };
}

export function serializeSessions(sessions: ChatSession[]) {
  return sessions.map((session) => ({
    ...session,
    messages: session.messages.map(serializeMessage)
  }));
}

export function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}
