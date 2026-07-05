import { useEffect, useState } from "react";

type ReasoningPanelProps = {
  reasoning?: string;
  isStreaming: boolean;
};

function stripSyntheticReasoningStatus(value: string): string {
  return value.replace(/^Generating\.\.\.\s*/i, "");
}

export function ReasoningPanel({
  reasoning = "",
  isStreaming
}: ReasoningPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const visibleReasoning = stripSyntheticReasoningStatus(reasoning);
  const hasReasoning = visibleReasoning.trim().length > 0;
  const showStatusOnly = isStreaming && !hasReasoning;

  useEffect(() => {
    if (isStreaming) {
      const start = Date.now();
      setStartedAt(start);
      setElapsedMs(0);
      setIsOpen(true);
      const interval = window.setInterval(() => {
        setElapsedMs(Date.now() - start);
      }, 500);

      return () => window.clearInterval(interval);
    }
  }, [isStreaming]);

  useEffect(() => {
    if (isStreaming) {
      return;
    }

    if (startedAt) {
      setElapsedMs(Date.now() - startedAt);
    }
    setIsOpen(false);
  }, [isStreaming, startedAt]);

  if (!hasReasoning && !showStatusOnly) {
    return null;
  }

  const durationSeconds =
    startedAt || elapsedMs > 0 ? Math.max(1, Math.round(elapsedMs / 1000)) : null;
  const label = showStatusOnly
    ? "Generating..."
    : isStreaming
      ? "Reasoning"
    : durationSeconds
      ? `Reasoned for ${durationSeconds}s`
      : "Reasoning";

  return (
    <details
      className={`reasoning-panel ${isStreaming ? "is-streaming" : "is-complete"} ${
        showStatusOnly ? "is-status-only" : ""
      }`}
      open={!showStatusOnly && isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="reasoning-trigger">
        <span className="reasoning-mark" aria-hidden="true" />
        <span className="reasoning-label">{label}</span>
        {!showStatusOnly ? (
          <span className="reasoning-chevron" aria-hidden="true" />
        ) : null}
      </summary>
      {!showStatusOnly ? (
        <div className="reasoning-content" aria-busy={isStreaming}>
          <pre className="reasoning-text">
            {visibleReasoning}
          </pre>
        </div>
      ) : null}
    </details>
  );
}
