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
  status?: "streaming" | "complete" | "error";
  error?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ClientMessage[];
};

export type SessionState = {
  sessions: ChatSession[];
  activeSessionId: string;
};

export const initialMessages: ClientMessage[] = [];
export const UNTITLED_SESSION = "New Session";

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
    messages: initialMessages
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

  if (firstUserMessage.attachments?.length) {
    return "Image conversation";
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

  return {
    ...message,
    snapshot,
    hasStreamUi: true,
    streamUiComplete: parts.streamUiComplete,
    artifactContext: message.artifactContext ?? buildArtifactContext(message.rawStream),
    status: message.status === "streaming" ? "complete" : message.status
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
    status:
      input.status === "streaming"
        ? "complete"
        : input.status === "complete" || input.status === "error"
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
  const createdAt =
    typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
      ? input.createdAt
      : now;
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : createdAt;
  const summarizedTitle = summarizeSession(messages);

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
    messages
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
  const { snapshot: _snapshot, ...serializable } = message;
  return {
    ...serializable,
    status: serializable.status === "streaming" ? "complete" : serializable.status
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
