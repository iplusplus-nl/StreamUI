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
  type SessionState
} from "./domain/chat/sessionModel";
import { toApiMessages } from "./features/chat/apiMessages";
import type { ImageAttachment } from "./core/imageAttachments";
import { extractStreamUiParts } from "./runtime/streamui/protocol";
import { createStreamingRenderer } from "./runtime/streamui/streamingRenderer";
import type {
  RenderError,
  RenderSnapshot,
  StreamingRenderer
} from "./runtime/streamui/types";

type ChatStreamEvent = {
  type?: "content" | "reasoning";
  text?: string;
};

type SendStreamUiRequestOptions = {
  appendUserMessage?: boolean;
  assistantPatch?: Partial<ClientMessage>;
  initialReasoning?: string;
  requestHistory?: ClientMessage[];
};

const LEGACY_SESSION_STORAGE_KEY = "streamui.sessions.v1";
const LEGACY_ACTIVE_SESSION_STORAGE_KEY = "streamui.activeSession.v1";
const THEME_STORAGE_KEY = "streamui.theme.v1";
const MAX_RUNTIME_REPAIR_ATTEMPTS = 2;
const MAX_RUNTIME_REPAIR_SOURCE_CHARS = 32_000;
const MAX_RUNTIME_REPAIR_ERROR_CHARS = 4_000;

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
  const activeSession =
    sessionState.sessions.find(
      (session) => session.id === sessionState.activeSessionId
    ) ?? sessionState.sessions[0];
  const messages = activeSession?.messages ?? initialMessages;
  const selectableModels = useMemo(
    () => getSelectableModelOptions(apiSettings),
    [apiSettings]
  );
  const messagesRef = useRef(messages);
  const activeSessionIdRef = useRef(sessionState.activeSessionId);
  const isSendingRef = useRef(isSending);
  const saveAbortRef = useRef<AbortController | null>(null);
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());
  const runtimeRepairQueueRef = useRef<
    ((id: string, error: RenderError) => void) | null
  >(null);
  const runtimeRepairInFlightRef = useRef<Set<string>>(new Set());
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
      const currentMessage = messagesRef.current.find(
        (message) => message.id === id
      );
      const isKnownError =
        hasRenderError(currentMessage?.runtimeErrors, error) ||
        hasRenderError(currentMessage?.snapshot?.errors, error);

      setSessionState((current) => {
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
        status: "streaming",
        ...(options.initialReasoning
          ? { reasoning: options.initialReasoning }
          : {}),
        ...options.assistantPatch
      };
      const renderer = createStreamingRenderer(themeMode);
      renderersRef.current.set(assistantId, renderer);

      const unsubscribeSnapshot = renderer.onSnapshot((snapshot) => {
        updateAssistant(assistantId, { snapshot });
      });

      const requestHistory = options.requestHistory ?? [
        ...messagesRef.current,
        userMessage
      ];
      updateActiveSessionMessages((current) =>
        appendUserMessage
          ? [...current, userMessage, assistantMessage]
          : [...current, assistantMessage]
      );
      setIsSending(true);

      let raw = "";
      let reasoning = options.initialReasoning ?? "";
      const handleContentChunk = (chunk: string) => {
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
            themeMode,
            apiSettings: serializeApiSettings(apiSettings),
            searchSettings: serializeSearchSettings(searchSettings)
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
          ...(finalSnapshot ? { snapshot: finalSnapshot } : {}),
          ...(artifactContext ? { artifactContext } : {}),
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
    [
      apiSettings,
      searchSettings,
      themeMode,
      updateActiveSessionMessages,
      updateAssistant
    ]
  );

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
