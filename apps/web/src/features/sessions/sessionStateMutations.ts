import {
  sortSessions,
  summarizeSession,
  type ClientMessage,
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

export function updateMessageByIdInState(
  state: SessionState,
  messageId: string,
  updater: (message: ClientMessage) => ClientMessage,
  now = Date.now()
): SessionState {
  let didUpdate = false;
  const sessions = state.sessions.map((session) => {
    let sessionChanged = false;
    const messages = session.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }

      const next = updater(message);
      if (next === message) {
        return message;
      }
      didUpdate = true;
      sessionChanged = true;
      return next;
    });

    return sessionChanged
      ? {
          ...session,
          title: summarizeSession(messages),
          updatedAt: now,
          messages
        }
      : session;
  });

  return didUpdate
    ? {
        ...state,
        sessions: sortSessions(sessions)
      }
    : state;
}
