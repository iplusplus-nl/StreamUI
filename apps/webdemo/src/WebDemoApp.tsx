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
import { ChatShell } from "../../web/src/components/ChatShell";
import {
  convertMessage,
  getAppendMessageText
} from "../../web/src/features/chat/assistantRuntimeAdapter";
import {
  createEmptySession,
  createId,
  createInitialSessionState,
  isSessionEmpty,
  sortSessions,
  summarizeSession,
  type ClientMessage,
  type SessionState
} from "../../web/src/domain/chat/sessionModel";
import { extractStreamUiParts } from "../../web/src/runtime/streamui/protocol";
import type { RenderError } from "../../web/src/runtime/streamui/types";
import { usePersistentThemeMode } from "../../web/src/features/settings/usePersistentThemeMode";
import { WebDemoBanner } from "./WebDemoBanner";
import { WebDemoSidebar } from "./WebDemoSidebar";
import { WebDemoThread } from "./WebDemoThread";
import { streamWebDemoResponse } from "./webDemoApi";
import { loadWebDemoHistory, saveWebDemoHistory } from "./webDemoHistory";

const HISTORY_SAVE_DEBOUNCE_MS = 180;

function assistantPatchFromRaw(raw: string): Partial<ClientMessage> {
  const parts = extractStreamUiParts(raw);
  return {
    rawStream: raw,
    content: parts.chat || parts.fallbackText,
    sessionTitle: parts.sessionTitle || undefined,
    hasStreamUi: parts.hasStreamUi,
    streamUiComplete: parts.streamUiComplete
  };
}

export default function WebDemoApp() {
  const [themeMode, setThemeMode] = usePersistentThemeMode();
  const [sessionState, setSessionState] = useState(loadWebDemoHistory);
  const stateRef = useRef(sessionState);
  const [isSending, setIsSending] = useState(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const [downloadNotice, setDownloadNotice] = useState(false);

  const replaceState = useCallback(
    (updater: SessionState | ((current: SessionState) => SessionState)) => {
      const next =
        typeof updater === "function"
          ? updater(stateRef.current)
          : updater;
      stateRef.current = next;
      setSessionState(next);
    },
    []
  );

  useEffect(() => {
    stateRef.current = sessionState;
    const timer = window.setTimeout(
      () => saveWebDemoHistory(sessionState),
      HISTORY_SAVE_DEBOUNCE_MS
    );
    return () => window.clearTimeout(timer);
  }, [sessionState]);

  useEffect(() => {
    const flush = () => saveWebDemoHistory(stateRef.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  useEffect(() => {
    if (!downloadNotice) {
      return undefined;
    }
    const timer = window.setTimeout(() => setDownloadNotice(false), 2_800);
    return () => window.clearTimeout(timer);
  }, [downloadNotice]);

  useEffect(() => {
    return () => activeRequestRef.current?.abort();
  }, []);

  const activeSession =
    sessionState.sessions.find(
      (session) => session.id === sessionState.activeSessionId
    ) ?? sessionState.sessions[0];
  const messages = activeSession?.messages ?? [];

  const updateSession = useCallback(
    (
      sessionId: string,
      updater: (session: SessionState["sessions"][number]) => SessionState["sessions"][number]
    ) => {
      replaceState((current) => {
        let changed = false;
        const sessions = current.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }
          const next = updater(session);
          changed = changed || next !== session;
          return next;
        });
        return changed ? { ...current, sessions: sortSessions(sessions) } : current;
      });
    },
    [replaceState]
  );

  const updateAssistant = useCallback(
    (
      sessionId: string,
      assistantId: string,
      patch: Partial<ClientMessage>
    ) => {
      updateSession(sessionId, (session) => {
        let changed = false;
        const nextMessages = session.messages.map((message) => {
          if (message.id !== assistantId) {
            return message;
          }
          changed = true;
          return { ...message, ...patch };
        });
        if (!changed) {
          return session;
        }
        const sessionTitle =
          typeof patch.sessionTitle === "string" && patch.sessionTitle.trim()
            ? patch.sessionTitle.trim()
            : summarizeSession(nextMessages);
        return {
          ...session,
          title: sessionTitle,
          updatedAt: Date.now(),
          messages: nextMessages
        };
      });
    },
    [updateSession]
  );

  const handleNewSession = useCallback(() => {
    if (isSending) {
      return;
    }
    replaceState((current) => {
      const active = current.sessions.find(
        (session) => session.id === current.activeSessionId
      );
      if (active && isSessionEmpty(active)) {
        return current;
      }
      const session = createEmptySession();
      return {
        sessions: sortSessions([...current.sessions, session]),
        activeSessionId: session.id
      };
    });
  }, [isSending, replaceState]);

  const handleSelectSession = useCallback(
    (id: string) => {
      if (isSending) {
        return;
      }
      replaceState((current) =>
        current.sessions.some((session) => session.id === id)
          ? { ...current, activeSessionId: id }
          : current
      );
    },
    [isSending, replaceState]
  );

  const handleDeleteSession = useCallback(
    (id: string) => {
      if (isSending) {
        return;
      }
      replaceState((current) => {
        const sessions = current.sessions.filter((session) => session.id !== id);
        if (!sessions.length) {
          return createInitialSessionState();
        }
        return {
          sessions,
          activeSessionId:
            current.activeSessionId === id
              ? sessions[0].id
              : current.activeSessionId
        };
      });
    },
    [isSending, replaceState]
  );

  const handleNewMessage = useCallback(
    async (message: AppendMessage) => {
      const text = getAppendMessageText(message);
      if (!text || isSending) {
        return;
      }
      const currentState = stateRef.current;
      const session = currentState.sessions.find(
        (candidate) => candidate.id === currentState.activeSessionId
      );
      if (!session) {
        return;
      }

      const userMessage: ClientMessage = {
        id: createId("user"),
        role: "user",
        content: text
      };
      const assistantId = createId("assistant");
      const assistantMessage: ClientMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        rawStream: "",
        generationRunId: createId("web-demo-run"),
        status: "streaming"
      };
      const requestMessages = [...session.messages, userMessage]
        .filter((item) => item.content.trim())
        .slice(-40)
        .map((item) => ({ role: item.role, content: item.content }));
      updateSession(session.id, (current) => {
        const nextMessages = [
          ...current.messages,
          userMessage,
          assistantMessage
        ];
        return {
          ...current,
          title: summarizeSession(nextMessages),
          updatedAt: Date.now(),
          messages: nextMessages
        };
      });

      const controller = new AbortController();
      activeRequestRef.current = controller;
      setIsSending(true);
      let raw = "";
      try {
        await streamWebDemoResponse(
          {
            messages: requestMessages,
            themeMode,
            canvas: {
              width: Math.min(900, Math.max(280, window.innerWidth - 320)),
              height: Math.min(640, Math.max(260, window.innerHeight - 180))
            }
          },
          controller.signal,
          (delta) => {
            raw += delta;
            updateAssistant(
              session.id,
              assistantId,
              assistantPatchFromRaw(raw)
            );
          }
        );
        updateAssistant(session.id, assistantId, {
          ...assistantPatchFromRaw(raw),
          generationOutcome: "complete",
          status: "complete"
        });
      } catch (error) {
        if (controller.signal.aborted) {
          updateAssistant(session.id, assistantId, {
            ...assistantPatchFromRaw(raw),
            generationOutcome: "cancelled",
            status: "complete"
          });
        } else {
          updateAssistant(session.id, assistantId, {
            content: raw
              ? assistantPatchFromRaw(raw).content ?? ""
              : "The Web Demo could not complete this response.",
            rawStream: raw,
            generationOutcome: "error",
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "The Web Demo request failed."
          });
        }
      } finally {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = null;
        }
        setIsSending(false);
      }
    },
    [isSending, themeMode, updateAssistant, updateSession]
  );

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning: isSending,
    isSendDisabled: isSending,
    onNew: handleNewMessage,
    onCancel: async () => {
      activeRequestRef.current?.abort();
    }
  });

  const sidebarItems = useMemo(
    () =>
      sessionState.sessions.map((session) => ({
        id: session.id,
        title: session.title
      })),
    [sessionState.sessions]
  );
  const handleDownload = useCallback(() => setDownloadNotice(true), []);
  const handleRuntimeError = useCallback(
    (id: string, error: RenderError) => {
      if (!activeSession) {
        return;
      }
      updateAssistant(activeSession.id, id, {
        runtimeErrors: [
          ...(activeSession.messages.find((message) => message.id === id)
            ?.runtimeErrors ?? []),
          error
        ]
      });
    },
    [activeSession, updateAssistant]
  );

  return (
    <div className="webdemo-root" data-theme={themeMode}>
      <WebDemoBanner themeMode={themeMode} onDownload={handleDownload} />
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatShell
          themeMode={themeMode}
          onThemeModeChange={setThemeMode}
          sidebar={
            <WebDemoSidebar
              sessions={sidebarItems}
              activeSessionId={sessionState.activeSessionId}
              isSending={isSending}
              onNewSession={handleNewSession}
              onSelectSession={handleSelectSession}
              onDeleteSession={handleDeleteSession}
              onDownload={handleDownload}
            />
          }
        >
          <WebDemoThread
            messages={messages}
            themeMode={themeMode}
            onRuntimeError={handleRuntimeError}
          />
        </ChatShell>
      </AssistantRuntimeProvider>
      {downloadNotice ? (
        <div className="webdemo-download-notice" role="status" aria-live="polite">
          The ChatHTML download page is coming soon.
        </div>
      ) : null}
    </div>
  );
}
