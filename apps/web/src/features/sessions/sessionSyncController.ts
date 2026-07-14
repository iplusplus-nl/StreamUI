import {
  normalizeStoredSessionState,
  type SessionState
} from "../../domain/chat/sessionModel";
import { requestSessions as requestSessionState } from "./sessionApi";
import { loadLegacyLocalSessionState } from "./sessionPersistence";
import {
  mergePolledSessionState,
  resolveInitialSessionState,
  shouldRequestSessionSync
} from "./sessionSyncPolicy";

export type SessionStateUpdater = (
  updater: (current: SessionState) => SessionState
) => void;

export type SessionSyncOutcome = "applied" | "cancelled" | "skipped";

export type SessionSyncDependencies = {
  requestSessions(clientId: string): Promise<Response>;
  normalizeServerState(payload: unknown, now: number): SessionState;
  loadLegacyState(): SessionState | null;
  now(): number;
};

const defaultDependencies: SessionSyncDependencies = {
  requestSessions: requestSessionState,
  normalizeServerState: (payload, now) =>
    normalizeStoredSessionState(payload, now, {
      rebuildSnapshots: false,
      interruptPendingArtifactEdits: true
    }),
  loadLegacyState: loadLegacyLocalSessionState,
  now: Date.now
};

function resolveDependencies(
  overrides?: Partial<SessionSyncDependencies>
): SessionSyncDependencies {
  return { ...defaultDependencies, ...overrides };
}

export type InitialSessionLoadInput = {
  clientId: string;
  isCancelled(): boolean;
  updateState: SessionStateUpdater;
  onApplied?(): void;
  getDeletedSessionIds(): Iterable<string>;
  getTransientEmptySessionId(): string | null;
  getProtectedEmptySessionIds?(): Iterable<string>;
  hasActiveRuns?(): boolean;
  hasRecentCancellations?(): boolean;
  hasAttachmentDrafts?(): boolean;
};

function hasConcurrentSessionWork(input: {
  hasActiveRuns?(): boolean;
  hasRecentCancellations?(): boolean;
  hasAttachmentDrafts?(): boolean;
}): boolean {
  return Boolean(
    input.hasActiveRuns?.() ||
      input.hasRecentCancellations?.() ||
      input.hasAttachmentDrafts?.()
  );
}

export async function runInitialSessionLoad(
  input: InitialSessionLoadInput,
  dependencyOverrides?: Partial<SessionSyncDependencies>
): Promise<SessionSyncOutcome> {
  const dependencies = resolveDependencies(dependencyOverrides);
  const response = await dependencies.requestSessions(input.clientId);
  if (!response.ok) {
    throw new Error(`Session load failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (input.isCancelled()) {
    return "cancelled";
  }
  if (hasConcurrentSessionWork(input)) {
    return "skipped";
  }

  const serverState = dependencies.normalizeServerState(
    payload,
    dependencies.now()
  );
  const legacyState = dependencies.loadLegacyState();
  input.updateState((current) =>
    resolveInitialSessionState({
      current,
      serverState,
      legacyState,
      deletedSessionIds: input.getDeletedSessionIds(),
      transientEmptySessionId: input.getTransientEmptySessionId(),
      protectedEmptySessionIds: input.getProtectedEmptySessionIds?.()
    })
  );
  input.onApplied?.();

  return "applied";
}

export type SingleFlightSessionPoll = {
  trigger(): void;
  cancel(): void;
};

/** Coalesces interval ticks while one poll is in flight. */
export function createSingleFlightSessionPoll(
  task: () => Promise<void>,
  onError: (error: unknown) => void
): SingleFlightSessionPoll {
  let active = false;
  let queued = false;
  let cancelled = false;

  const run = () => {
    if (cancelled) {
      return;
    }
    active = true;
    void Promise.resolve()
      .then(task)
      .catch((error) => {
        if (!cancelled) {
          onError(error);
        }
      })
      .finally(() => {
        active = false;
        if (!cancelled && queued) {
          queued = false;
          run();
        }
      });
  };

  return {
    trigger() {
      if (cancelled) {
        return;
      }
      if (active) {
        queued = true;
        return;
      }
      run();
    },
    cancel() {
      cancelled = true;
      queued = false;
    }
  };
}

export type PollSessionStateInput = {
  clientId: string;
  isCancelled(): boolean;
  getState(): SessionState;
  updateState: SessionStateUpdater;
  onApplied?(): void;
  getDeletedSessionIds(): Iterable<string>;
  getTransientEmptySessionId(): string | null;
  getProtectedEmptySessionIds?(): Iterable<string>;
  hasActiveRuns(): boolean;
  hasRecentCancellations(): boolean;
  hasAttachmentDrafts?(): boolean;
};

export async function runSessionPoll(
  input: PollSessionStateInput,
  dependencyOverrides?: Partial<SessionSyncDependencies>
): Promise<SessionSyncOutcome> {
  const currentState = input.getState();
  if (
    !shouldRequestSessionSync({
      state: currentState,
      transientEmptySessionId: input.getTransientEmptySessionId(),
      hasActiveRuns: input.hasActiveRuns(),
      hasRecentCancellations: input.hasRecentCancellations(),
      hasAttachmentDrafts: input.hasAttachmentDrafts?.() ?? false
    })
  ) {
    return "skipped";
  }

  const dependencies = resolveDependencies(dependencyOverrides);
  const response = await dependencies.requestSessions(input.clientId);
  if (!response.ok) {
    throw new Error(`Session sync failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (input.isCancelled()) {
    return "cancelled";
  }
  if (
    !shouldRequestSessionSync({
      state: input.getState(),
      transientEmptySessionId: input.getTransientEmptySessionId(),
      hasActiveRuns: input.hasActiveRuns(),
      hasRecentCancellations: input.hasRecentCancellations(),
      hasAttachmentDrafts: input.hasAttachmentDrafts?.() ?? false
    })
  ) {
    return "skipped";
  }

  const serverState = dependencies.normalizeServerState(
    payload,
    dependencies.now()
  );

  input.updateState((current) =>
    mergePolledSessionState({
      current,
      serverState,
      clientId: input.clientId,
      deletedSessionIds: input.getDeletedSessionIds(),
      protectedEmptySessionIds: input.getProtectedEmptySessionIds?.()
    })
  );
  input.onApplied?.();

  return "applied";
}
