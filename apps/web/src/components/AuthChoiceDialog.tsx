import { Laptop, LogIn, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  isDirectOverlayInteraction,
  isEscapeDismissKey
} from "./dismissalModel";
import { useModalFocusTrap } from "./useModalFocusTrap";

export type AuthChoiceDialogProps = {
  themeMode: "day" | "night";
  onClose(): void;
  onSignIn(): void;
  onContinueLocal(): void;
  required?: boolean;
};

export function AuthChoiceDialogContent({
  onClose,
  onSignIn,
  onContinueLocal,
  required = false
}: Omit<AuthChoiceDialogProps, "themeMode">) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocusTrap({ dialogRef });

  return (
    <section
      ref={dialogRef}
      className="auth-choice-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-choice-title"
      aria-describedby="auth-choice-description"
    >
      {!required ? (
        <button
          className="auth-choice-close"
          type="button"
          aria-label="Close sign-in options"
          onClick={onClose}
        >
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}

      <div className="auth-choice-mark" aria-hidden="true">
        CH
      </div>
      <div className="auth-choice-heading">
        <h2 id="auth-choice-title">Choose how to use ChatHTML</h2>
        <p id="auth-choice-description">
          {required
            ? "Sign in for a private cloud workspace, or connect your own model provider without an account."
            : "Sign in for the managed service, or keep everything local and connect your own model provider."}
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
          <span>Use your own API key</span>
        </button>
      </div>

      <p className="auth-choice-footnote">
        Your key and provider requests stay in this browser and never pass
        through the ChatHTML server. Your browser stores local-mode chats on
        this device.
      </p>
    </section>
  );
}

export function AuthChoiceDialog({
  themeMode,
  onClose,
  onSignIn,
  onContinueLocal,
  required = false
}: AuthChoiceDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (required || !isEscapeDismissKey(event.key)) {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, required]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="auth-choice-overlay"
      data-theme={themeMode}
      role="presentation"
      onPointerDown={(event) => {
        if (
          !required &&
          isDirectOverlayInteraction(event.target, event.currentTarget)
        ) {
          onClose();
        }
      }}
    >
      <AuthChoiceDialogContent
        onClose={onClose}
        onSignIn={onSignIn}
        onContinueLocal={onContinueLocal}
        required={required}
      />
    </div>,
    document.body
  );
}
