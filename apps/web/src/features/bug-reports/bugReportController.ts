import {
  createEmptyBugReportDraft,
  MAX_BUG_REPORT_IMAGES,
  normalizeBugReportDraft,
  summarizeSession,
  type BugReportDraft,
  type BugReportImage,
  type ChatSession
} from "../../domain/chat/sessionModel";

export type BugReportPhase =
  | "closed"
  | "capturing"
  | "editing"
  | "submitting"
  | "submitted";

export type BugReportViewState = {
  phase: BugReportPhase;
  sessionId: string | null;
  captureError: string | null;
  submitError: string | null;
};

export const initialBugReportViewState: BugReportViewState = {
  phase: "closed",
  sessionId: null,
  captureError: null,
  submitError: null
};

export type BugReportControllerPorts = {
  getActiveSessionId(): string;
  getSession(sessionId: string): ChatSession | undefined;
  updateSession(
    sessionId: string,
    updater: (session: ChatSession) => ChatSession
  ): boolean;
  getClientId(): string;
  saveNow(): void;
  onStateChange(state: BugReportViewState): void;
};

export type ScheduledBugReportTask = {
  cancel(): void;
};

export type BugReportControllerDependencies = {
  capturePage(): Promise<Blob>;
  encodeBlob(blob: Blob): Promise<string>;
  submitReport(
    input: {
      sessionId: string;
      sessionTitle: string;
      draft: BugReportDraft;
    },
    clientId: string
  ): Promise<string>;
  createImageId(): string;
  now(): number;
  getViewport(): { width: number; height: number };
  warn(message: string, error: unknown): void;
  schedule(delayMs: number, task: () => void): ScheduledBugReportTask;
};

export type BugReportOpenOutcome =
  | "opened"
  | "opened-with-capture-error"
  | "busy"
  | "missing"
  | "cancelled";

export type BugReportSubmitOutcome =
  | "submitted"
  | "failed"
  | "busy"
  | "empty"
  | "missing"
  | "cancelled";

export type BugReportController = {
  getState(): BugReportViewState;
  open(): Promise<BugReportOpenOutcome>;
  changeDraft(draft: BugReportDraft): boolean;
  close(): void;
  submit(): Promise<BugReportSubmitOutcome>;
  dispose(): void;
};

const CAPTURE_ERROR =
  "Could not capture the page screenshot. You can still add images manually.";
const SUBMIT_FALLBACK_ERROR = "Could not submit bug report.";
const SUCCESS_CLOSE_DELAY_MS = 1_400;

function closedState(): BugReportViewState {
  return { ...initialBugReportViewState };
}

export function createBugReportController(
  ports: BugReportControllerPorts,
  dependencies: BugReportControllerDependencies
): BugReportController {
  let state = closedState();
  let generation = 0;
  let activeCaptureToken: number | null = null;
  let activeSubmitToken: number | null = null;
  let successCloseTask: ScheduledBugReportTask | null = null;

  const emit = (next: BugReportViewState) => {
    state = next;
    ports.onStateChange(next);
  };

  const cancelSuccessClose = () => {
    successCloseTask?.cancel();
    successCloseTask = null;
  };

  const invalidateOperations = () => {
    generation += 1;
    activeCaptureToken = null;
    activeSubmitToken = null;
    cancelSuccessClose();
  };

  const resetClosed = () => {
    emit(closedState());
  };

  const open = async (): Promise<BugReportOpenOutcome> => {
    if (activeCaptureToken !== null || activeSubmitToken !== null) {
      return "busy";
    }

    const targetSessionId = ports.getActiveSessionId();
    const targetSession = ports.getSession(targetSessionId);
    if (!targetSession) {
      return "missing";
    }

    invalidateOperations();
    const existingDraft = targetSession.bugReportDraft;
    const shouldCapture =
      (existingDraft?.images.length ?? 0) < MAX_BUG_REPORT_IMAGES &&
      !existingDraft?.screenshotCapturedAt &&
      !existingDraft?.images.some((image) => image.captured);
    if (!shouldCapture) {
      emit({
        phase: "editing",
        sessionId: targetSessionId,
        captureError: null,
        submitError: null
      });
      return "opened";
    }

    const token = generation;
    activeCaptureToken = token;
    emit({
      phase: "capturing",
      sessionId: targetSessionId,
      captureError: null,
      submitError: null
    });

    try {
      const blob = await dependencies.capturePage();
      const dataUrl = await dependencies.encodeBlob(blob);
      if (activeCaptureToken !== token || generation !== token) {
        return "cancelled";
      }

      if (!ports.getSession(targetSessionId)) {
        resetClosed();
        return "missing";
      }

      const createdAt = dependencies.now();
      const viewport = dependencies.getViewport();
      const screenshot: BugReportImage = {
        id: dependencies.createImageId(),
        name: "page-screenshot.png",
        mimeType: "image/png",
        size: blob.size,
        dataUrl,
        width: viewport.width,
        height: viewport.height,
        captured: true,
        createdAt
      };
      const updated = ports.updateSession(targetSessionId, (session) => {
        const now = dependencies.now();
        const currentDraft =
          session.bugReportDraft ?? createEmptyBugReportDraft(now);
        const hasCapturedImage = currentDraft.images.some(
          (image) => image.captured
        );
        const hasRoom = currentDraft.images.length < MAX_BUG_REPORT_IMAGES;
        const nextDraft = {
          ...currentDraft,
          images:
            hasRoom && !hasCapturedImage
              ? [screenshot, ...currentDraft.images]
              : currentDraft.images,
          screenshotCapturedAt:
            currentDraft.screenshotCapturedAt ?? screenshot.createdAt,
          updatedAt: now
        };

        return {
          ...session,
          updatedAt: now,
          bugReportDraft: normalizeBugReportDraft(nextDraft, now)
        };
      });
      if (!updated) {
        resetClosed();
        return "missing";
      }

      emit({
        phase: "editing",
        sessionId: targetSessionId,
        captureError: null,
        submitError: null
      });
      return "opened";
    } catch (error) {
      if (activeCaptureToken !== token || generation !== token) {
        return "cancelled";
      }
      if (!ports.getSession(targetSessionId)) {
        resetClosed();
        return "missing";
      }

      dependencies.warn("Could not capture bug report screenshot.", error);
      emit({
        phase: "editing",
        sessionId: targetSessionId,
        captureError: CAPTURE_ERROR,
        submitError: null
      });
      return "opened-with-capture-error";
    } finally {
      if (activeCaptureToken === token) {
        activeCaptureToken = null;
      }
    }
  };

  const changeDraft = (draft: BugReportDraft): boolean => {
    if (state.phase !== "editing" || !state.sessionId) {
      return false;
    }

    const targetSessionId = state.sessionId;
    return ports.updateSession(targetSessionId, (session) => {
      const now = dependencies.now();
      return {
        ...session,
        updatedAt: now,
        bugReportDraft: normalizeBugReportDraft(draft, now)
      };
    });
  };

  const close = () => {
    invalidateOperations();
    resetClosed();
    ports.saveNow();
  };

  const submit = async (): Promise<BugReportSubmitOutcome> => {
    if (activeCaptureToken !== null || activeSubmitToken !== null) {
      return "busy";
    }
    if (!state.sessionId || state.phase !== "editing") {
      return state.phase === "submitting" || state.phase === "submitted"
        ? "busy"
        : "missing";
    }

    const targetSessionId = state.sessionId;
    const targetSession = ports.getSession(targetSessionId);
    if (!targetSession) {
      resetClosed();
      return "missing";
    }
    const draft = targetSession.bugReportDraft;
    if (!draft || (!draft.text.trim() && draft.images.length === 0)) {
      return "empty";
    }

    cancelSuccessClose();
    generation += 1;
    const token = generation;
    activeSubmitToken = token;
    emit({
      phase: "submitting",
      sessionId: targetSessionId,
      captureError: state.captureError,
      submitError: null
    });

    try {
      await dependencies.submitReport(
        {
          sessionId: targetSession.id,
          sessionTitle:
            targetSession.title || summarizeSession(targetSession.messages),
          draft
        },
        ports.getClientId()
      );
      if (activeSubmitToken !== token || generation !== token) {
        return "cancelled";
      }
      if (!ports.getSession(targetSessionId)) {
        resetClosed();
        return "missing";
      }

      emit({
        phase: "submitted",
        sessionId: targetSessionId,
        captureError: null,
        submitError: null
      });
      successCloseTask = dependencies.schedule(SUCCESS_CLOSE_DELAY_MS, () => {
        if (
          generation !== token ||
          state.phase !== "submitted" ||
          state.sessionId !== targetSessionId
        ) {
          return;
        }

        successCloseTask = null;
        ports.updateSession(targetSessionId, (session) => ({
          ...session,
          updatedAt: dependencies.now(),
          bugReportDraft: undefined
        }));
        resetClosed();
        ports.saveNow();
      });
      return "submitted";
    } catch (error) {
      if (activeSubmitToken !== token || generation !== token) {
        return "cancelled";
      }
      if (!ports.getSession(targetSessionId)) {
        resetClosed();
        return "missing";
      }

      emit({
        phase: "editing",
        sessionId: targetSessionId,
        captureError: state.captureError,
        submitError:
          error instanceof Error ? error.message : SUBMIT_FALLBACK_ERROR
      });
      return "failed";
    } finally {
      if (activeSubmitToken === token) {
        activeSubmitToken = null;
      }
    }
  };

  const dispose = () => {
    invalidateOperations();
  };

  return {
    getState: () => state,
    open,
    changeDraft,
    close,
    submit,
    dispose
  };
}
