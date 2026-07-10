import type { ArtifactSelection } from "../../core/artifactSelection";
import type { ImageAttachment } from "../../core/imageAttachments";
import type {
  ChatSession,
  ClientMessage,
  SessionState
} from "../../domain/chat/sessionModel";
import type { PageThemeMode } from "../../runtime/streamui/types";
import type {
  ArtifactEditRequest,
  ArtifactEditResponse
} from "./artifactEditApi";
import {
  applyPendingArtifactEditOperation,
  cancelArtifactEditOperation,
  completeArtifactEditOperation,
  failArtifactEditOperation,
  prepareArtifactEditRegeneration,
  prepareArtifactSourceEdit,
  type ArtifactEditOperation
} from "./artifactEditOperationModel";
import { artifactSelectionToReference } from "./artifactMessageProjection";

export type ArtifactEditRequestSettings = {
  apiSettings: unknown;
  managed: boolean;
  requiresAuthentication: boolean;
};

export type ArtifactEditTarget = {
  sessionId: string;
  assistantId: string;
};

export type ArtifactEditMutationOutcome =
  | "applied"
  | "unchanged"
  | "missing";

export type ArtifactEditBusyLease = {
  release(): void;
};

export type ArtifactEditControllerPorts = {
  isBusy(): boolean;
  getActiveSessionId(): string;
  getSessionState(): SessionState;
  resolveRequestSettings(session: ChatSession): ArtifactEditRequestSettings;
  getClientId(): string;
  getThemeMode(): PageThemeMode;
  mutateMessage(
    target: ArtifactEditTarget,
    updater: (message: ClientMessage) => ClientMessage
  ): ArtifactEditMutationOutcome;
  tryAcquireBusy(ownerId: string): ArtifactEditBusyLease | undefined;
  clearSelections(target: ArtifactEditTarget): void;
  openAuthentication(): void;
  saveNow(): void;
  refreshAuthentication(): Promise<void>;
  warn(message: string, error?: unknown): void;
};

export type ArtifactEditControllerDependencies = {
  requestEdit(
    request: ArtifactEditRequest,
    clientId: string,
    signal: AbortSignal
  ): Promise<ArtifactEditResponse>;
  createEditId(): string;
  createVariantId(): string;
  createOperationId(): string;
  now(): number;
  isAbortError(error: unknown): boolean;
  sanitizeError(error: unknown, fallback: string): string;
};

export type ArtifactEditRunOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "busy"
  | "invalid"
  | "missing"
  | "pending"
  | "authentication-required"
  | "unsupported-attachments"
  | "stale";

export type ArtifactEditController = {
  runSourceEdit(
    prompt: string,
    selections: ArtifactSelection[],
    attachments?: ImageAttachment[]
  ): Promise<ArtifactEditRunOutcome>;
  regenerate(
    assistantId: string,
    editId: string,
    nextPrompt?: string
  ): Promise<ArtifactEditRunOutcome>;
  editPrompt(assistantId: string, editId: string, prompt: string): boolean;
  cancelActive(): boolean;
  isRunning(): boolean;
  activate(): void;
  dispose(): void;
};

type ActiveArtifactEdit = {
  target: ArtifactEditTarget;
  controller: AbortController;
  clientId: string;
  lease: ArtifactEditBusyLease;
  managed: boolean;
  operation: ArtifactEditOperation;
  themeMode: PageThemeMode;
};

const SOURCE_EDIT_ERROR = "The artifact edit failed.";
const REGENERATION_ERROR = "The artifact edit regeneration failed.";

function findMessageTarget(
  state: SessionState,
  sessionId: string,
  assistantId: string
): {
  session: ChatSession;
  message: ClientMessage;
  target: ArtifactEditTarget;
} | undefined {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  const message = session?.messages.find(
    (candidate) =>
      candidate.id === assistantId && candidate.role === "assistant"
  );
  if (session && message) {
    return {
      session,
      message,
      target: { sessionId: session.id, assistantId }
    };
  }
  return undefined;
}

export function createArtifactEditController(
  ports: ArtifactEditControllerPorts,
  dependencies: ArtifactEditControllerDependencies
): ArtifactEditController {
  let active: ActiveArtifactEdit | null = null;
  let disposed = false;
  let lifecycleGeneration = 0;

  const refreshManagedAuthentication = (task: ActiveArtifactEdit) => {
    if (!task.managed) {
      return;
    }

    const refreshGeneration = lifecycleGeneration;
    void (async () => {
      try {
        await ports.refreshAuthentication();
      } catch (error) {
        if (
          disposed ||
          lifecycleGeneration !== refreshGeneration
        ) {
          return;
        }
        ports.warn("Could not refresh ChatHTML Cloud account.", error);
      }
    })();
  };

  const finish = (
    task: ActiveArtifactEdit,
    options: { save: boolean; refresh: boolean }
  ) => {
    if (active !== task) {
      return;
    }

    active = null;
    task.lease.release();
    if (options.save) {
      ports.saveNow();
    }
    if (options.refresh) {
      refreshManagedAuthentication(task);
    }
  };

  const cancelTask = (task: ActiveArtifactEdit) => {
    task.controller.abort();
    const cancelled = ports.mutateMessage(task.target, (message) =>
      cancelArtifactEditOperation(
        message,
        task.operation,
        task.themeMode
      )
    );
    finish(task, { save: cancelled === "applied", refresh: true });
  };

  const execute = async (
    target: ArtifactEditTarget,
    operation: ArtifactEditOperation,
    settings: ArtifactEditRequestSettings,
    options: {
      clearSelectionsAtStart: boolean;
      clearSelectionsOnComplete: boolean;
      failureFallback: string;
    }
  ): Promise<ArtifactEditRunOutcome> => {
    if (disposed) {
      return "cancelled";
    }
    if (active || ports.isBusy()) {
      return "busy";
    }

    if (settings.requiresAuthentication) {
      ports.openAuthentication();
      return "authentication-required";
    }

    const clientId = ports.getClientId();
    const themeMode = ports.getThemeMode();
    const lease = ports.tryAcquireBusy(operation.operationId);
    if (!lease) {
      return "busy";
    }

    const task: ActiveArtifactEdit = {
      target,
      controller: new AbortController(),
      clientId,
      lease,
      managed: settings.managed,
      operation,
      themeMode
    };
    active = task;
    let applied: ArtifactEditMutationOutcome;
    try {
      applied = ports.mutateMessage(target, (message) =>
        applyPendingArtifactEditOperation(
          message,
          operation,
          task.themeMode
        )
      );
    } catch (error) {
      task.controller.abort();
      finish(task, { save: false, refresh: false });
      ports.warn("Could not initialize artifact edit.", error);
      return "failed";
    }
    if (applied !== "applied") {
      task.controller.abort();
      finish(task, { save: false, refresh: false });
      return "missing";
    }

    let shouldSave = false;
    try {
      if (options.clearSelectionsAtStart) {
        ports.clearSelections(target);
      }
      const result = await dependencies.requestEdit(
        {
          source: operation.source,
          prompt: operation.prompt,
          references: operation.references,
          apiSettings: settings.apiSettings
        },
        task.clientId,
        task.controller.signal
      );
      if (active !== task || task.controller.signal.aborted) {
        return "cancelled";
      }

      const completed = ports.mutateMessage(target, (message) =>
        completeArtifactEditOperation(
          message,
          operation,
          {
            rawStream: result.rawStream,
            summary: result.summary,
            editCount: result.edits?.length
          },
          task.themeMode
        )
      );
      if (completed === "applied" && options.clearSelectionsOnComplete) {
        ports.clearSelections(target);
      }
      shouldSave = completed === "applied";
      return completed === "applied" ? "completed" : "stale";
    } catch (error) {
      if (
        active !== task ||
        task.controller.signal.aborted ||
        dependencies.isAbortError(error)
      ) {
        if (active === task) {
          const cancelled = ports.mutateMessage(target, (message) =>
            cancelArtifactEditOperation(
              message,
              operation,
              task.themeMode
            )
          );
          shouldSave = cancelled === "applied";
          return shouldSave ? "cancelled" : "stale";
        }
        return "cancelled";
      }

      const errorMessage = dependencies.sanitizeError(
        error,
        options.failureFallback
      );
      const failed = ports.mutateMessage(target, (message) =>
        failArtifactEditOperation(message, operation, errorMessage)
      );
      shouldSave = failed === "applied";
      return shouldSave ? "failed" : "stale";
    } finally {
      finish(task, { save: shouldSave, refresh: true });
    }
  };

  const runSourceEdit = async (
    prompt: string,
    selections: ArtifactSelection[],
    attachments: ImageAttachment[] = []
  ): Promise<ArtifactEditRunOutcome> => {
    if (disposed) {
      return "cancelled";
    }
    const trimmed = prompt.trim();
    if (!trimmed || !selections.length) {
      return "invalid";
    }
    if (active || ports.isBusy()) {
      return "busy";
    }
    if (attachments.length > 0) {
      ports.warn(
        "Local artifact edits do not support attachments yet. Remove the attachment and try again."
      );
      return "unsupported-attachments";
    }

    const selectedMessageIds = Array.from(
      new Set(selections.map((selection) => selection.messageId))
    );
    const assistantId = selectedMessageIds[0];
    if (!assistantId || selectedMessageIds.length !== 1) {
      ports.warn("Artifact edits require references from a single artifact.");
      return "invalid";
    }

    const target = findMessageTarget(
      ports.getSessionState(),
      ports.getActiveSessionId(),
      assistantId
    );
    if (!target) {
      ports.warn("Artifact edits require a completed artifact source.");
      return "missing";
    }

    const operation = prepareArtifactSourceEdit(target.message, {
      prompt: trimmed,
      references: selections.map(artifactSelectionToReference),
      editId: dependencies.createEditId(),
      variantId: dependencies.createVariantId(),
      operationId: dependencies.createOperationId(),
      createdAt: dependencies.now()
    });
    if (!operation) {
      ports.warn("Artifact edits require a completed artifact source.");
      return "invalid";
    }

    return execute(
      target.target,
      operation,
      ports.resolveRequestSettings(target.session),
      {
        clearSelectionsAtStart: true,
        clearSelectionsOnComplete: false,
        failureFallback: SOURCE_EDIT_ERROR
      }
    );
  };

  const regenerate = async (
    assistantId: string,
    editId: string,
    nextPrompt?: string
  ): Promise<ArtifactEditRunOutcome> => {
    if (disposed) {
      return "cancelled";
    }
    if (active || ports.isBusy()) {
      return "busy";
    }

    const target = findMessageTarget(
      ports.getSessionState(),
      ports.getActiveSessionId(),
      assistantId
    );
    if (!target) {
      return "missing";
    }

    const prepared = prepareArtifactEditRegeneration(
      target.message,
      editId,
      nextPrompt,
      {
        createEditId: dependencies.createEditId,
        createVariantId: dependencies.createVariantId,
        createOperationId: dependencies.createOperationId,
        now: dependencies.now
      }
    );
    if (prepared.status === "missing") {
      return "missing";
    }
    if (prepared.status === "pending") {
      return "pending";
    }
    if (prepared.status === "invalid") {
      ports.warn("Artifact edit regeneration requires a completed source.");
      return "invalid";
    }

    return execute(
      target.target,
      prepared.operation,
      ports.resolveRequestSettings(target.session),
      {
        clearSelectionsAtStart: false,
        clearSelectionsOnComplete: true,
        failureFallback: REGENERATION_ERROR
      }
    );
  };

  const editPrompt = (
    assistantId: string,
    editId: string,
    prompt: string
  ): boolean => {
    if (disposed) {
      return false;
    }
    const trimmed = prompt.trim();
    if (!trimmed || active || ports.isBusy()) {
      return false;
    }

    const target = findMessageTarget(
      ports.getSessionState(),
      ports.getActiveSessionId(),
      assistantId
    );
    const currentMessage = target?.message;
    if (!currentMessage?.artifactEdits?.length) {
      return false;
    }
    if (currentMessage.artifactEdits.some((edit) => edit.status === "pending")) {
      ports.warn("Wait for the current artifact edit to finish before editing.");
      return false;
    }

    const edit = currentMessage.artifactEdits.find(
      (candidate) => candidate.id === editId
    );
    if (!edit || edit.status !== "complete") {
      return false;
    }
    if (trimmed === edit.prompt.trim()) {
      return true;
    }

    void regenerate(assistantId, editId, trimmed);
    return true;
  };

  const cancelActive = (): boolean => {
    if (disposed || !active) {
      return false;
    }

    cancelTask(active);
    return true;
  };

  return {
    runSourceEdit,
    regenerate,
    editPrompt,
    cancelActive,
    isRunning: () => active !== null,
    activate: () => {
      if (!disposed) {
        return;
      }
      disposed = false;
      lifecycleGeneration += 1;
    },
    dispose: () => {
      if (disposed) {
        return;
      }

      disposed = true;
      lifecycleGeneration += 1;
      const task = active;
      active = null;
      if (!task) {
        return;
      }
      task.controller.abort();
      task.lease.release();
    }
  };
}
