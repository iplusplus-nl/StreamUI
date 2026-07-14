import {
  compactEmptySessions,
  isSessionEmpty,
  sortSessions,
  type ChatSession,
  type SessionState
} from "../../domain/chat/sessionModel";

export type SessionUpdater = (session: ChatSession) => ChatSession;

export function updateSessionByIdInState(
  state: SessionState,
  sessionId: string,
  updater: SessionUpdater
): SessionState {
  let didUpdate = false;
  const sessions = state.sessions.map((session) => {
    if (session.id !== sessionId) {
      return session;
    }

    didUpdate = true;
    return updater(session);
  });

  return didUpdate
    ? {
        ...state,
        sessions: sortSessions(sessions)
      }
    : state;
}

export function updateActiveSessionInState(
  state: SessionState,
  updater: SessionUpdater
): SessionState {
  return updateSessionByIdInState(state, state.activeSessionId, updater);
}

export type NewSessionResult = {
  state: SessionState;
  transientEmptySessionId: string;
  outcome: "created" | "reused";
};

export function createNewSessionState(
  state: SessionState,
  createSession: () => ChatSession,
  protectedEmptySessionIds: Iterable<string> = []
): NewSessionResult {
  const protectedIds = new Set(protectedEmptySessionIds);
  const compacted = compactEmptySessions(state, {
    preserveActiveEmpty: true,
    preserveEmptySessionIds: protectedIds
  });
  const active = compacted.sessions.find(
    (session) => session.id === compacted.activeSessionId
  );
  if (
    active &&
    isSessionEmpty(active) &&
    !protectedIds.has(active.id)
  ) {
    return {
      state: compacted,
      transientEmptySessionId: active.id,
      outcome: "reused"
    };
  }

  const session = createSession();
  return {
    state: {
      sessions: [session, ...compacted.sessions],
      activeSessionId: session.id
    },
    transientEmptySessionId: session.id,
    outcome: "created"
  };
}

export type SelectSessionResult = {
  state: SessionState;
  targetFound: boolean;
};

export function selectSessionInState(
  state: SessionState,
  sessionId: string,
  protectedEmptySessionIds: Iterable<string> = []
): SelectSessionResult {
  const target = state.sessions.find((session) => session.id === sessionId);
  if (!target) {
    return { state, targetFound: false };
  }

  return {
    state: compactEmptySessions(
      {
        ...state,
        activeSessionId: sessionId
      },
      {
        preserveActiveEmpty: isSessionEmpty(target),
        preserveEmptySessionIds: protectedEmptySessionIds
      }
    ),
    targetFound: true
  };
}

export function deleteSessionInState(
  state: SessionState,
  sessionId: string,
  createSession: () => ChatSession,
  protectedEmptySessionIds: Iterable<string> = []
): SessionState {
  const remaining = state.sessions.filter((session) => session.id !== sessionId);
  if (!remaining.length) {
    const session = createSession();
    return {
      sessions: [session],
      activeSessionId: session.id
    };
  }

  const activeSessionId =
    state.activeSessionId === sessionId
      ? remaining[0].id
      : state.activeSessionId;

  return compactEmptySessions(
    {
      sessions: remaining,
      activeSessionId
    },
    {
      preserveActiveEmpty: remaining.some(
        (session) =>
          session.id === activeSessionId && isSessionEmpty(session)
      ),
      preserveEmptySessionIds: protectedEmptySessionIds
    }
  );
}
