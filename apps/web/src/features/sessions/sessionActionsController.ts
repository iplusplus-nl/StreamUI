import type {
  ChatSession,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  createNewSessionState,
  deleteSessionInState,
  selectSessionInState,
  updateActiveSessionInState,
  updateSessionByIdInState,
  type SessionUpdater
} from "./sessionCrudModel";

export type SessionActionsDependencies = {
  isNewOrDeleteBlocked(): boolean;
  isSelectionBlocked(): boolean;
  getState(): SessionState;
  replaceState(state: SessionState): void;
  getTransientEmptySessionId(): string | null;
  setTransientEmptySessionId(sessionId: string | null): void;
  markSessionDeleted(sessionId: string): void;
  createSession(): ChatSession;
  saveNow(): void;
};

export type SessionActionsController = {
  updateActiveSession(updater: SessionUpdater): boolean;
  updateSessionById(sessionId: string, updater: SessionUpdater): boolean;
  createNewSession(): "blocked" | "created" | "reused";
  selectSession(sessionId: string): "blocked" | "selected" | "not-found";
  deleteSession(
    sessionId: string
  ): "blocked" | "deleted" | "tombstoned-only";
};

export function createSessionActionsController(
  dependencies: SessionActionsDependencies
): SessionActionsController {
  return {
    updateActiveSession(updater) {
      const current = dependencies.getState();
      const next = updateActiveSessionInState(current, updater);
      if (next === current) {
        return false;
      }
      dependencies.replaceState(next);
      return true;
    },

    updateSessionById(sessionId, updater) {
      const current = dependencies.getState();
      const next = updateSessionByIdInState(current, sessionId, updater);
      if (next === current) {
        return false;
      }
      dependencies.replaceState(next);
      return true;
    },

    createNewSession() {
      if (dependencies.isNewOrDeleteBlocked()) {
        return "blocked";
      }

      const result = createNewSessionState(
        dependencies.getState(),
        dependencies.createSession
      );
      dependencies.setTransientEmptySessionId(
        result.transientEmptySessionId
      );
      dependencies.replaceState(result.state);
      return result.outcome;
    },

    selectSession(sessionId) {
      if (dependencies.isSelectionBlocked()) {
        return "blocked";
      }

      const result = selectSessionInState(
        dependencies.getState(),
        sessionId
      );
      if (!result.targetFound) {
        return "not-found";
      }

      if (sessionId !== dependencies.getTransientEmptySessionId()) {
        dependencies.setTransientEmptySessionId(null);
      }
      dependencies.replaceState(result.state);
      return "selected";
    },

    deleteSession(sessionId) {
      if (dependencies.isNewOrDeleteBlocked()) {
        return "blocked";
      }

      if (dependencies.getTransientEmptySessionId() === sessionId) {
        dependencies.setTransientEmptySessionId(null);
      }
      dependencies.markSessionDeleted(sessionId);

      const current = dependencies.getState();
      const wasPresent = current.sessions.some(
        (session) => session.id === sessionId
      );
      const next = deleteSessionInState(
        current,
        sessionId,
        dependencies.createSession
      );
      dependencies.replaceState(next);
      dependencies.saveNow();
      return wasPresent ? "deleted" : "tombstoned-only";
    }
  };
}
