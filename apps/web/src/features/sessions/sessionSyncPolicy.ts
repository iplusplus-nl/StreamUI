import {
  filterDeletedSessionState,
  hasPersistedMessages,
  isSessionEmpty,
  mergeSyncedSessionState,
  type SessionState
} from "../../domain/chat/sessionModel";
import { serializeSessionStateForSave } from "./sessionPersistence";

export type ResolveInitialSessionStateInput = {
  current: SessionState;
  serverState: SessionState;
  legacyState: SessionState | null;
  deletedSessionIds?: Iterable<string>;
  transientEmptySessionId?: string | null;
};

export function resolveInitialSessionState({
  current,
  serverState,
  legacyState,
  deletedSessionIds = [],
  transientEmptySessionId
}: ResolveInitialSessionStateInput): SessionState {
  const deletedIds = Array.from(deletedSessionIds);
  const loadedState =
    !hasPersistedMessages(serverState) &&
    legacyState &&
    hasPersistedMessages(legacyState)
      ? legacyState
      : serverState;
  const filteredLoadedState = filterDeletedSessionState(
    loadedState,
    deletedIds,
    current
  );
  const active = current.sessions.find(
    (session) => session.id === current.activeSessionId
  );

  return transientEmptySessionId &&
    active?.id === transientEmptySessionId &&
    isSessionEmpty(active)
    ? mergeSyncedSessionState(current, filteredLoadedState, deletedIds)
    : filteredLoadedState;
}

export type ShouldRequestSessionSyncInput = {
  state: SessionState;
  transientEmptySessionId?: string | null;
  hasActiveRuns?: boolean;
  hasRecentCancellations?: boolean;
  hasAttachmentDrafts?: boolean;
};

export function shouldRequestSessionSync({
  state,
  transientEmptySessionId,
  hasActiveRuns = false,
  hasRecentCancellations = false,
  hasAttachmentDrafts = false
}: ShouldRequestSessionSyncInput): boolean {
  if (hasActiveRuns || hasRecentCancellations || hasAttachmentDrafts) {
    return false;
  }

  const active = state.sessions.find(
    (session) => session.id === state.activeSessionId
  );

  return !(
    transientEmptySessionId &&
    active?.id === transientEmptySessionId &&
    isSessionEmpty(active)
  );
}

export type MergePolledSessionStateInput = {
  current: SessionState;
  serverState: SessionState;
  clientId: string;
  deletedSessionIds?: Iterable<string>;
};

export function mergePolledSessionState({
  current,
  serverState,
  clientId,
  deletedSessionIds = []
}: MergePolledSessionStateInput): SessionState {
  const deletedIds = Array.from(deletedSessionIds);
  const next = mergeSyncedSessionState(current, serverState, deletedIds);
  const currentPayload = serializeSessionStateForSave(
    current,
    clientId,
    deletedIds
  );
  const nextPayload = serializeSessionStateForSave(next, clientId, deletedIds);

  return currentPayload === nextPayload ? current : next;
}
