import { useEffect, useMemo, useRef } from "react";
import {
  AuiIf,
  ComposerPrimitive,
  ThreadPrimitive
} from "@assistant-ui/react";
import { AssistantMessage } from "../../web/src/components/AssistantMessage";
import { ChatMessage } from "../../web/src/components/ChatMessage";
import type {
  ClientMessage
} from "../../web/src/domain/chat/sessionModel";
import type { RenderError } from "../../web/src/runtime/streamui/types";

type WebDemoThreadProps = {
  messages: ClientMessage[];
  themeMode: "day" | "night";
  onRuntimeError(id: string, error: RenderError): void;
};

export function WebDemoThread({
  messages,
  themeMode,
  onRuntimeError
}: WebDemoThreadProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
    }
  }, [messages]);

  return (
    <ThreadPrimitive.Root className="thread-root webdemo-thread">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        className={`message-list ${
          messages.length ? "has-messages" : "is-new"
        }`}
        autoScroll={false}
      >
        <AuiIf condition={(state) => state.thread.messages.length === 0}>
          <section className="thread-welcome">
            <p>ChatHTML Web Demo</p>
            <h2>What would you like to create?</h2>
          </section>
        </AuiIf>

        <ThreadPrimitive.Messages>
          {({ message }) => {
            const current = messageById.get(message.id);
            if (!current) {
              return null;
            }
            if (current.role === "assistant") {
              return (
                <AssistantMessage
                  id={current.id}
                  content={current.content}
                  reasoning={current.reasoning}
                  rawStream={current.rawStream}
                  hasStreamUi={current.hasStreamUi}
                  snapshot={current.snapshot}
                  runtimeErrors={current.runtimeErrors}
                  themeMode={themeMode}
                  showRawStream={false}
                  artifactEditingEnabled={false}
                  status={current.status}
                  generationOutcome={current.generationOutcome}
                  error={current.error}
                  onRuntimeError={onRuntimeError}
                  onArtifactAction={() => undefined}
                  onArtifactSelection={() => undefined}
                  onArtifactSelectionModeChange={() => undefined}
                  onOpenReasoningActivity={() => undefined}
                  onVisualRepair={() => undefined}
                  onRegenerate={() => undefined}
                  onSelectBranch={() => undefined}
                  onSelectArtifactEdit={() => undefined}
                />
              );
            }
            return (
              <ChatMessage
                id={current.id}
                role="user"
                onEdit={() => undefined}
                onEditArtifactEditPrompt={() => false}
              >
                {current.content}
              </ChatMessage>
            );
          }}
        </ThreadPrimitive.Messages>

        <ThreadPrimitive.ViewportFooter
          className={`composer-footer ${
            messages.length ? "has-messages" : "is-new"
          }`}
        >
          <ComposerPrimitive.Root className="chat-input-bar webdemo-input-bar">
            <div className="chat-input-dropzone">
              <ComposerPrimitive.Input
                className="chat-input-textarea"
                rows={1}
                autoFocus
                placeholder="Ask ChatHTML to create something..."
                submitMode="enter"
              />
              <div className="chat-input-actions webdemo-input-actions">
                <AuiIf condition={(state) => !state.thread.isRunning}>
                  <ComposerPrimitive.Send
                    className="send-button"
                    type="submit"
                    aria-label="Send message"
                    title="Send message"
                  >
                    <span className="send-arrow-up" aria-hidden="true" />
                  </ComposerPrimitive.Send>
                </AuiIf>
                <AuiIf condition={(state) => state.thread.isRunning}>
                  <ComposerPrimitive.Cancel
                    className="send-button cancel-button"
                    type="button"
                    aria-label="Stop response"
                    title="Stop response"
                  >
                    <span className="stop-square" aria-hidden="true" />
                  </ComposerPrimitive.Cancel>
                </AuiIf>
              </div>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
