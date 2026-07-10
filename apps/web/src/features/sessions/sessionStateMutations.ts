import {
  sortSessions,
  type SessionFile,
  type SessionState
} from "../../domain/chat/sessionModel";
import { mergeSessionFiles } from "./sessionSelectors";

export function upsertSessionFilesInState(
  state: SessionState,
  sessionId: string,
  files: SessionFile[],
  now = Date.now()
): SessionState {
  if (!files.length) {
    return state;
  }

  let didUpdate = false;
  const sessions = state.sessions.map((session) => {
    if (session.id !== sessionId) {
      return session;
    }

    didUpdate = true;
    return {
      ...session,
      updatedAt: now,
      files: mergeSessionFiles([...session.files, ...files])
    };
  });

  return didUpdate
    ? {
        ...state,
        sessions: sortSessions(sessions)
      }
    : state;
}
