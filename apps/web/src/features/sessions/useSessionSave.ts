import { useCallback, useEffect, useRef } from "react";
import type { SessionState } from "../../domain/chat/sessionModel";
import {
  createSessionSaveCoordinator,
  type SessionSaveOutcome,
  type SessionSaveStatus,
  type SessionSaveCoordinator,
  type SessionSaveDependencies
} from "./sessionSaveCoordinator";

type ValueRef<T> = { current: T };

export type UseSessionSaveInput = {
  sessionState: SessionState;
  sessionsLoaded: boolean;
  debounceMs: number;
  sessionStateRef: ValueRef<SessionState>;
  sessionsLoadedRef: ValueRef<boolean>;
  sessionClientIdRef: ValueRef<string>;
  deletedSessionIdsRef: ValueRef<ReadonlySet<string>>;
  onStatusChange?(status: SessionSaveStatus): void;
  dependencies?: Partial<SessionSaveDependencies>;
};

export function useSessionSave({
  sessionState,
  sessionsLoaded,
  debounceMs,
  sessionStateRef,
  sessionsLoadedRef,
  sessionClientIdRef,
  deletedSessionIdsRef,
  onStatusChange,
  dependencies
}: UseSessionSaveInput): () => Promise<SessionSaveOutcome> {
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const coordinatorRef = useRef<SessionSaveCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createSessionSaveCoordinator(
      {
        isLoaded: () => sessionsLoadedRef.current,
        getLatestState: () => sessionStateRef.current,
        getClientId: () => sessionClientIdRef.current,
        getDeletedSessionIds: () => deletedSessionIdsRef.current
      },
      debounceMs,
      {
        ...dependencies,
        onStatusChange: (status) => onStatusChangeRef.current?.(status)
      }
    );
  }
  const coordinator = coordinatorRef.current;

  useEffect(() => {
    if (typeof window === "undefined" || !sessionsLoaded) {
      return undefined;
    }

    return coordinator.scheduleAutosave(sessionState, sessionsLoaded);
  }, [coordinator, sessionState, sessionsLoaded]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const flushSessions = () => {
      coordinator.flushPageExit();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushSessions();
        return;
      }
      void coordinator.saveNow();
    };

    window.addEventListener("pagehide", flushSessions);
    window.addEventListener("beforeunload", flushSessions);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flushSessions);
      window.removeEventListener("beforeunload", flushSessions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      coordinator.dispose();
    };
  }, [coordinator]);

  return useCallback(() => coordinator.saveNow(), [coordinator]);
}
