import { useEffect, useState } from "react";

type ThinkingPanelProps = {
  reasoning?: string;
  isStreaming: boolean;
};

export function ThinkingPanel({ reasoning = "", isStreaming }: ThinkingPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasReasoning = reasoning.trim().length > 0;

  useEffect(() => {
    if (isStreaming) {
      setIsOpen(true);
      return;
    }

    setIsOpen(false);
  }, [isStreaming]);

  if (!hasReasoning && !isStreaming) {
    return null;
  }

  return (
    <details
      className={`thinking-panel ${isStreaming ? "streaming" : "complete"}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{isStreaming ? "Thinking" : "Thoughts"}</span>
        <span>{hasReasoning ? `${reasoning.length.toLocaleString()} chars` : "waiting"}</span>
      </summary>
      <pre>{hasReasoning ? reasoning : "Waiting for reasoning tokens..."}</pre>
    </details>
  );
}
