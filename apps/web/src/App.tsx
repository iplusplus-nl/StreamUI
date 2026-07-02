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
import { createStreamingRenderer } from "./core/createStreamingRenderer";
import { extractStreamUiParts } from "./core/extractStreamUiParts";
import type { ImageAttachment } from "./core/imageAttachments";
import type { RenderError, RenderSnapshot, StreamingRenderer } from "./core/types";

type ClientMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ImageAttachment[];
  reasoning?: string;
  sessionTitle?: string;
  rawStream?: string;
  hasStreamUi?: boolean;
  streamUiComplete?: boolean;
  snapshot?: RenderSnapshot;
  status?: "streaming" | "complete" | "error";
  error?: string;
};

type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ClientMessage[];
};

type SessionState = {
  sessions: ChatSession[];
  activeSessionId: string;
};

type ChatStreamEvent = {
  type?: "content" | "reasoning";
  text?: string;
};

const initialMessages: ClientMessage[] = [];
const LEGACY_SESSION_STORAGE_KEY = "streamui.sessions.v1";
const LEGACY_ACTIVE_SESSION_STORAGE_KEY = "streamui.activeSession.v1";
const THEME_STORAGE_KEY = "streamui.theme.v1";
const UNTITLED_SESSION = "New Session";

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "night";
  }

  return window.localStorage.getItem(THEME_STORAGE_KEY) === "day"
    ? "day"
    : "night";
}

function createEmptySession(): ChatSession {
  const now = Date.now();

  return {
    id: createId("session"),
    title: UNTITLED_SESSION,
    createdAt: now,
    updatedAt: now,
    messages: initialMessages
  };
}

function createInitialSessionState(): SessionState {
  const session = createEmptySession();
  return { sessions: [session], activeSessionId: session.id };
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleFromText(value: string): string {
  const compact = compactText(value);
  if (!compact) {
    return UNTITLED_SESSION;
  }

  const withoutProtocol = compact
    .replace(/\b(sessiontitle|chat|streamui)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = withoutProtocol.split(/(?<=[.!?。！？])\s+/u)[0] ?? withoutProtocol;
  const words = firstSentence.split(/\s+/).filter(Boolean);
  const shortTitle =
    words.length > 7 ? words.slice(0, 7).join(" ") : firstSentence;

  if (shortTitle.length <= 58) {
    return shortTitle;
  }

  return `${shortTitle.slice(0, 57).trimEnd()}…`;
}

function assistantMessageToSessionTitle(message: ClientMessage): string {
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

function summarizeSession(messages: ClientMessage[]): string {
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

function countUserPrompts(messages: ClientMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function rebuildAssistantSnapshot(message: ClientMessage): ClientMessage {
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
  renderer.feed(parts.streamui);
  renderer.complete();

  return {
    ...message,
    snapshot: renderer.getSnapshot(),
    hasStreamUi: true,
    streamUiComplete: parts.streamUiComplete,
    status: message.status === "streaming" ? "complete" : message.status
  };
}

function normalizeStoredMessage(message: unknown): ClientMessage | null {
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

function normalizeStoredSession(session: unknown): ChatSession | null {
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
  const now = Date.now();
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

function normalizeStoredSessionState(input: unknown): SessionState {
  if (!input || typeof input !== "object") {
    return createInitialSessionState();
  }

  const state = input as Partial<SessionState>;
  const sessions = Array.isArray(state.sessions)
    ? state.sessions
        .map(normalizeStoredSession)
        .filter((session): session is ChatSession => session !== null)
    : [];

  if (!sessions.length) {
    return createInitialSessionState();
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

function hasPersistedMessages(state: SessionState): boolean {
  return state.sessions.some((session) => session.messages.length > 0);
}

function clearLegacyLocalSessions(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_ACTIVE_SESSION_STORAGE_KEY);
}

function serializeMessage(message: ClientMessage): Omit<ClientMessage, "snapshot"> {
  const { snapshot: _snapshot, ...serializable } = message;
  return {
    ...serializable,
    status: serializable.status === "streaming" ? "complete" : serializable.status
  };
}

function serializeSessions(sessions: ChatSession[]) {
  return sessions.map((session) => ({
    ...session,
    messages: session.messages.map(serializeMessage)
  }));
}

function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

function decodeHtmlEntities(value: string): string {
  if (typeof document === "undefined") {
    return value;
  }

  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function htmlToTranscriptText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function getApiMessageContent(message: ClientMessage): string {
  const visibleContent = message.content.trim();
  if (visibleContent) {
    return visibleContent;
  }

  if (message.role !== "assistant" || !message.rawStream) {
    return message.content;
  }

  const parts = extractStreamUiParts(message.rawStream);
  const artifactText = htmlToTranscriptText(parts.streamui || parts.fallbackText);
  if (!artifactText) {
    return "[Assistant produced a StreamUI artifact for this turn.]";
  }

  return `[Assistant produced a StreamUI artifact for this turn. Text summary: ${artifactText.slice(
    0,
    4_000
  )}]`;
}

function toApiMessages(messages: ClientMessage[]) {
  return messages
    .filter((message) => message.id !== "welcome")
    .filter(
      (message) =>
        message.role === "user" ||
        getApiMessageContent(message).trim() ||
        (message.attachments?.length ?? 0) > 0
    )
    .map((message) => ({
      role: message.role,
      content: getApiMessageContent(message),
      images: message.attachments?.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        dataUrl: attachment.dataUrl
      }))
    }));
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
  messages: ClientMessage[];
  onRuntimeError(id: string, error: RenderError): void;
};

function StreamThread({ messages, onRuntimeError }: StreamThreadProps) {
  const isNewChat = useAuiState((state) => state.thread.messages.length === 0);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  );

  return (
    <ThreadPrimitive.Root
      className={`thread-root ${isNewChat ? "is-new" : "has-messages"}`}
    >
      <ThreadPrimitive.Viewport
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
                  status={clientMessage.status}
                  error={clientMessage.error}
                  onRuntimeError={onRuntimeError}
                />
              );
            }

            return (
              <ChatMessage
                role={clientMessage.role}
                attachments={clientMessage.attachments}
              >
                {clientMessage.content}
              </ChatMessage>
            );
          }}
        </ThreadPrimitive.Messages>
        <ThreadPrimitive.ViewportFooter
          className={`composer-footer ${isNewChat ? "is-new" : "has-messages"}`}
        >
          <ChatInput />
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
  const [isSending, setIsSending] = useState(false);
  const activeSession =
    sessionState.sessions.find(
      (session) => session.id === sessionState.activeSessionId
    ) ?? sessionState.sessions[0];
  const messages = activeSession?.messages ?? initialMessages;
  const messagesRef = useRef(messages);
  const activeSessionIdRef = useRef(sessionState.activeSessionId);
  const isSendingRef = useRef(isSending);
  const saveAbortRef = useRef<AbortController | null>(null);
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());
  const attachmentAdapter = useMemo(() => new StreamImageAttachmentAdapter(), []);

  useEffect(() => {
    messagesRef.current = messages;
    activeSessionIdRef.current = sessionState.activeSessionId;
  }, [messages, sessionState.activeSessionId]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

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

    fetch("/api/sessions")
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
          setSessionState(
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
          setSessionsLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !sessionsLoaded) {
      return undefined;
    }

    const controller = new AbortController();
    saveAbortRef.current?.abort();
    saveAbortRef.current = controller;

    const timeout = window.setTimeout(() => {
      fetch("/api/sessions", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          sessions: serializeSessions(sessionState.sessions),
          activeSessionId: sessionState.activeSessionId
        })
      })
        .then(() => clearLegacyLocalSessions())
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

  const updateActiveSessionMessages = useCallback(
    (updater: (messages: ClientMessage[]) => ClientMessage[]) => {
      setSessionState((current) => {
        const now = Date.now();
        const sessions = current.sessions.map((session) => {
          if (session.id !== current.activeSessionId) {
            return session;
          }

          const nextMessages = updater(session.messages);
          return {
            ...session,
            title: summarizeSession(nextMessages),
            updatedAt: now,
            messages: nextMessages
          };
        });

        return {
          ...current,
          sessions: sortSessions(sessions)
        };
      });
    },
    []
  );

  const updateAssistant = useCallback(
    (id: string, patch: Partial<ClientMessage>) => {
      setSessionState((current) => {
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
    []
  );

  const handleRuntimeError = useCallback(
    (id: string, error: RenderError) => {
      setSessionState((current) => {
        let didUpdate = false;
        const sessions = current.sessions.map((session) => {
          let sessionChanged = false;
          const messages = session.messages.map((message) => {
            if (message.id !== id || !message.snapshot) {
              return message;
            }

            const exists = message.snapshot.errors.some(
              (existing) =>
                existing.kind === error.kind && existing.message === error.message
            );

            if (exists) {
              return message;
            }

            didUpdate = true;
            sessionChanged = true;
            return {
              ...message,
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
    []
  );

  const handleNewSession = useCallback(() => {
    if (isSendingRef.current) {
      return;
    }

    setSessionState((current) => {
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
  }, []);

  const handleSelectSession = useCallback((id: string) => {
    if (isSendingRef.current && id !== activeSessionIdRef.current) {
      return;
    }

    setSessionState((current) =>
      current.sessions.some((session) => session.id === id)
        ? { ...current, activeSessionId: id }
        : current
    );
  }, []);

  const handleDeleteSession = useCallback((id: string) => {
    if (isSendingRef.current) {
      return;
    }

    setSessionState((current) => {
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
  }, []);

  const sendStreamUiRequest = useCallback(
    async (text: string, attachments: ImageAttachment[] = []) => {
      const trimmed = text.trim();
      if ((!trimmed && attachments.length === 0) || isSendingRef.current) {
        return;
      }

      const userMessage: ClientMessage = {
        id: createId("user"),
        role: "user",
        content: trimmed,
        attachments,
        status: "complete"
      };
      const assistantId = createId("assistant");
      const assistantMessage: ClientMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        rawStream: "",
        status: "streaming"
      };
      const renderer = createStreamingRenderer(themeMode);
      renderersRef.current.set(assistantId, renderer);

      const unsubscribeSnapshot = renderer.onSnapshot((snapshot) => {
        updateAssistant(assistantId, { snapshot });
      });

      const requestHistory = [...messagesRef.current, userMessage];
      updateActiveSessionMessages((current) => [
        ...current,
        userMessage,
        assistantMessage
      ]);
      setIsSending(true);

      let raw = "";
      let reasoning = "";
      let lastStreamUiLength = 0;

      const handleContentChunk = (chunk: string) => {
        raw += chunk;
        const parts = extractStreamUiParts(raw);

        if (parts.hasStreamUi) {
          const renderedStreamUi = renderer.getSnapshot().raw;
          if (!parts.streamui.startsWith(renderedStreamUi)) {
            renderer.reset();
            if (parts.streamui) {
              renderer.feed(parts.streamui);
            }
            lastStreamUiLength = parts.streamui.length;
          } else {
            const streamUiDelta = parts.streamui.slice(lastStreamUiLength);
            if (streamUiDelta) {
              renderer.feed(streamUiDelta);
              lastStreamUiLength = parts.streamui.length;
            }
          }
        }

        const sessionTitle =
          parts.sessionTitleComplete && parts.sessionTitle.trim()
            ? parts.sessionTitle
            : undefined;

        updateAssistant(assistantId, {
          content: parts.chat || (!parts.hasStreamUi ? parts.fallbackText : ""),
          rawStream: raw,
          ...(sessionTitle ? { sessionTitle } : {}),
          hasStreamUi: parts.hasStreamUi,
          streamUiComplete: parts.streamUiComplete
        });
      };

      const handleStreamEvent = (line: string) => {
        if (!line.trim()) {
          return;
        }

        try {
          const event = JSON.parse(line) as ChatStreamEvent;
          if (event.type === "reasoning" && event.text) {
            reasoning += event.text;
            updateAssistant(assistantId, { reasoning });
            return;
          }
          if (event.type === "content" && event.text) {
            handleContentChunk(event.text);
            return;
          }
        } catch {
          handleContentChunk(line);
        }
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messages: toApiMessages(requestHistory),
            canvas: getCanvasContext(),
            themeMode
          })
        });

        if (!response.ok || !response.body) {
          const errorText = await response.text();
          throw new Error(errorText || `Request failed with ${response.status}.`);
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

        const finalParts = extractStreamUiParts(raw);

        if (finalParts.hasStreamUi && finalParts.streamui.trim()) {
          renderer.complete();
        }

        updateAssistant(assistantId, {
          content: finalParts.chat || finalParts.fallbackText,
          reasoning,
          ...(finalParts.sessionTitleComplete && finalParts.sessionTitle.trim()
            ? { sessionTitle: finalParts.sessionTitle }
            : {}),
          rawStream: raw,
          hasStreamUi: finalParts.hasStreamUi && finalParts.streamui.trim().length > 0,
          streamUiComplete: finalParts.streamUiComplete,
          status: "complete"
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The chat request failed.";
        updateAssistant(assistantId, {
          content: "I could not complete that request.",
          error: message,
          reasoning,
          rawStream: raw,
          status: "error"
        });
      } finally {
        unsubscribeSnapshot();
        renderersRef.current.delete(assistantId);
        setIsSending(false);
      }
    },
    [themeMode, updateActiveSessionMessages, updateAssistant]
  );

  const handleNewMessage = useCallback(
    async (message: AppendMessage) => {
      await sendStreamUiRequest(
        getAppendMessageText(message),
        getAppendMessageImages(message)
      );
    },
    [sendStreamUiRequest]
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: isSending,
    isSendDisabled: isSending,
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
        title: session.title || summarizeSession(session.messages),
        promptCount: countUserPrompts(session.messages)
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
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            onThemeModeChange={setThemeMode}
          />
        }
      >
        <StreamThread
          messages={messages}
          onRuntimeError={handleRuntimeError}
        />
      </ChatShell>
    </AssistantRuntimeProvider>
  );
}
