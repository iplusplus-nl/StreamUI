export type ComposerDraftAttachment = {
  file?: File;
};

export type ComposerDraftState = {
  text: string;
  attachments: readonly ComposerDraftAttachment[];
};

export type ComposerSessionDraftPort = {
  getState(): ComposerDraftState;
  setText(text: string): void;
  addAttachment(file: File): Promise<void>;
  clearAttachments(): Promise<void>;
};

export type ComposerSessionDraft = {
  text: string;
  files: readonly File[];
};

export type ComposerSessionDraftController = {
  capture(): void;
  activate(sessionId: string): void;
  discardSession(sessionId: string): void;
  retryAttachmentCleanup(): void;
  getDraft(sessionId: string): ComposerSessionDraft | undefined;
  getDraftSessionIds(): ReadonlySet<string>;
  hasDrafts(): boolean;
  hasUnsafeAttachments(): boolean;
  dispose(): void;
};

export type ComposerSessionDraftControllerOptions = {
  onError?(message: string, error: unknown): void;
  onDraftsChange?(hasDrafts: boolean): void;
  onDraftSessionIdsChange?(sessionIds: ReadonlySet<string>): void;
  onAttachmentSafetyChange?(blocked: boolean): void;
};

function attachmentFiles(state: ComposerDraftState): File[] {
  return state.attachments.flatMap((attachment) =>
    attachment.file ? [attachment.file] : []
  );
}

function hasDraft(draft: ComposerSessionDraft): boolean {
  return Boolean(draft.text || draft.files.length);
}

/**
 * Keeps the single assistant-ui composer scoped to the active ChatHTML session.
 * Attachment uploads are removed when a session is left, while their original
 * File objects remain in memory and are uploaded again when that session returns.
 */
export function createComposerSessionDraftController(
  port: ComposerSessionDraftPort,
  initialSessionId: string,
  options: ComposerSessionDraftControllerOptions = {}
): ComposerSessionDraftController {
  const drafts = new Map<string, ComposerSessionDraft>();
  let activeSessionId = initialSessionId;
  let restoreGeneration = 0;
  let isRestoring = false;
  let preserveActiveDraftFiles = false;
  let unsafeVisibleFiles = new Set<File>();
  let restoreIncomplete = false;
  let attachmentTransitionPending = false;
  let attachmentSafetyBlocked = false;
  let transitionTail: Promise<void> = Promise.resolve();
  let disposed = false;

  const reportError = (message: string, error: unknown) => {
    options.onError?.(message, error);
  };

  const notifyDraftsChange = () => {
    options.onDraftsChange?.(drafts.size > 0);
    options.onDraftSessionIdsChange?.(new Set(drafts.keys()));
  };

  const updateAttachmentSafety = () => {
    const blocked =
      unsafeVisibleFiles.size > 0 ||
      restoreIncomplete ||
      attachmentTransitionPending;
    if (blocked === attachmentSafetyBlocked) {
      return;
    }
    attachmentSafetyBlocked = blocked;
    options.onAttachmentSafetyChange?.(blocked);
  };

  const markVisibleFilesUnsafe = (files: readonly File[]) => {
    unsafeVisibleFiles = new Set([...unsafeVisibleFiles, ...files]);
    updateAttachmentSafety();
  };

  const storeDraft = (
    sessionId: string,
    draft: ComposerSessionDraft
  ): void => {
    if (hasDraft(draft)) {
      drafts.set(sessionId, draft);
    } else {
      drafts.delete(sessionId);
    }
    notifyDraftsChange();
  };

  const captureCurrent = (preserveRestoringFiles = false): void => {
    if (disposed || !activeSessionId) {
      return;
    }

    const state = port.getState();
    const allVisibleFiles = attachmentFiles(state);
    unsafeVisibleFiles = new Set(
      Array.from(unsafeVisibleFiles).filter((file) =>
        allVisibleFiles.includes(file)
      )
    );
    updateAttachmentSafety();
    const visibleFiles = allVisibleFiles.filter(
      (file) => !unsafeVisibleFiles.has(file)
    );
    const existingFiles = drafts.get(activeSessionId)?.files ?? [];
    storeDraft(activeSessionId, {
      text: state.text,
      files:
        preserveRestoringFiles
          ? [
              ...existingFiles,
              ...visibleFiles.filter((file) => !existingFiles.includes(file))
            ]
          : visibleFiles
    });
  };

  const clearAttachmentsSafely = (): Promise<boolean> => {
    try {
      return Promise.resolve(port.clearAttachments())
        .then(() => true)
        .catch((error) => {
          reportError(
            "Could not switch attachment drafts safely. The draft is still stored; retry the session switch.",
            error
          );
          return false;
        });
    } catch (error) {
      reportError(
        "Could not switch attachment drafts safely. The draft is still stored; retry the session switch.",
        error
      );
      return Promise.resolve(false);
    }
  };

  const enqueueTransition = (task: () => Promise<void>) => {
    const run = async () => {
      if (!disposed) {
        await task();
      }
    };
    transitionTail = transitionTail.then(run, run).catch((error) => {
      reportError("Could not finish the attachment draft transition.", error);
    });
  };

  const restore = async (
    sessionId: string,
    generation: number,
    cleared: boolean
  ): Promise<void> => {
    if (
      disposed ||
      generation !== restoreGeneration ||
      sessionId !== activeSessionId
    ) {
      return;
    }

    if (!cleared) {
      restoreIncomplete = true;
      preserveActiveDraftFiles = true;
      attachmentTransitionPending = false;
      isRestoring = false;
      captureCurrent(true);
      updateAttachmentSafety();
      return;
    }

    unsafeVisibleFiles.clear();
    restoreIncomplete = false;
    updateAttachmentSafety();
    const draft = drafts.get(sessionId);
    let restoreFailed = false;
    for (const file of draft?.files ?? []) {
      if (
        disposed ||
        generation !== restoreGeneration ||
        sessionId !== activeSessionId
      ) {
        return;
      }
      try {
        await port.addAttachment(file);
      } catch (error) {
        restoreFailed = true;
        reportError(`Could not restore ${file.name || "an attachment"}.`, error);
      }
    }

    if (
      !disposed &&
      generation === restoreGeneration &&
      sessionId === activeSessionId
    ) {
      preserveActiveDraftFiles = restoreFailed;
      restoreIncomplete = restoreFailed;
      attachmentTransitionPending = false;
      isRestoring = false;
      captureCurrent(restoreFailed);
      updateAttachmentSafety();
    }
  };

  const startAttachmentRestore = (sessionId: string, generation: number) => {
    enqueueTransition(async () => {
      const cleared = await clearAttachmentsSafely();
      await restore(sessionId, generation, cleared);
    });
  };

  return {
    capture() {
      if (!isRestoring) {
        captureCurrent(preserveActiveDraftFiles);
      }
    },

    activate(sessionId) {
      if (disposed || !sessionId || sessionId === activeSessionId) {
        return;
      }

      captureCurrent(isRestoring || preserveActiveDraftFiles);
      const previousVisibleFiles = attachmentFiles(port.getState());
      markVisibleFilesUnsafe(previousVisibleFiles);
      restoreGeneration += 1;
      const generation = restoreGeneration;
      isRestoring = true;
      preserveActiveDraftFiles = false;
      restoreIncomplete = false;
      attachmentTransitionPending = true;
      activeSessionId = sessionId;
      port.setText(drafts.get(sessionId)?.text ?? "");
      updateAttachmentSafety();
      startAttachmentRestore(sessionId, generation);
    },

    discardSession(sessionId) {
      drafts.delete(sessionId);
      notifyDraftsChange();
      if (disposed || sessionId !== activeSessionId) {
        return;
      }

      restoreGeneration += 1;
      const generation = restoreGeneration;
      isRestoring = true;
      preserveActiveDraftFiles = false;
      restoreIncomplete = false;
      attachmentTransitionPending = true;
      markVisibleFilesUnsafe(attachmentFiles(port.getState()));
      port.setText("");
      enqueueTransition(async () => {
        const cleared = await clearAttachmentsSafely();
        if (
          !disposed &&
          generation === restoreGeneration &&
          sessionId === activeSessionId
        ) {
          if (cleared) {
            unsafeVisibleFiles.clear();
          } else {
            restoreIncomplete = true;
          }
          attachmentTransitionPending = false;
          isRestoring = false;
          updateAttachmentSafety();
        }
      });
    },

    retryAttachmentCleanup() {
      if (disposed || !attachmentSafetyBlocked || !activeSessionId) {
        return;
      }

      captureCurrent(true);
      markVisibleFilesUnsafe(attachmentFiles(port.getState()));
      restoreGeneration += 1;
      const generation = restoreGeneration;
      isRestoring = true;
      preserveActiveDraftFiles = false;
      restoreIncomplete = false;
      attachmentTransitionPending = true;
      updateAttachmentSafety();
      startAttachmentRestore(activeSessionId, generation);
    },

    getDraft(sessionId) {
      const draft = drafts.get(sessionId);
      return draft
        ? { text: draft.text, files: [...draft.files] }
        : undefined;
    },

    getDraftSessionIds() {
      return new Set(drafts.keys());
    },

    hasDrafts() {
      return drafts.size > 0;
    },

    hasUnsafeAttachments() {
      return attachmentSafetyBlocked;
    },

    dispose() {
      disposed = true;
      restoreGeneration += 1;
      drafts.clear();
      unsafeVisibleFiles.clear();
      restoreIncomplete = false;
      attachmentTransitionPending = false;
      updateAttachmentSafety();
      notifyDraftsChange();
    }
  };
}
