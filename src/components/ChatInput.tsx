import { FormEvent, KeyboardEvent, useRef, useState } from "react";

type ChatInputProps = {
  isSending: boolean;
  onSend(message: string): void;
};

export function ChatInput({ isSending, onSend }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = () => {
    const nextValue = value.trim();
    if (!nextValue || isSending) {
      return;
    }
    onSend(nextValue);
    setValue("");
    textareaRef.current?.focus();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="chat-input-bar" onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder="Ask for a dashboard, explainer, calculator, quiz..."
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        className="send-button"
        type="submit"
        disabled={!value.trim() || isSending}
        aria-label="Send message"
      >
        ↑
      </button>
    </form>
  );
}
