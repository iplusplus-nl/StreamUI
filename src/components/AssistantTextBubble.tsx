type AssistantTextBubbleProps = {
  content: string;
  error?: string;
  isStreaming?: boolean;
};

export function AssistantTextBubble({
  content,
  error,
  isStreaming
}: AssistantTextBubbleProps) {
  if (!content && !error && !isStreaming) {
    return null;
  }

  return (
    <div className="message-bubble assistant">
      {content ? <p>{content}</p> : <p className="muted">Thinking...</p>}
      {error ? <pre className="inline-error">{error}</pre> : null}
    </div>
  );
}
