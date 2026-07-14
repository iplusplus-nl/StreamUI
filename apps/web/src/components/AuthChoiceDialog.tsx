import { Laptop, LogIn, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  isDirectOverlayInteraction,
  isEscapeDismissKey
} from "./dismissalModel";

export type AuthChoiceDialogProps = {
  themeMode: "day" | "night";
  onClose(): void;
  onSignIn(): void;
  onContinueLocal(): void;
};

export function AuthChoiceDialogContent({
  onClose,
  onSignIn,
  onContinueLocal
}: Omit<AuthChoiceDialogProps, "themeMode">) {
  return (
    <section
      className="auth-choice-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-choice-title"
      aria-describedby="auth-choice-description"
    >
      <button
        className="auth-choice-close"
        type="button"
        aria-label="Close sign-in options"
        onClick={onClose}
      >
        <X size={18} strokeWidth={2} aria-hidden="true" />
      </button>

      <div className="auth-choice-mark" aria-hidden="true">
        CH
      </div>
      <div className="auth-choice-heading">
        <h2 id="auth-choice-title">Choose how to use ChatHTML</h2>
        <p id="auth-choice-description">
          Sign in for the managed service, or keep everything local and connect
          your own model provider.
        </p>
      </div>

      <div className="auth-choice-actions">
        <button
          className="auth-choice-primary"
          type="button"
          onClick={onSignIn}
        >
          <LogIn size={17} strokeWidth={2} aria-hidden="true" />
          <span>Sign in</span>
        </button>
        <button
          className="auth-choice-secondary"
          type="button"
          onClick={onContinueLocal}
        >
          <Laptop size={17} strokeWidth={2} aria-hidden="true" />
          <span>Continue locally</span>
        </button>
      </div>

      <p className="auth-choice-footnote">
        Local mode stays signed out. You can add an OpenRouter, OpenAI, local,
        or custom API connection next.
      </p>
    </section>
  );
}

export function AuthChoiceDialog({
  themeMode,
  onClose,
  onSignIn,
  onContinueLocal
}: AuthChoiceDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isEscapeDismissKey(event.key)) {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="auth-choice-overlay"
      data-theme={themeMode}
      role="presentation"
      onPointerDown={(event) => {
        if (isDirectOverlayInteraction(event.target, event.currentTarget)) {
          onClose();
        }
      }}
    >
      <AuthChoiceDialogContent
        onClose={onClose}
        onSignIn={onSignIn}
        onContinueLocal={onContinueLocal}
      />
    </div>,
    document.body
  );
}
