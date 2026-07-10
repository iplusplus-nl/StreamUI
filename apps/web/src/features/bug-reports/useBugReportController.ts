import { useEffect, useMemo, useRef, useState } from "react";
import { blobToDataUrl } from "../../core/blob";
import { captureCurrentPageScreenshotBlob } from "../../core/pageScreenshot";
import {
  createEmptyBugReportDraft,
  createId,
  type BugReportDraft,
  type ChatSession,
  type SessionState
} from "../../domain/chat/sessionModel";
import { submitBugReport } from "./bugReportApi";
import {
  createBugReportController,
  initialBugReportViewState,
  type BugReportControllerDependencies,
  type BugReportOpenOutcome,
  type BugReportPhase,
  type BugReportSubmitOutcome
} from "./bugReportController";

type ValueRef<T> = { current: T };

export type UseBugReportControllerInput = {
  sessionState: SessionState;
  sessionStateRef: ValueRef<SessionState>;
  activeSessionIdRef: ValueRef<string>;
  sessionClientIdRef: ValueRef<string>;
  updateSessionById(
    sessionId: string,
    updater: (session: ChatSession) => ChatSession
  ): boolean;
  saveNow(): void;
  dependencies?: Partial<BugReportControllerDependencies>;
};

export type BugReportViewController = {
  phase: BugReportPhase;
  session: ChatSession | null;
  draft: BugReportDraft;
  isOpen: boolean;
  isCapturing: boolean;
  isSubmitting: boolean;
  isSubmitted: boolean;
  captureError: string | null;
  submitError: string | null;
  open(): Promise<BugReportOpenOutcome>;
  changeDraft(draft: BugReportDraft): boolean;
  close(): void;
  submit(): Promise<BugReportSubmitOutcome>;
};

function browserDependencies(): BugReportControllerDependencies {
  return {
    capturePage: captureCurrentPageScreenshotBlob,
    encodeBlob: blobToDataUrl,
    submitReport: submitBugReport,
    createImageId: () => createId("bug-image"),
    now: Date.now,
    getViewport: () => ({
      width: window.innerWidth,
      height: window.innerHeight
    }),
    warn: (message, error) => console.warn(message, error),
    schedule: (delayMs, task) => {
      const timerId = window.setTimeout(task, delayMs);
      return {
        cancel: () => window.clearTimeout(timerId)
      };
    }
  };
}

export function useBugReportController({
  sessionState,
  sessionStateRef,
  activeSessionIdRef,
  sessionClientIdRef,
  updateSessionById,
  saveNow,
  dependencies = {}
}: UseBugReportControllerInput): BugReportViewController {
  const [viewState, setViewState] = useState(initialBugReportViewState);
  const updateSessionRef = useRef(updateSessionById);
  const saveNowRef = useRef(saveNow);
  updateSessionRef.current = updateSessionById;
  saveNowRef.current = saveNow;
  const dependenciesRef = useRef(dependencies);
  const [controller] = useState(() =>
    createBugReportController(
      {
        getActiveSessionId: () => activeSessionIdRef.current,
        getSession: (sessionId) =>
          sessionStateRef.current.sessions.find(
            (session) => session.id === sessionId
          ),
        updateSession: (sessionId, updater) =>
          updateSessionRef.current(sessionId, updater),
        getClientId: () => sessionClientIdRef.current,
        saveNow: () => saveNowRef.current(),
        onStateChange: setViewState
      },
      {
        ...browserDependencies(),
        ...dependenciesRef.current
      }
    )
  );

  useEffect(() => () => controller.dispose(), [controller]);

  const session = useMemo(
    () =>
      viewState.sessionId
        ? (sessionState.sessions.find(
            (candidate) => candidate.id === viewState.sessionId
          ) ?? null)
        : null,
    [sessionState.sessions, viewState.sessionId]
  );
  const draft = useMemo(
    () => session?.bugReportDraft ?? createEmptyBugReportDraft(),
    [session]
  );
  const isOpen =
    viewState.phase === "editing" ||
    viewState.phase === "submitting" ||
    viewState.phase === "submitted";

  return {
    phase: viewState.phase,
    session,
    draft,
    isOpen,
    isCapturing: viewState.phase === "capturing",
    isSubmitting: viewState.phase === "submitting",
    isSubmitted: viewState.phase === "submitted",
    captureError: viewState.captureError,
    submitError: viewState.submitError,
    open: controller.open,
    changeDraft: controller.changeDraft,
    close: controller.close,
    submit: controller.submit
  };
}
