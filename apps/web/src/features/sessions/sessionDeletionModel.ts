export type DeletableSession = {
  id: string;
  title: string;
};

export function sessionDeletionPrompt(session: DeletableSession): string {
  const title = session.title.trim() || "Untitled session";
  return `Delete “${title}”? This cannot be undone.`;
}

export function requestSessionDeletion(
  session: DeletableSession,
  confirmDelete: (message: string) => boolean,
  deleteSession: (sessionId: string) => void
): boolean {
  if (!confirmDelete(sessionDeletionPrompt(session))) {
    return false;
  }
  deleteSession(session.id);
  return true;
}
