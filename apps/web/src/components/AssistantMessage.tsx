import { MessagePrimitive } from "@assistant-ui/react";
import type { RenderError, RenderSnapshot } from "../core/types";
import { AssistantPreviewBubble } from "./AssistantPreviewBubble";
import { AssistantTextBubble } from "./AssistantTextBubble";
import { RawStreamPanel } from "./RawStreamPanel";
import { ReasoningPanel } from "./ReasoningPanel";

type AssistantMessageProps = {
  id: string;
  content: string;
  reasoning?: string;
  rawStream?: string;
  hasStreamUi?: boolean;
  snapshot?: RenderSnapshot;
  status?: "streaming" | "complete" | "error";
  error?: string;
  onRuntimeError(id: string, error: RenderError): void;
};

export function AssistantMessage({
  id,
  content,
  reasoning,
  rawStream,
  hasStreamUi,
  snapshot,
  status,
  error,
  onRuntimeError
}: AssistantMessageProps) {
  return (
    <MessagePrimitive.Root className="chat-row assistant">
      <div className="avatar" aria-hidden="true">
        S
      </div>
      <div className="assistant-stack">
        <ReasoningPanel
          reasoning={reasoning}
          isStreaming={status === "streaming"}
        />
        <AssistantTextBubble
          content={content}
          error={error}
        />
        {hasStreamUi && snapshot ? (
          <AssistantPreviewBubble
            id={id}
            snapshot={snapshot}
            onRuntimeError={onRuntimeError}
          />
        ) : null}
        <RawStreamPanel raw={rawStream} />
      </div>
    </MessagePrimitive.Root>
  );
}
