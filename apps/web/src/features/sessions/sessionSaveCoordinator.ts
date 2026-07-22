import type { SessionState } from "../../domain/chat/sessionModel";
import {
  saveSerializedSessionState,
  saveSessionStateOnPageExit
} from "./sessionApi";
import {
  advanceSessionSaveRevisionFloor,
  clearLegacyLocalSessions,
  nextSessionSaveRevision,
  serializeSessionStateForSave
} from "./sessionPersistence";

export type SessionSaveSnapshot = {
  clientId: string;
  contentKey: string;
  revision: number;
  serializedState: string;
};

export type SessionSaveSource = {
  isLoaded(): boolean;
  getLatestState(): SessionState;
  getClientId(): string;
  getDeletedSessionIds(): Iterable<string>;
};

export type SessionSaveScheduler = {
  schedule(delayMs: number, task: () => Promise<void>): () => void;
};

export type SessionSaveDependencies = {
  serialize(
    state: SessionState,
    clientId: string,
    deletedSessionIds: string[],
    saveRevision?: number
  ): string;
  nextRevision(clientId: string): number;
  observeRevision(clientId: string, revision: number): void;
  persist(
    serializedState: string,
    clientId: string,
    signal?: AbortSignal
  ): Promise<Response>;
  flush(serializedState: string, clientId: string): void;
  clearLegacy(): void;
  warn(error: unknown): void;
  onStatusChange(status: SessionSaveStatus): void;
  scheduler: SessionSaveScheduler;
  persistTimeoutMs: number;
  createAbortController(): AbortController;
  now(): number;
};

export type SessionSaveOutcome = "saved" | "failed" | "skipped";
export type SessionFlushOutcome = "flushed" | "skipped";
export type SessionSaveStatus =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "failed";

export type SessionSaveCoordinator = {
  scheduleAutosave(stateSnapshot: SessionState, loaded: boolean): () => void;
  cancelAutosave(): void;
  saveNow(): Promise<SessionSaveOutcome>;
  flushPageExit(): SessionFlushOutcome;
  dispose(): void;
  getDebugState(): {
    lastSavedPayload: string | null;
    hasAutosave: boolean;
  };
};

type PreparedSessionSave = {
  state: SessionState;
  clientId: string;
  deletedSessionIds: string[];
  contentKey: string;
};

type SessionSaveOperation = {
  snapshot: SessionSaveSnapshot;
  signal: AbortSignal | undefined;
  promise: Promise<SessionSaveOutcome> | null;
};

type ConfirmedSessionSave = {
  contentKey: string;
  revision: number;
};

type SessionPersistResult = SessionSaveOutcome | "stale";

type AutosaveHandle = {
  snapshot: SessionSaveSnapshot;
  controller: AbortController;
  cancelTimer: (() => void) | null;
};

const defaultDependencies: SessionSaveDependencies = {
  serialize: serializeSessionStateForSave,
  nextRevision: nextSessionSaveRevision,
  observeRevision: advanceSessionSaveRevisionFloor,
  persist: saveSerializedSessionState,
  flush: saveSessionStateOnPageExit,
  clearLegacy: clearLegacyLocalSessions,
  warn: (error) => console.warn("Could not save ChatHTML sessions.", error),
  onStatusChange: () => undefined,
  scheduler: {
    schedule: (delayMs, task) => {
      const timeoutId = window.setTimeout(() => void task(), delayMs);
      return () => window.clearTimeout(timeoutId);
    }
  },
  persistTimeoutMs: 15_000,
  createAbortController: () => new AbortController(),
  now: Date.now
};

const MAX_RATE_LIMIT_RETRIES = 3;
const MIN_RATE_LIMIT_DELAY_MS = 250;
const MAX_RATE_LIMIT_DELAY_MS = 5 * 60_000;

function clampRateLimitDelay(delayMs: number): number {
  return Math.min(
    MAX_RATE_LIMIT_DELAY_MS,
    Math.max(MIN_RATE_LIMIT_DELAY_MS, Math.ceil(delayMs))
  );
}

function retryAfterDelayMs(
  response: Response,
  now: number,
  consecutiveRateLimits: number
): number {
  const retryAfter = response.headers.get("Retry-After")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampRateLimitDelay(seconds * 1_000);
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return clampRateLimitDelay(retryAt - now);
    }
  }

  const rateLimitReset = Number(
    response.headers.get("RateLimit-Reset")?.trim()
  );
  if (Number.isFinite(rateLimitReset) && rateLimitReset > 0) {
    return clampRateLimitDelay(rateLimitReset * 1_000 - now);
  }

  return clampRateLimitDelay(
    1_000 * 2 ** Math.min(Math.max(0, consecutiveRateLimits - 1), 5)
  );
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown })?.name === "AbortError";
}

function validRevision(input: unknown): number | undefined {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0
    ? input
    : undefined;
}

export function createSessionSaveCoordinator(
  source: SessionSaveSource,
  debounceMs: number,
  dependencyOverrides?: Partial<SessionSaveDependencies>
): SessionSaveCoordinator {
  const dependencies: SessionSaveDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides
  };
  const acknowledgedRevisions = new Map<string, number>();
  const lastIssuedRevisions = new Map<string, number>();
  const confirmedSaves = new Map<string, ConfirmedSessionSave>();
  const lastFlushedSaves = new Map<string, ConfirmedSessionSave>();
  const activeOperations = new Set<SessionSaveOperation>();
  let lastSavedPayload: string | null = null;
  let autosave: AutosaveHandle | null = null;
  let persistenceTail: Promise<void> = Promise.resolve();
  let rateLimitedUntil = 0;
  let consecutiveRateLimits = 0;

  const prepareSave = (state: SessionState): PreparedSessionSave => {
    const clientId = source.getClientId();
    const deletedSessionIds = Array.from(source.getDeletedSessionIds());
    return {
      state,
      clientId,
      deletedSessionIds,
      contentKey: dependencies.serialize(state, clientId, deletedSessionIds)
    };
  };

  const latestPreparedSave = (): PreparedSessionSave | null =>
    source.isLoaded() ? prepareSave(source.getLatestState()) : null;

  const issueRevision = (clientId: string): number => {
    const acknowledged = acknowledgedRevisions.get(clientId) ?? 0;
    const lastIssued = lastIssuedRevisions.get(clientId) ?? 0;
    const generated = validRevision(dependencies.nextRevision(clientId)) ?? 1;
    const floor = Math.max(acknowledged, lastIssued);
    const incrementedFloor =
      floor < Number.MAX_SAFE_INTEGER ? floor + 1 : Number.MAX_SAFE_INTEGER;
    const revision = Math.max(generated, incrementedFloor);
    lastIssuedRevisions.set(clientId, revision);
    return revision;
  };

  const createSnapshot = (
    prepared: PreparedSessionSave
  ): SessionSaveSnapshot => {
    const revision = issueRevision(prepared.clientId);
    return {
      clientId: prepared.clientId,
      contentKey: prepared.contentKey,
      revision,
      serializedState: dependencies.serialize(
        prepared.state,
        prepared.clientId,
        prepared.deletedSessionIds,
        revision
      )
    };
  };

  const advanceRevisionFloor = (
    clientId: string,
    revision: number,
    serializedState?: string
  ): void => {
    const acknowledged = acknowledgedRevisions.get(clientId) ?? 0;
    if (revision < acknowledged) {
      return;
    }
    acknowledgedRevisions.set(clientId, revision);
    if (serializedState !== undefined) {
      lastSavedPayload = serializedState;
    }
  };

  const confirmPersisted = (snapshot: SessionSaveSnapshot): void => {
    const acknowledged = acknowledgedRevisions.get(snapshot.clientId) ?? 0;
    if (snapshot.revision < acknowledged) {
      return;
    }

    advanceRevisionFloor(
      snapshot.clientId,
      snapshot.revision,
      snapshot.serializedState
    );
    confirmedSaves.set(snapshot.clientId, {
      contentKey: snapshot.contentKey,
      revision: snapshot.revision
    });
    const flushed = lastFlushedSaves.get(snapshot.clientId);
    if (flushed && flushed.revision <= snapshot.revision) {
      lastFlushedSaves.delete(snapshot.clientId);
    }
  };

  const isConfirmed = (prepared: PreparedSessionSave): boolean => {
    const confirmed = confirmedSaves.get(prepared.clientId);
    return (
      confirmed?.contentKey === prepared.contentKey &&
      confirmed.revision ===
        (acknowledgedRevisions.get(prepared.clientId) ?? 0)
    );
  };

  const latestActiveOperation = (
    clientId: string
  ): SessionSaveOperation | null => {
    const acknowledged = acknowledgedRevisions.get(clientId) ?? 0;
    let latest: SessionSaveOperation | null = null;
    for (const operation of activeOperations) {
      if (
        operation.snapshot.clientId !== clientId ||
        operation.snapshot.revision <= acknowledged ||
        operation.signal?.aborted
      ) {
        continue;
      }
      if (
        !latest ||
        operation.snapshot.revision > latest.snapshot.revision
      ) {
        latest = operation;
      }
    }
    return latest;
  };

  const cancelAutosave = (): void => {
    const current = autosave;
    autosave = null;
    current?.cancelTimer?.();
    current?.controller.abort();
  };

  const requestPersistResponse = async (
    snapshot: SessionSaveSnapshot,
    externalSignal: AbortSignal | undefined
  ): Promise<Response> => {
    const controller = new AbortController();
    let rejectInterruption: ((error: Error) => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const abortRequest = () => {
      controller.abort();
      const error = new Error("Session save was aborted.");
      error.name = "AbortError";
      rejectInterruption?.(error);
    };
    externalSignal?.addEventListener("abort", abortRequest, { once: true });
    if (externalSignal?.aborted) {
      abortRequest();
    }

    let cancelTimeout: () => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        controller.abort();
        const error = new Error(
          `Session save timed out after ${dependencies.persistTimeoutMs}ms.`
        );
        error.name = "SessionSaveTimeoutError";
        reject(error);
      }, Math.max(1, dependencies.persistTimeoutMs));
      cancelTimeout = () => globalThis.clearTimeout(timeoutId);
    });

    try {
      return await Promise.race([
        dependencies.persist(
          snapshot.serializedState,
          snapshot.clientId,
          controller.signal
        ),
        interruption,
        timeout
      ]);
    } finally {
      cancelTimeout();
      externalSignal?.removeEventListener("abort", abortRequest);
    }
  };

  const waitForRateLimitCooldown = (
    signal: AbortSignal | undefined
  ): Promise<void> | null => {
    const delayMs = Math.max(0, rateLimitedUntil - dependencies.now());
    if (delayMs <= 0) {
      return null;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abortWait);
        callback();
      };
      const abortWait = () => {
        cancelTimer();
        const error = new Error("Session save was aborted.");
        error.name = "AbortError";
        finish(() => reject(error));
      };
      const cancelTimer = dependencies.scheduler.schedule(delayMs, async () => {
        finish(resolve);
      });
      signal?.addEventListener("abort", abortWait, { once: true });
      if (signal?.aborted) {
        abortWait();
      }
    });
  };

  const persist = async (
    snapshot: SessionSaveSnapshot,
    signal: AbortSignal | undefined,
    suppressAbortWarning: boolean
  ): Promise<SessionPersistResult> => {
    if (signal?.aborted) {
      return "skipped";
    }
    dependencies.onStatusChange("saving");
    try {
      let response: Response;
      let rateLimitRetries = 0;
      while (true) {
        const cooldown = waitForRateLimitCooldown(signal);
        if (cooldown) {
          await cooldown;
        }
        response = await requestPersistResponse(snapshot, signal);
        if (response.status !== 429) {
          rateLimitedUntil = 0;
          consecutiveRateLimits = 0;
          break;
        }

        consecutiveRateLimits += 1;
        const delayMs = retryAfterDelayMs(
          response,
          dependencies.now(),
          consecutiveRateLimits
        );
        rateLimitedUntil = Math.max(
          rateLimitedUntil,
          dependencies.now() + delayMs
        );
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          throw new Error(
            `Session save failed with HTTP 429 after ${rateLimitRetries + 1} attempts.`
          );
        }
        rateLimitRetries += 1;
      }

      if (!response.ok) {
        throw new Error(`Session save failed with HTTP ${response.status}.`);
      }

      const responseBody = (await response.json().catch(() => null)) as {
        applied?: unknown;
        currentSaveRevision?: unknown;
      } | null;
      if (responseBody?.applied === false) {
        const currentSaveRevision = validRevision(
          responseBody.currentSaveRevision
        );
        if (currentSaveRevision !== undefined) {
          dependencies.observeRevision(snapshot.clientId, currentSaveRevision);
          advanceRevisionFloor(snapshot.clientId, currentSaveRevision);
        }
        dependencies.onStatusChange("failed");
        return "stale";
      }

      confirmPersisted(snapshot);
      dependencies.clearLegacy();
      dependencies.onStatusChange("saved");
      return "saved";
    } catch (error) {
      if (suppressAbortWarning && isAbortError(error)) {
        return "skipped";
      }
      dependencies.warn(error);
      dependencies.onStatusChange("failed");
      return "failed";
    }
  };

  const enqueuePersist = (
    snapshot: SessionSaveSnapshot,
    signal: AbortSignal | undefined,
    suppressAbortWarning: boolean
  ): SessionSaveOperation => {
    const operation: SessionSaveOperation = {
      snapshot,
      signal,
      promise: null
    };
    activeOperations.add(operation);
    const run = async (): Promise<SessionSaveOutcome> => {
      const result = await persist(
        operation.snapshot,
        signal,
        suppressAbortWarning
      );
      return result === "stale" ? "failed" : result;
    };
    const promise = persistenceTail
      .then(run)
      .finally(() => {
        activeOperations.delete(operation);
      });
    operation.promise = promise;
    persistenceTail = promise.then(
      () => undefined,
      () => undefined
    );
    return operation;
  };

  const scheduleAutosave = (
    stateSnapshot: SessionState,
    loaded: boolean
  ): (() => void) => {
    if (!loaded) {
      return () => undefined;
    }

    cancelAutosave();
    const prepared = prepareSave(stateSnapshot);
    lastFlushedSaves.delete(prepared.clientId);
    const active = latestActiveOperation(prepared.clientId);
    if (
      active?.snapshot.contentKey === prepared.contentKey ||
      (!active &&
        isConfirmed(prepared))
    ) {
      if (!active) {
        dependencies.onStatusChange("saved");
      }
      return () => undefined;
    }

    const controller = dependencies.createAbortController();
    const handle: AutosaveHandle = {
      snapshot: createSnapshot(prepared),
      controller,
      cancelTimer: null
    };
    const cancelTimer = dependencies.scheduler.schedule(debounceMs, async () => {
      handle.cancelTimer = null;
      if (controller.signal.aborted) {
        return;
      }

      const operation = enqueuePersist(handle.snapshot, controller.signal, true);
      await operation.promise;
      if (autosave === handle) {
        autosave = null;
      }
    });
    handle.cancelTimer = cancelTimer;
    autosave = handle;
    dependencies.onStatusChange("pending");

    return () => {
      handle.cancelTimer?.();
      handle.cancelTimer = null;
      controller.abort();
      if (autosave === handle) {
        autosave = null;
      }
    };
  };

  const saveNow = async (): Promise<SessionSaveOutcome> => {
    cancelAutosave();
    const prepared = latestPreparedSave();
    if (!prepared) {
      return "skipped";
    }
    lastFlushedSaves.delete(prepared.clientId);

    const active = latestActiveOperation(prepared.clientId);
    if (active?.snapshot.contentKey === prepared.contentKey) {
      return active.promise ?? "skipped";
    }
    if (
      !active &&
      isConfirmed(prepared)
    ) {
      dependencies.onStatusChange("saved");
      return "skipped";
    }

    const operation = enqueuePersist(createSnapshot(prepared), undefined, false);
    return operation.promise ?? "skipped";
  };

  const flushPageExit = (): SessionFlushOutcome => {
    cancelAutosave();
    const prepared = latestPreparedSave();
    if (!prepared) {
      return "skipped";
    }

    const active = latestActiveOperation(prepared.clientId);
    const lastFlushed = lastFlushedSaves.get(prepared.clientId);
    if (
      !active &&
      (isConfirmed(prepared) || lastFlushed?.contentKey === prepared.contentKey)
    ) {
      return "skipped";
    }

    const snapshot = createSnapshot(prepared);
    advanceRevisionFloor(
      snapshot.clientId,
      snapshot.revision,
      snapshot.serializedState
    );
    lastFlushedSaves.set(snapshot.clientId, {
      contentKey: snapshot.contentKey,
      revision: snapshot.revision
    });
    dependencies.flush(snapshot.serializedState, snapshot.clientId);
    return "flushed";
  };

  return {
    scheduleAutosave,
    cancelAutosave,
    saveNow,
    flushPageExit,
    dispose: cancelAutosave,
    getDebugState: () => ({
      lastSavedPayload,
      hasAutosave: autosave !== null
    })
  };
}
