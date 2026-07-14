import type { SessionSaveStatus } from "../features/sessions/sessionSaveCoordinator";

type SessionPersistenceStatusProps = {
  saveStatus: SessionSaveStatus;
  syncError: string | null;
  onRetry(): void;
};

export function SessionPersistenceStatus({
  saveStatus,
  syncError,
  onRetry
}: SessionPersistenceStatusProps) {
  const hasError = Boolean(syncError) || saveStatus === "failed";
  if (hasError) {
    return (
      <div className="session-persistence-status is-error" role="alert">
        <span>
          {syncError ?? "Changes could not be saved. Keep this page open."}
        </span>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  if (saveStatus === "pending" || saveStatus === "saving") {
    return (
      <div className="session-persistence-status" role="status">
        Saving…
      </div>
    );
  }

  if (saveStatus === "saved") {
    return (
      <div className="session-persistence-status" role="status">
        Saved
      </div>
    );
  }

  return null;
}
