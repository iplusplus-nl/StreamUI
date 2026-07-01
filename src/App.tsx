import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantMessage } from "./components/AssistantMessage";
import { ChatInput } from "./components/ChatInput";
import { ChatMessage } from "./components/ChatMessage";
import { ChatShell } from "./components/ChatShell";
import { createStreamingRenderer } from "./core/createStreamingRenderer";
import { extractStreamUiParts } from "./core/extractStreamUiParts";
import type { RenderError, RenderSnapshot, StreamingRenderer } from "./core/types";

type ClientMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  rawStream?: string;
  hasStreamUi?: boolean;
  streamUiComplete?: boolean;
  snapshot?: RenderSnapshot;
  status?: "streaming" | "complete" | "error";
  error?: string;
};

type ChatStreamEvent = {
  type?: "content" | "reasoning";
  text?: string;
};

const initialMessages: ClientMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content: "What would you like to make visual or interactive today?",
    status: "complete"
  }
];

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toApiMessages(messages: ClientMessage[]) {
  return messages
    .filter((message) => message.id !== "welcome")
    .filter((message) => message.role === "user" || message.content.trim())
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

function getCanvasContext() {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const messageListWidth =
    document.querySelector<HTMLElement>(".message-list")?.clientWidth ??
    viewportWidth;
  const avatarAndGap = viewportWidth <= 720 ? 42 : 46;
  const canvasWidth = Math.min(900, Math.max(280, messageListWidth - avatarAndGap));
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
  const [messages, setMessages] = useState<ClientMessage[]>(initialMessages);
  const [isSending, setIsSending] = useState(false);
  const messagesRef = useRef(messages);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());

  useEffect(() => {
    messagesRef.current = messages;
    listEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const updateAssistant = useCallback(
    (id: string, patch: Partial<ClientMessage>) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, ...patch } : message
        )
      );
    },
    []
  );

  const handleRuntimeError = useCallback(
    (id: string, error: RenderError) => {
      setMessages((current) =>
        current.map((message) => {
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

          return {
            ...message,
            snapshot: {
              ...message.snapshot,
              errors: [...message.snapshot.errors, error]
            }
          };
        })
      );
    },
    []
  );

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) {
        return;
      }

      const userMessage: ClientMessage = {
        id: createId("user"),
        role: "user",
        content: trimmed,
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
      const renderer = createStreamingRenderer();
      renderersRef.current.set(assistantId, renderer);

      const unsubscribeSnapshot = renderer.onSnapshot((snapshot) => {
        updateAssistant(assistantId, { snapshot });
      });

      setMessages((current) => [...current, userMessage, assistantMessage]);
      setIsSending(true);

      let raw = "";
      let reasoning = "";
      let lastStreamUiLength = 0;

      const handleContentChunk = (chunk: string) => {
        raw += chunk;
        const parts = extractStreamUiParts(raw);

        if (parts.hasStreamUi) {
          const streamUiDelta = parts.streamui.slice(lastStreamUiLength);
          if (streamUiDelta) {
            renderer.feed(streamUiDelta);
            lastStreamUiLength = parts.streamui.length;
          }
        }

        updateAssistant(assistantId, {
          content:
            parts.chat ||
            (!parts.hasStreamUi ? parts.fallbackText : ""),
          rawStream: raw,
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
            messages: toApiMessages([...messagesRef.current, userMessage]),
            canvas: getCanvasContext()
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
          content:
            finalParts.chat ||
            finalParts.fallbackText ||
            "Done.",
          reasoning,
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
        setIsSending(false);
      }
    },
    [isSending, updateAssistant]
  );

  return (
    <ChatShell>
      <main className="message-list" aria-live="polite">
        {messages.map((message) =>
          message.role === "assistant" ? (
            <AssistantMessage
              key={message.id}
              id={message.id}
              content={message.content}
              reasoning={message.reasoning}
              rawStream={message.rawStream}
              hasStreamUi={message.hasStreamUi}
              snapshot={message.snapshot}
              status={message.status}
              error={message.error}
              onRuntimeError={handleRuntimeError}
            />
          ) : (
            <ChatMessage key={message.id} role={message.role}>
              {message.content}
            </ChatMessage>
          )
        )}
        <div ref={listEndRef} />
      </main>
      <ChatInput isSending={isSending} onSend={handleSend} />
    </ChatShell>
  );
}
