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

const initialMessages: ClientMessage[] = [];

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toApiMessages(messages: ClientMessage[]) {
  return messages
    .filter((message) => message.id !== "welcome")
    .filter(
      (message) =>
        message.role === "user" ||
        message.content.trim() ||
        (message.attachments?.length ?? 0) > 0
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
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
        autoScroll
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
  const [messages, setMessages] = useState<ClientMessage[]>(initialMessages);
  const [isSending, setIsSending] = useState(false);
  const messagesRef = useRef(messages);
  const isSendingRef = useRef(isSending);
  const renderersRef = useRef<Map<string, StreamingRenderer>>(new Map());
  const attachmentAdapter = useMemo(() => new StreamImageAttachmentAdapter(), []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

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
          content: parts.chat || (!parts.hasStreamUi ? parts.fallbackText : ""),
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
          content: finalParts.chat || finalParts.fallbackText,
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
        renderersRef.current.delete(assistantId);
        setIsSending(false);
      }
    },
    [updateAssistant]
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatShell>
        <StreamThread
          messages={messages}
          onRuntimeError={handleRuntimeError}
        />
      </ChatShell>
    </AssistantRuntimeProvider>
  );
}
