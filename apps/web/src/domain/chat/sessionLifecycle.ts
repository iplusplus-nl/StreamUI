import {
  normalizeUiComplexity,
  type ReasoningEffort
} from "../../core/apiSettings";
import { isBugReportDraftEmpty } from "./bugReportPersistence";
import type {
  BugReportDraft,
  ChatSession,
  ClientMessage,
  SessionState
} from "./sessionTypes";

export const initialMessages: ClientMessage[] = [];
export const UNTITLED_SESSION = "New Session";
export const STREAM_INTERRUPTED_ERROR =
  "The stream was interrupted before it completed.";

export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptySession(
  now = Date.now(),
  id = createId("session"),
  model?: string,
  reasoningEffort?: ReasoningEffort,
  uiComplexity?: number
): ChatSession {
  return {
    id,
    title: UNTITLED_SESSION,
    createdAt: now,
    updatedAt: now,
    model: model?.trim() || undefined,
    reasoningEffort,
    uiComplexity:
      typeof uiComplexity === "number"
        ? normalizeUiComplexity(uiComplexity)
        : undefined,
    messages: initialMessages,
    files: []
  };
}

export function createInitialSessionState(
  now = Date.now(),
  id = createId("session"),
  model?: string,
  reasoningEffort?: ReasoningEffort,
  uiComplexity?: number
): SessionState {
  const session = createEmptySession(
    now,
    id,
    model,
    reasoningEffort,
    uiComplexity
  );
  return { sessions: [session], activeSessionId: session.id };
}

export function isSessionEmpty(
  session: Pick<ChatSession, "messages" | "files"> & {
    bugReportDraft?: BugReportDraft;
  }
): boolean {
  return (
    session.messages.length === 0 &&
    session.files.length === 0 &&
    isBugReportDraftEmpty(session.bugReportDraft)
  );
}

export function getSessionStreamingRunIds(
  session: Pick<ChatSession, "messages"> | undefined
): string[] {
  if (!session) {
    return [];
  }

  const runIds = new Set<string>();
  for (const message of session.messages) {
    if (
      message.role !== "assistant" ||
      message.status !== "streaming" ||
      !message.generationRunId
    ) {
      continue;
    }

    runIds.add(message.generationRunId);
  }

  return Array.from(runIds);
}

export function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function compactEmptySessions(
  state: SessionState,
  options: {
    preserveActiveEmpty?: boolean;
    preserveEmptySessionIds?: Iterable<string>;
  } = {}
): SessionState {
  const activeSession = state.sessions.find(
    (session) => session.id === state.activeSessionId
  );
  const preservedEmptyIds = new Set(options.preserveEmptySessionIds ?? []);
  const nonEmptySessions = state.sessions.filter(
    (session) => !isSessionEmpty(session)
  );
  const preservedEmptySessions = state.sessions.filter(
    (session) =>
      isSessionEmpty(session) &&
      (preservedEmptyIds.has(session.id) ||
        (options.preserveActiveEmpty && session.id === activeSession?.id))
  );

  if (!nonEmptySessions.length) {
    const fallback = activeSession ?? state.sessions[0];
    if (!fallback) {
      return createInitialSessionState();
    }

    const sessions = sortSessions(
      preservedEmptySessions.length ? preservedEmptySessions : [fallback]
    );
    return {
      sessions,
      activeSessionId: sessions.some(
        (session) => session.id === state.activeSessionId
      )
        ? state.activeSessionId
        : sessions[0].id
    };
  }

  const sessionsById = new Map<string, ChatSession>();
  for (const session of preservedEmptySessions) {
    sessionsById.set(session.id, session);
  }
  for (const session of nonEmptySessions) {
    sessionsById.set(session.id, session);
  }

  const sessions = sortSessions(Array.from(sessionsById.values()));
  const activeSessionId = sessions.some(
    (session) => session.id === state.activeSessionId
  )
    ? state.activeSessionId
    : sessions[0].id;

  return {
    sessions,
    activeSessionId
  };
}

function normalizedDeletedSessionIdSet(
  deletedSessionIds: Iterable<string> = []
): Set<string> {
  const ids = new Set<string>();
  for (const id of deletedSessionIds) {
    const value = id.trim();
    if (value) {
      ids.add(value);
    }
  }
  return ids;
}

export function filterDeletedSessionState(
  state: SessionState,
  deletedSessionIds: Iterable<string> = [],
  fallbackState?: SessionState
): SessionState {
  const deleted = normalizedDeletedSessionIdSet(deletedSessionIds);
  if (!deleted.size) {
    return state;
  }

  const filterState = (candidate: SessionState): SessionState | null => {
    const sessions = candidate.sessions.filter(
      (session) => !deleted.has(session.id)
    );
    if (!sessions.length) {
      return null;
    }

    const activeSessionId = sessions.some(
      (session) => session.id === candidate.activeSessionId
    )
      ? candidate.activeSessionId
      : sessions[0].id;
    const activeSession = sessions.find(
      (session) => session.id === activeSessionId
    );

    return compactEmptySessions(
      {
        sessions,
        activeSessionId
      },
      { preserveActiveEmpty: Boolean(activeSession && isSessionEmpty(activeSession)) }
    );
  };

  const filtered = filterState(state);
  if (filtered) {
    return filtered;
  }

  if (fallbackState) {
    const fallback = filterState(fallbackState);
    if (fallback) {
      return fallback;
    }
  }

  return createInitialSessionState();
}

export function hasPersistedMessages(state: SessionState): boolean {
  return state.sessions.some((session) => session.messages.length > 0);
}
