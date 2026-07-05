import type { ImageAttachment } from "../../core/imageAttachments";
import {
  buildArtifactContext,
  type ArtifactContext
} from "../../core/artifactContext";
import { extractStreamUiParts } from "../../runtime/streamui/protocol";
import { createStreamingRenderer } from "../../runtime/streamui/streamingRenderer";
import type { RenderError, RenderSnapshot } from "../../runtime/streamui/types";

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
  messages: ClientMessage[];
  files: SessionFile[];
};

export type SessionState = {
  sessions: ChatSession[];
  activeSessionId: string;
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
  id = createId("session")
): ChatSession {
  return {
    id,
    title: UNTITLED_SESSION,
    createdAt: now,
    updatedAt: now,
    messages: initialMessages,
    files: []
  };
}

export function createInitialSessionState(
  now = Date.now(),
  id = createId("session")
): SessionState {
  const session = createEmptySession(now, id);
  return { sessions: [session], activeSessionId: session.id };
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
    if (!error) {
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

  const context = message.artifactContext ?? buildArtifactContext(message.rawStream);
  return normalizeSessionFile(
    {
      id: `file-artifact-${message.id}`,
      kind: "artifact",
      name: `${message.id}.streamui.html`,
      mimeType: "text/html",
      size: message.rawStream.length,
      createdAt: now,
      sourceMessageId: message.id,
      text: message.rawStream,
      summary: context?.textSummary || "StreamUI artifact raw source"
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

export function normalizeStoredMessage(message: unknown): ClientMessage | null {
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

  return rebuildAssistantSnapshot({
    id: input.id,
    role: input.role,
    content: typeof input.content === "string" ? input.content : "",
    attachments: Array.isArray(input.attachments) ? input.attachments : undefined,
    fileIds: normalizeStringArray(input.fileIds),
    reasoning: typeof input.reasoning === "string" ? input.reasoning : undefined,
    sessionTitle:
      typeof input.sessionTitle === "string" ? input.sessionTitle : undefined,
    rawStream: typeof input.rawStream === "string" ? input.rawStream : undefined,
    hasStreamUi: Boolean(input.hasStreamUi),
    streamUiComplete: Boolean(input.streamUiComplete),
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
  });
}

export function normalizeStoredSession(
  session: unknown,
  now = Date.now()
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
        .map(normalizeStoredMessage)
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
    messages: migrated.messages,
    files: migrated.files
  };
}

export function normalizeStoredSessionState(
  input: unknown,
  now = Date.now()
): SessionState {
  if (!input || typeof input !== "object") {
    return createInitialSessionState(now);
  }

  const state = input as Partial<SessionState>;
  const sessions = Array.isArray(state.sessions)
    ? state.sessions
        .map((session) => normalizeStoredSession(session, now))
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

  return {
    sessions: sorted,
    activeSessionId
  };
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
