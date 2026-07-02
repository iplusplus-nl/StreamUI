type AssistantTextBubbleProps = {
  content: string;
  error?: string;
};

export function AssistantTextBubble({
  content,
  error
}: AssistantTextBubbleProps) {
  if (!content && !error) {
    return null;
  }

  return (
    <div className="message-bubble assistant">
      {content ? <p>{content}</p> : null}
      {error ? <pre className="inline-error">{error}</pre> : null}
    </div>
  );
}
