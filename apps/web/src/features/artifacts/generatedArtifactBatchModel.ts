import type {
  ArtifactEdit,
  ArtifactEditRollback,
  ClientMessage,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  sortSessions,
  summarizeSession
} from "../../domain/chat/sessionModel";
import type { PageThemeMode } from "../../runtime/streamui/types";
import { isChatCancelledMessage } from "../chat/chatErrors";
import type { ChatRunAssistantPhase } from "../chat/chatRunRequest";
import {
  applyPendingArtifactEditOperation,
  cancelArtifactEditOperation,
  completeArtifactEditOperation,
  failArtifactEditOperation,
  hasPendingArtifactEditOperation,
  type ArtifactEditOperation
} from "./artifactEditOperationModel";
import {
  getArtifactEditRawStream,
  getResolvedArtifactEditId,
  hasPendingArtifactEditVariant
} from "./artifactEditModel";
import { buildCompletedAssistantPatchFromRawStream } from "./artifactMessageProjection";

export type GeneratedArtifactBatchTarget = {
  sessionId: string;
  assistantId: string;
  sourceUserMessageId: string;
};

export type GeneratedArtifactBatchOperation = ArtifactEditOperation & {
  target: GeneratedArtifactBatchTarget;
  runId: string;
  rollback: ArtifactEditRollback;
};

export type PrepareGeneratedArtifactBatchInput =
  GeneratedArtifactBatchTarget & {
    prompt: string;
    runId: string;
    operationId: string;
    editId: string;
    variantId: string;
    createdAt: number;
  };

export function prepareGeneratedArtifactBatch(
  message: ClientMessage,
  input: PrepareGeneratedArtifactBatchInput
): GeneratedArtifactBatchOperation | undefined {
  const prompt = input.prompt.trim();
  const previousActiveEditId = getResolvedArtifactEditId(message);
  const source = getArtifactEditRawStream(message, previousActiveEditId) ?? "";
  if (
    message.role !== "assistant" ||
    message.id !== input.assistantId ||
    !prompt ||
    !source.trim() ||
    message.artifactEdits?.some(hasPendingArtifactEditVariant)
  ) {
    return undefined;
  }

  const rollback: ArtifactEditRollback = {
    reasoning: message.reasoning,
    sessionTitle: message.sessionTitle,
    repairOfMessageId: message.repairOfMessageId,
    repairAttempt: message.repairAttempt
  };
  const pendingEdit: ArtifactEdit = {
    id: input.editId,
    origin: "chat-run",
    parentId: previousActiveEditId,
    createdAt: input.createdAt,
    prompt,
    references: [],
    promptBubble: false,
    activeVariantId: input.variantId,
    variants: [
      {
        id: input.variantId,
        operationId: input.operationId,
        createdAt: input.createdAt,
        status: "pending"
      }
    ],
    status: "pending",
    rollback
  };

  return {
    kind: "source",
    target: {
      sessionId: input.sessionId,
      assistantId: input.assistantId,
      sourceUserMessageId: input.sourceUserMessageId
    },
    runId: input.runId,
    operationId: input.operationId,
    editId: input.editId,
    variantId: input.variantId,
    previousActiveEditId,
    source,
    prompt,
    references: [],
    baseRawStream: message.artifactEditBaseRawStream ?? source,
    pendingEdit,
    rollback
  };
}

export function applyPendingGeneratedArtifactBatch(
  message: ClientMessage,
  operation: GeneratedArtifactBatchOperation,
  themeMode: PageThemeMode
): ClientMessage {
  if (
    message.id !== operation.target.assistantId ||
    !isGeneratedArtifactBatchSourceCurrent(message, operation)
  ) {
    return message;
  }

  return applyPendingArtifactEditOperation(message, operation, themeMode);
}

export function getGeneratedArtifactBatchAssistantPatch(
  message: ClientMessage,
  operation: GeneratedArtifactBatchOperation,
  themeMode: PageThemeMode
): Partial<ClientMessage> | undefined {
  const pending = applyPendingGeneratedArtifactBatch(
    message,
    operation,
    themeMode
  );
  if (pending === message) {
    return undefined;
  }

  return {
    artifactEditBaseRawStream: pending.artifactEditBaseRawStream,
    artifactEdits: pending.artifactEdits,
    activeArtifactEditId: pending.activeArtifactEditId
  };
}

export function isGeneratedArtifactBatchSourceCurrent(
  message: ClientMessage,
  operation: GeneratedArtifactBatchOperation
): boolean {
  if (
    message.role !== "assistant" ||
    message.id !== operation.target.assistantId ||
    message.artifactEdits?.some(hasPendingArtifactEditVariant) ||
    getResolvedArtifactEditId(message) !== operation.previousActiveEditId
  ) {
    return false;
  }

  return (
    getArtifactEditRawStream(message, operation.previousActiveEditId) ===
    operation.source
  );
}

function getMatchingServerEdit(
  patch: Partial<ClientMessage>,
  operation: GeneratedArtifactBatchOperation
): ArtifactEdit | undefined {
  return patch.artifactEdits?.find((edit) => edit.id === operation.editId);
}

function getMatchingServerVariant(
  patch: Partial<ClientMessage>,
  operation: GeneratedArtifactBatchOperation
) {
  return getMatchingServerEdit(patch, operation)?.variants.find(
    (variant) =>
      variant.id === operation.variantId &&
      variant.operationId === operation.operationId &&
      variant.createdAt === operation.pendingEdit.variants[0]?.createdAt
  );
}

function resolveTerminalPhase(
  patch: Partial<ClientMessage>,
  phase: ChatRunAssistantPhase,
  operation: GeneratedArtifactBatchOperation
): ChatRunAssistantPhase | "stale" {
  if (!Object.prototype.hasOwnProperty.call(patch, "artifactEdits")) {
    return phase;
  }

  const serverEdit = getMatchingServerEdit(patch, operation);
  if (!serverEdit) {
    return phase === "streaming" ? "stale" : "cancelled";
  }
  const serverVariant = getMatchingServerVariant(patch, operation);
  if (!serverVariant) {
    return "stale";
  }
  if (serverEdit.status === "complete" && serverVariant?.status === "complete") {
    return "complete";
  }
  if (serverEdit.status === "error" || serverVariant?.status === "error") {
    return "error";
  }
  return phase;
}

function mergePatchPreservingOperation(
  message: ClientMessage,
  patch: Partial<ClientMessage>,
  operation: GeneratedArtifactBatchOperation
): ClientMessage {
  const {
    id: _id,
    role: _role,
    artifactEditBaseRawStream: _artifactEditBaseRawStream,
    artifactEdits: _artifactEdits,
    activeArtifactEditId: _activeArtifactEditId,
    generationRunId: _generationRunId,
    ...safePatch
  } = patch;

  return {
    ...message,
    ...safePatch,
    id: message.id,
    role: message.role,
    generationRunId: operation.runId,
    artifactEditBaseRawStream: message.artifactEditBaseRawStream,
    artifactEdits: message.artifactEdits,
    activeArtifactEditId: message.activeArtifactEditId
  };
}

function restoreRollbackMetadata(
  message: ClientMessage,
  operation: GeneratedArtifactBatchOperation,
  sessionTitle: string | undefined
): ClientMessage {
  return {
    ...message,
    reasoning: operation.rollback.reasoning,
    sessionTitle: sessionTitle ?? operation.rollback.sessionTitle,
    repairOfMessageId: operation.rollback.repairOfMessageId,
    repairAttempt: operation.rollback.repairAttempt
  };
}

export function reduceGeneratedArtifactBatchPatch(
  message: ClientMessage,
  operation: GeneratedArtifactBatchOperation,
  patch: Partial<ClientMessage>,
  phase: ChatRunAssistantPhase,
  themeMode: PageThemeMode
): ClientMessage {
  if (
    message.id !== operation.target.assistantId ||
    message.generationRunId !== operation.runId ||
    !hasPendingArtifactEditOperation(message, operation)
  ) {
    return message;
  }

  let resolvedPhase = resolveTerminalPhase(patch, phase, operation);
  if (resolvedPhase === "stale") {
    return message;
  }
  const candidate = mergePatchPreservingOperation(message, patch, operation);
  const serverVariant = getMatchingServerVariant(patch, operation);
  const terminalRawStream =
    serverVariant?.rawStream ?? patch.rawStream ?? message.rawStream ?? "";
  const emptyCompletion =
    resolvedPhase === "complete" && !terminalRawStream.trim();
  if (emptyCompletion) {
    resolvedPhase = "error";
  }
  if (resolvedPhase === "streaming") {
    return candidate;
  }
  if (resolvedPhase === "complete") {
    return completeArtifactEditOperation(
      candidate,
      operation,
      {
        rawStream: terminalRawStream,
        summary: serverVariant?.summary,
        editCount: serverVariant?.editCount
      },
      themeMode
    );
  }
  if (resolvedPhase === "error") {
    const serverEdit = getMatchingServerEdit(patch, operation);
    const errorMessage =
      (emptyCompletion
        ? "The artifact regeneration completed without output."
        : patch.error?.trim() || serverEdit?.error?.trim()) ||
      "The artifact regeneration failed.";
    const projection = buildCompletedAssistantPatchFromRawStream(
      operation.source,
      themeMode
    );
    const failed = failArtifactEditOperation(
      candidate,
      operation,
      errorMessage
    );
    return {
      ...restoreRollbackMetadata(
        { ...failed, ...projection },
        operation,
        projection.sessionTitle
      ),
      activeArtifactEditId: operation.previousActiveEditId,
      status: "error",
      error: errorMessage
    };
  }

  const cancelled = cancelArtifactEditOperation(
    candidate,
    operation,
    themeMode
  );
  const projection = buildCompletedAssistantPatchFromRawStream(
    operation.source,
    themeMode
  );
  return {
    ...restoreRollbackMetadata(
      { ...cancelled, ...projection },
      operation,
      projection.sessionTitle
    ),
    status: "complete",
    error: undefined
  };
}

export function restoreGeneratedArtifactBatchOperation(
  sessionId: string,
  message: ClientMessage
): GeneratedArtifactBatchOperation | undefined {
  if (
    message.role !== "assistant" ||
    !message.generationRunId ||
    !message.artifactEdits?.length
  ) {
    return undefined;
  }

  const pendingEdit = [...message.artifactEdits]
    .reverse()
    .find(
      (edit) =>
        edit.origin === "chat-run" &&
        edit.status === "pending" &&
        edit.variants.some((variant) => variant.status === "pending")
    );
  if (!pendingEdit) {
    return undefined;
  }
  const pendingVariant =
    pendingEdit.variants.find(
      (variant) =>
        variant.id === pendingEdit.activeVariantId &&
        variant.status === "pending"
    ) ?? pendingEdit.variants.find((variant) => variant.status === "pending");
  if (!pendingVariant?.operationId) {
    return undefined;
  }

  const previousActiveEditId =
    pendingEdit.parentId &&
    message.artifactEdits.some((edit) => edit.id === pendingEdit.parentId)
      ? pendingEdit.parentId
      : undefined;
  const source =
    getArtifactEditRawStream(message, previousActiveEditId) ??
    message.artifactEditBaseRawStream ??
    "";
  if (!source.trim()) {
    return undefined;
  }
  const rollback = pendingEdit.rollback ?? {};

  return {
    kind: "source",
    target: {
      sessionId,
      assistantId: message.id,
      sourceUserMessageId: ""
    },
    runId: message.generationRunId,
    operationId: pendingVariant.operationId,
    editId: pendingEdit.id,
    variantId: pendingVariant.id,
    previousActiveEditId,
    source,
    prompt: pendingEdit.prompt,
    references: pendingEdit.references,
    baseRawStream: message.artifactEditBaseRawStream ?? source,
    pendingEdit,
    rollback
  };
}

export function finalizePersistedGeneratedArtifactBatch(
  sessionId: string,
  message: ClientMessage,
  themeMode: PageThemeMode
): ClientMessage {
  const operation = restoreGeneratedArtifactBatchOperation(sessionId, message);
  if (!operation || message.status === "streaming") {
    return message;
  }

  const phase: ChatRunAssistantPhase =
    message.status === "error"
      ? "error"
      : isChatCancelledMessage(message.content) ||
          isChatCancelledMessage(message.error)
        ? "cancelled"
        : !message.rawStream?.trim()
          ? "error"
        : "complete";
  const patch =
    phase === "error" && !message.error?.trim()
      ? {
          ...message,
          error: "The artifact regeneration completed without output."
        }
      : message;
  return reduceGeneratedArtifactBatchPatch(
    message,
    operation,
    patch,
    phase,
    themeMode
  );
}

export function finalizePersistedGeneratedArtifactBatches(
  state: SessionState,
  themeMode: PageThemeMode,
  now = Date.now(),
  skipRunIds: ReadonlySet<string> = new Set()
): SessionState {
  let changed = false;
  const sessions = state.sessions.map((session) => {
    let sessionChanged = false;
    const messages = session.messages.map((message) => {
      if (
        message.generationRunId &&
        skipRunIds.has(message.generationRunId)
      ) {
        return message;
      }
      const next = finalizePersistedGeneratedArtifactBatch(
        session.id,
        message,
        themeMode
      );
      if (next !== message) {
        sessionChanged = true;
      }
      return next;
    });
    if (!sessionChanged) {
      return session;
    }
    changed = true;
    return {
      ...session,
      title: summarizeSession(messages),
      updatedAt: Math.max(session.updatedAt, now),
      messages
    };
  });

  return changed
    ? {
        ...state,
        sessions: sortSessions(sessions)
      }
    : state;
}
