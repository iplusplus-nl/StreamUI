import {
  compactEmptySessions,
  filterDeletedSessionState,
  isSessionEmpty,
  sortSessions
} from "./sessionLifecycle";
import type {
  ArtifactEdit,
  ChatSession,
  ClientMessage,
  SessionState
} from "./sessionTypes";

function latestStreamingAssistant(
  session: ChatSession | undefined
): ClientMessage | undefined {
  if (!session) {
    return undefined;
  }

  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === "assistant" && message.status === "streaming") {
      return message;
    }
  }

  return undefined;
}

function matchingServerMessage(
  serverSession: ChatSession | undefined,
  localMessage: ClientMessage
): ClientMessage | undefined {
  if (!serverSession) {
    return undefined;
  }

  return serverSession.messages.find(
    (message) =>
      message.id === localMessage.id ||
      (Boolean(localMessage.generationRunId) &&
        message.generationRunId === localMessage.generationRunId)
  );
}

function shouldPreserveLocalStreamingSession(
  currentSession: ChatSession | undefined,
  serverSession: ChatSession | undefined
): boolean {
  const localStreaming = latestStreamingAssistant(currentSession);
  if (!currentSession || !localStreaming) {
    return false;
  }

  const serverMessage = matchingServerMessage(serverSession, localStreaming);
  return serverMessage?.status !== "complete" && serverMessage?.status !== "error";
}

function hasArtifactEditState(message: ClientMessage): boolean {
  return (
    message.role === "assistant" &&
    (Boolean(message.artifactEditBaseRawStream) ||
      Boolean(message.artifactEdits?.length) ||
      Boolean(message.activeArtifactEditId))
  );
}

function hasPendingArtifactEditState(message: ClientMessage): boolean {
  return Boolean(
    message.artifactEdits?.some(
      (edit) =>
        edit.status === "pending" ||
        edit.variants.some((variant) => variant.status === "pending")
    )
  );
}

function hasCompletedArtifactEditVariant(edit: ArtifactEdit): boolean {
  return edit.variants.some(
    (variant) => variant.status === "complete" && Boolean(variant.rawStream)
  );
}

function hasLocalArtifactEditProgress(
  currentSession: ChatSession,
  serverSession: ChatSession
): boolean {
  for (const currentMessage of currentSession.messages) {
    if (!hasArtifactEditState(currentMessage)) {
      continue;
    }

    const serverMessage = serverSession.messages.find(
      (message) => message.id === currentMessage.id
    );
    if (!serverMessage || !hasArtifactEditState(serverMessage)) {
      return true;
    }

    const serverEditIds = new Set(
      (serverMessage.artifactEdits ?? []).map((edit) => edit.id)
    );
    for (const edit of currentMessage.artifactEdits ?? []) {
      if (!serverEditIds.has(edit.id)) {
        return true;
      }

      const serverEdit = serverMessage.artifactEdits?.find(
        (candidate) => candidate.id === edit.id
      );
      if (
        hasCompletedArtifactEditVariant(edit) &&
        !serverEdit?.variants.some(
          (variant) =>
            variant.status === "complete" && Boolean(variant.rawStream)
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function shouldPreserveLocalArtifactEditSession(
  currentSession: ChatSession,
  serverSession: ChatSession
): boolean {
  const hasLocalArtifactEdits = currentSession.messages.some(hasArtifactEditState);
  if (!hasLocalArtifactEdits) {
    return false;
  }

  const hasPendingEdit = currentSession.messages.some(hasPendingArtifactEditState);
  if (hasPendingEdit) {
    return currentSession.updatedAt >= serverSession.updatedAt;
  }

  if (
    currentSession.updatedAt >= serverSession.updatedAt &&
    hasLocalArtifactEditProgress(currentSession, serverSession)
  ) {
    return true;
  }

  return currentSession.updatedAt > serverSession.updatedAt;
}

function preserveLocalArtifactEditSessions(
  current: SessionState,
  serverState: SessionState
): SessionState {
  const currentSessions = new Map(
    current.sessions.map((session) => [session.id, session])
  );
  let didPreserve = false;
  const sessions = serverState.sessions.map((serverSession) => {
    const currentSession = currentSessions.get(serverSession.id);
    if (
      currentSession &&
      shouldPreserveLocalArtifactEditSession(currentSession, serverSession)
    ) {
      didPreserve = true;
      return currentSession;
    }

    return serverSession;
  });

  return didPreserve
    ? {
        ...serverState,
        sessions: sortSessions(sessions)
      }
    : serverState;
}

export function mergeSyncedSessionState(
  current: SessionState,
  serverState: SessionState,
  deletedSessionIds: Iterable<string> = [],
  protectedEmptySessionIds: Iterable<string> = []
): SessionState {
  const deletedIds = new Set(deletedSessionIds);
  const protectedIds = new Set(protectedEmptySessionIds);
  const protectedEmptySessions = current.sessions.filter(
    (session) =>
      protectedIds.has(session.id) &&
      !deletedIds.has(session.id) &&
      isSessionEmpty(session)
  );
  const preserveProtectedEmptySessions = (next: SessionState): SessionState => {
    const sessionsById = new Map(
      next.sessions.map((session) => [session.id, session])
    );
    for (const session of protectedEmptySessions) {
      if (!sessionsById.has(session.id)) {
        sessionsById.set(session.id, session);
      }
    }

    const activeSessionId =
      protectedIds.has(current.activeSessionId) &&
      sessionsById.has(current.activeSessionId)
        ? current.activeSessionId
        : next.activeSessionId;
    const activeSession = sessionsById.get(activeSessionId);

    return compactEmptySessions(
      {
        sessions: Array.from(sessionsById.values()),
        activeSessionId
      },
      {
        preserveActiveEmpty: Boolean(
          activeSession && isSessionEmpty(activeSession)
        ),
        preserveEmptySessionIds: protectedIds
      }
    );
  };

  current = filterDeletedSessionState(current, deletedSessionIds);
  serverState = filterDeletedSessionState(
    serverState,
    deletedSessionIds,
    current
  );

  const currentActive = current.sessions.find(
    (session) => session.id === current.activeSessionId
  );
  const serverActive = serverState.sessions.find(
    (session) => session.id === current.activeSessionId
  );

  if (
    currentActive &&
    shouldPreserveLocalStreamingSession(currentActive, serverActive)
  ) {
    const activeId = currentActive.id;
    return preserveProtectedEmptySessions(
      compactEmptySessions({
        sessions: sortSessions([
          currentActive,
          ...serverState.sessions.filter((session) => session.id !== activeId)
        ]),
        activeSessionId: activeId
      })
    );
  }

  if (
    currentActive &&
    isSessionEmpty(currentActive) &&
    (!serverActive || isSessionEmpty(serverActive))
  ) {
    const activeId = currentActive.id;
    return preserveProtectedEmptySessions(
      compactEmptySessions(
        {
          sessions: [
            currentActive,
            ...serverState.sessions.filter(
              (session) => session.id !== activeId
            )
          ],
          activeSessionId: activeId
        },
        { preserveActiveEmpty: true }
      )
    );
  }

  const activeSessionId = serverState.sessions.some(
    (session) => session.id === current.activeSessionId
  )
    ? current.activeSessionId
    : serverState.activeSessionId;

  const mergedServerState = preserveLocalArtifactEditSessions(current, serverState);

  return preserveProtectedEmptySessions(
    compactEmptySessions({
      ...mergedServerState,
      activeSessionId
    })
  );
}
