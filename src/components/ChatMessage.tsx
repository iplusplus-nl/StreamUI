import type { ReactNode } from "react";

type ChatMessageProps = {
  role: "user" | "assistant";
  children: ReactNode;
};

export function ChatMessage({ role, children }: ChatMessageProps) {
  return (
    <article className={`chat-row ${role}`}>
      <div className="avatar" aria-hidden="true">
        {role === "user" ? "U" : "S"}
      </div>
      <div className={`message-bubble ${role}`}>{children}</div>
    </article>
  );
}
