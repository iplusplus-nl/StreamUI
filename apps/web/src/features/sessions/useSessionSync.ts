import { useCallback, useEffect } from "react";
import type { SessionState } from "../../domain/chat/sessionModel";
import {
  createSingleFlightSessionPoll,
  runInitialSessionLoad,
  runSessionPoll,
  type SessionStateUpdater,
  type SessionSyncDependencies
} from "./sessionSyncController";

type ValueRef<T> = { current: T };
type SizeLike = { readonly size: number };

export type UseSessionSyncInput = {
  sessionsLoaded: boolean;
  intervalMs: number;
  sessionClientIdRef: ValueRef<string>;
  sessionStateRef: ValueRef<SessionState>;
  sessionsLoadedRef: ValueRef<boolean>;
  sessionsHydratedRef: ValueRef<boolean>;
  deletedSessionIdsRef: ValueRef<ReadonlySet<string>>;
  transientEmptySessionIdRef: ValueRef<string | null>;
  protectedEmptySessionIdsRef?: ValueRef<ReadonlySet<string>>;
  runConnectionsRef: ValueRef<SizeLike>;
  cancelledRunIdsRef: ValueRef<SizeLike>;
  attachmentDraftsRef: ValueRef<boolean>;
  updateState: SessionStateUpdater;
  setSessionsLoaded(loaded: boolean): void;
  setSessionsHydrated(hydrated: boolean): void;
  retryVersion?: number;
  onError?(phase: "load" | "sync", error: unknown): void;
  onSuccess?(phase: "load" | "sync"): void;
  dependencies?: Partial<SessionSyncDependencies>;
};

export function useSessionSync({
  sessionsLoaded,
  intervalMs,
  sessionClientIdRef,
  sessionStateRef,
  sessionsLoadedRef,
  sessionsHydratedRef,
  deletedSessionIdsRef,
  transientEmptySessionIdRef,
  protectedEmptySessionIdsRef,
  runConnectionsRef,
  cancelledRunIdsRef,
  attachmentDraftsRef,
  updateState,
  setSessionsLoaded,
  setSessionsHydrated,
  retryVersion = 0,
  onError,
  onSuccess,
  dependencies
}: UseSessionSyncInput): void {
  const markSessionsHydrated = useCallback(() => {
    sessionsHydratedRef.current = true;
    setSessionsHydrated(true);
  }, [sessionsHydratedRef, setSessionsHydrated]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let cancelled = false;
    void runInitialSessionLoad(
      {
        clientId: sessionClientIdRef.current,
        isCancelled: () => cancelled,
        updateState,
        onApplied: markSessionsHydrated,
        getDeletedSessionIds: () => deletedSessionIdsRef.current,
        getTransientEmptySessionId: () => transientEmptySessionIdRef.current,
        getProtectedEmptySessionIds: () =>
          protectedEmptySessionIdsRef?.current ?? [],
        hasActiveRuns: () => runConnectionsRef.current.size > 0,
        hasRecentCancellations: () =>
          cancelledRunIdsRef.current.size > 0,
        hasAttachmentDrafts: () => attachmentDraftsRef.current
      },
      dependencies
    )
      .then((outcome) => {
        if (!cancelled && outcome === "applied") {
          onSuccess?.("load");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Could not load ChatHTML sessions.", error);
          onError?.("load", error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          sessionsLoadedRef.current = true;
          setSessionsLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    deletedSessionIdsRef,
    attachmentDraftsRef,
    cancelledRunIdsRef,
    dependencies,
    sessionClientIdRef,
    markSessionsHydrated,
    onError,
    onSuccess,
    protectedEmptySessionIdsRef,
    runConnectionsRef,
    sessionsLoadedRef,
    setSessionsLoaded,
    transientEmptySessionIdRef,
    updateState
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || !sessionsLoaded) {
      return undefined;
    }

    let cancelled = false;
    const poll = createSingleFlightSessionPoll(
      async () => {
        const outcome = await runSessionPoll(
          {
            clientId: sessionClientIdRef.current,
            isCancelled: () => cancelled,
            getState: () => sessionStateRef.current,
            updateState,
            onApplied: markSessionsHydrated,
            getDeletedSessionIds: () => deletedSessionIdsRef.current,
            getTransientEmptySessionId: () =>
              transientEmptySessionIdRef.current,
            getProtectedEmptySessionIds: () =>
              protectedEmptySessionIdsRef?.current ?? [],
            hasActiveRuns: () => runConnectionsRef.current.size > 0,
            hasRecentCancellations: () =>
              cancelledRunIdsRef.current.size > 0,
            hasAttachmentDrafts: () => attachmentDraftsRef.current
          },
          dependencies
        );
        if (!cancelled && outcome === "applied") {
          onSuccess?.("sync");
        }
      },
      (error) => {
        if (!cancelled) {
          console.warn("Could not sync ChatHTML sessions.", error);
          onError?.("sync", error);
        }
      }
    );

    const intervalId = window.setInterval(() => poll.trigger(), intervalMs);
    poll.trigger();

    return () => {
      cancelled = true;
      poll.cancel();
      window.clearInterval(intervalId);
    };
  }, [
    cancelledRunIdsRef,
    attachmentDraftsRef,
    deletedSessionIdsRef,
    dependencies,
    intervalMs,
    markSessionsHydrated,
    onError,
    onSuccess,
    protectedEmptySessionIdsRef,
    retryVersion,
    runConnectionsRef,
    sessionClientIdRef,
    sessionStateRef,
    sessionsLoaded,
    transientEmptySessionIdRef,
    updateState
  ]);
}
