import { MessagePrimitive } from "@assistant-ui/react";
import type { ReactNode } from "react";
import type { ImageAttachment } from "../core/imageAttachments";

type ChatMessageProps = {
  role: "user" | "assistant";
  attachments?: ImageAttachment[];
  children: ReactNode;
};

export function ChatMessage({
  role,
  attachments = [],
  children
}: ChatMessageProps) {
  return (
    <MessagePrimitive.Root className={`chat-row ${role}`}>
      <div className="avatar" aria-hidden="true">
        {role === "user" ? "U" : "S"}
      </div>
      <div className={`message-bubble ${role}`}>
        {children ? <p>{children}</p> : null}
        {attachments.length > 0 ? (
          <div className="message-attachments" aria-label="Attached images">
            {attachments.map((attachment) => (
              <img
                key={attachment.id}
                src={attachment.dataUrl}
                alt={attachment.name}
                loading="lazy"
              />
            ))}
          </div>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}
