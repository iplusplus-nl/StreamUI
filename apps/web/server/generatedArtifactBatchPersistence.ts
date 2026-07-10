import type {
  SessionMessagePatch,
  SessionMessageSnapshot
} from "./sessions.js";

type ArtifactRecord = Record<string, unknown>;

type PendingGeneratedArtifactBatch = {
  edit: ArtifactRecord;
  editIndex: number;
  variant: ArtifactRecord;
};

export type GeneratedArtifactBatchIdentity = {
  editId: string;
  variantId: string;
  operationId: string;
  createdAt: number;
};

export type ChatRunPersistenceStatus = "streaming" | "complete" | "error";

export const CHAT_RUN_CANCELLED_MESSAGE = "Generation stopped.";

function objectValue(value: unknown): ArtifactRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ArtifactRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function artifactEdits(message: SessionMessageSnapshot): ArtifactRecord[] {
  return (message.artifactEdits ?? []).filter(
    (edit): edit is ArtifactRecord => Boolean(objectValue(edit))
  );
}

function editVariants(edit: ArtifactRecord): ArtifactRecord[] {
  return (Array.isArray(edit.variants) ? edit.variants : []).filter(
    (variant): variant is ArtifactRecord => Boolean(objectValue(variant))
  );
}

function findPendingGeneratedArtifactBatch(
  message: SessionMessageSnapshot
): PendingGeneratedArtifactBatch | undefined {
  const activeEditId = stringValue(message.activeArtifactEditId);
  if (!activeEditId) {
    return undefined;
  }

  const edits = artifactEdits(message);
  const editIndex = edits.findIndex((candidate) => candidate.id === activeEditId);
  const edit = edits[editIndex];
  if (!edit || edit.origin !== "chat-run" || edit.status !== "pending") {
    return undefined;
  }

  const activeVariantId = stringValue(edit.activeVariantId);
  if (!activeVariantId) {
    return undefined;
  }

  const variant = editVariants(edit).find(
    (candidate) => candidate.id === activeVariantId
  );
  if (
    !variant ||
    variant.status !== "pending" ||
    !stringValue(variant.operationId) ||
    typeof variant.createdAt !== "number" ||
    !Number.isFinite(variant.createdAt)
  ) {
    return undefined;
  }

  return { edit, editIndex, variant };
}

function pendingBatchIdentity(
  pending: PendingGeneratedArtifactBatch
): GeneratedArtifactBatchIdentity {
  return {
    editId: stringValue(pending.edit.id)!,
    variantId: stringValue(pending.variant.id)!,
    operationId: stringValue(pending.variant.operationId)!,
    createdAt: pending.variant.createdAt as number
  };
}

export function getGeneratedArtifactBatchIdentity(
  message: SessionMessageSnapshot | undefined
): GeneratedArtifactBatchIdentity | undefined {
  const pending = message
    ? findPendingGeneratedArtifactBatch(message)
    : undefined;
  return pending ? pendingBatchIdentity(pending) : undefined;
}

export function isGeneratedArtifactBatchIdentityCurrent(
  message: SessionMessageSnapshot,
  expected: GeneratedArtifactBatchIdentity
): boolean {
  const current = getGeneratedArtifactBatchIdentity(message);
  return Boolean(
    current &&
      current.editId === expected.editId &&
      current.variantId === expected.variantId &&
      current.operationId === expected.operationId &&
      current.createdAt === expected.createdAt
  );
}

export function canPersistGeneratedArtifactBatch(
  message: SessionMessageSnapshot,
  generationRunId: string,
  expected: GeneratedArtifactBatchIdentity
): boolean {
  return (
    message.generationRunId === generationRunId &&
    isGeneratedArtifactBatchIdentityCurrent(message, expected)
  );
}

function extractBetweenTag(
  raw: string,
  tagName: "chat" | "sessiontitle" | "streamui"
) {
  const openPattern = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const openMatch = openPattern.exec(raw);
  if (!openMatch || openMatch.index === undefined) {
    return { content: "", hasOpen: false, hasClose: false };
  }

  const start = openMatch.index + openMatch[0].length;
  const closePattern = new RegExp(`</${tagName}>`, "i");
  const closeMatch = closePattern.exec(raw.slice(start));
  const end = closeMatch ? start + closeMatch.index : raw.length;

  return {
    content: raw.slice(start, end),
    hasOpen: true,
    hasClose: Boolean(closeMatch)
  };
}

function stripProtocolTags(raw: string): string {
  return raw
    .replace(/<sessiontitle\b[^>]*>[\s\S]*?<\/sessiontitle>/gi, "")
    .replace(/<chat\b[^>]*>/gi, "")
    .replace(/<\/chat>/gi, "")
    .replace(/<streamui\b[^>]*>[\s\S]*?<\/streamui>/gi, "")
    .replace(/<streamui\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

export function buildAssistantPresentationPatch(
  rawStream: string
): Pick<
  SessionMessagePatch,
  "content" | "rawStream" | "hasStreamUi" | "streamUiComplete"
> {
  const chat = extractBetweenTag(rawStream, "chat");
  const streamUi = extractBetweenTag(rawStream, "streamui");

  return {
    content:
      chat.content.trim() ||
      (!streamUi.hasOpen ? stripProtocolTags(rawStream) : ""),
    rawStream,
    hasStreamUi: streamUi.hasOpen,
    streamUiComplete: streamUi.hasClose
  };
}

function activeCompleteVariantRawStream(
  edit: ArtifactRecord | undefined
): string | undefined {
  if (!edit || edit.status !== "complete") {
    return undefined;
  }

  const activeVariantId = stringValue(edit.activeVariantId);
  const variants = editVariants(edit);
  const variant =
    (activeVariantId
      ? variants.find((candidate) => candidate.id === activeVariantId)
      : undefined) ?? variants[0];
  return variant?.status === "complete" &&
    typeof variant.rawStream === "string"
    ? variant.rawStream
    : undefined;
}

function previousEditId(
  edits: ArtifactRecord[],
  pending: PendingGeneratedArtifactBatch
): string | undefined {
  const parentId = stringValue(pending.edit.parentId);
  return parentId && edits.some((edit) => edit.id === parentId)
    ? parentId
    : undefined;
}

function previousPresentationRawStream(
  message: SessionMessageSnapshot,
  edits: ArtifactRecord[],
  pending: PendingGeneratedArtifactBatch
): string | undefined {
  const visited = new Set<string>();
  let candidateId = previousEditId(edits, pending);

  while (candidateId && !visited.has(candidateId)) {
    visited.add(candidateId);
    const editIndex = edits.findIndex((edit) => edit.id === candidateId);
    const edit = edits[editIndex];
    const rawStream = activeCompleteVariantRawStream(edit);
    if (rawStream !== undefined) {
      return rawStream;
    }

    const parentId = stringValue(edit?.parentId);
    candidateId =
      parentId && edits.some((candidate) => candidate.id === parentId)
        ? parentId
        : editIndex > 0
          ? stringValue(edits[editIndex - 1]?.id)
          : undefined;
  }

  return typeof message.artifactEditBaseRawStream === "string"
    ? message.artifactEditBaseRawStream
    : message.rawStream;
}

function rollbackMetadataPatch(
  edit: ArtifactRecord,
  rawStream: string | undefined
): Partial<Pick<
  SessionMessagePatch,
  "reasoning" | "sessionTitle" | "repairOfMessageId" | "repairAttempt"
>> | undefined {
  const rollback = objectValue(edit.rollback);
  const rawSessionTitle =
    rawStream === undefined
      ? undefined
      : extractBetweenTag(rawStream, "sessiontitle");
  const restoredSessionTitle =
    rawSessionTitle?.hasClose && rawSessionTitle.content.trim()
      ? rawSessionTitle.content.trim()
      : undefined;
  if (!rollback && restoredSessionTitle === undefined) {
    return undefined;
  }

  if (!rollback) {
    return { sessionTitle: restoredSessionTitle };
  }

  return {
    reasoning:
      typeof rollback.reasoning === "string" ? rollback.reasoning : undefined,
    sessionTitle:
      restoredSessionTitle ??
      (typeof rollback.sessionTitle === "string"
        ? rollback.sessionTitle
        : undefined),
    repairOfMessageId:
      typeof rollback.repairOfMessageId === "string"
        ? rollback.repairOfMessageId
        : undefined,
    repairAttempt:
      typeof rollback.repairAttempt === "number" &&
      Number.isFinite(rollback.repairAttempt)
        ? rollback.repairAttempt
        : undefined
  };
}

function completeBatch(
  message: SessionMessageSnapshot,
  patch: SessionMessagePatch,
  pending: PendingGeneratedArtifactBatch
): SessionMessagePatch {
  const rawStream = typeof patch.rawStream === "string" ? patch.rawStream : "";
  const edits = artifactEdits(message).map((edit, index) => {
    if (index !== pending.editIndex) {
      return edit;
    }

    return {
      ...edit,
      status: "complete",
      error: undefined,
      variants: editVariants(edit).map((variant) =>
        variant === pending.variant
          ? {
              ...variant,
              status: "complete",
              rawStream,
              error: undefined
            }
          : variant
      )
    };
  });

  return {
    ...patch,
    status: "complete",
    error: undefined,
    artifactEditBaseRawStream: message.artifactEditBaseRawStream,
    artifactEdits: edits,
    activeArtifactEditId: stringValue(pending.edit.id)
  };
}

function failBatch(
  message: SessionMessageSnapshot,
  patch: SessionMessagePatch,
  pending: PendingGeneratedArtifactBatch,
  error: string | undefined
): SessionMessagePatch {
  const patchError = typeof patch.error === "string" ? patch.error.trim() : "";
  const errorMessage =
    error?.trim() || patchError || "The artifact regeneration failed.";
  const edits = artifactEdits(message);
  const rawStream = previousPresentationRawStream(message, edits, pending);
  const nextEdits = edits.map((edit, index) => {
    if (index !== pending.editIndex) {
      return edit;
    }

    return {
      ...edit,
      status: "error",
      error: errorMessage,
      variants: editVariants(edit).map((variant) =>
        variant === pending.variant
          ? {
              ...variant,
              status: "error",
              error: errorMessage
            }
          : variant
      )
    };
  });

  return {
    ...patch,
    status: "error",
    error: errorMessage,
    ...(rawStream === undefined ? {} : buildAssistantPresentationPatch(rawStream)),
    ...rollbackMetadataPatch(pending.edit, rawStream),
    artifactEditBaseRawStream: message.artifactEditBaseRawStream,
    artifactEdits: nextEdits,
    activeArtifactEditId: previousEditId(edits, pending)
  };
}

function cancelBatch(
  message: SessionMessageSnapshot,
  patch: SessionMessagePatch,
  pending: PendingGeneratedArtifactBatch
): SessionMessagePatch {
  const edits = artifactEdits(message);
  const rawStream = previousPresentationRawStream(message, edits, pending);
  const previousActiveEditId = previousEditId(edits, pending);
  const nextEdits = edits.filter((_, index) => index !== pending.editIndex);

  return {
    ...patch,
    status: "complete",
    error: undefined,
    ...(rawStream === undefined ? {} : buildAssistantPresentationPatch(rawStream)),
    ...rollbackMetadataPatch(pending.edit, rawStream),
    artifactEditBaseRawStream: nextEdits.length
      ? message.artifactEditBaseRawStream
      : undefined,
    artifactEdits: nextEdits.length ? nextEdits : undefined,
    activeArtifactEditId: previousActiveEditId
  };
}

export function finalizeGeneratedArtifactBatchPatch({
  assistantMessage,
  patch,
  status,
  error,
  expectedIdentity
}: {
  assistantMessage: SessionMessageSnapshot | undefined;
  patch: SessionMessagePatch;
  status: ChatRunPersistenceStatus;
  error?: string;
  expectedIdentity?: GeneratedArtifactBatchIdentity;
}): SessionMessagePatch {
  if (!assistantMessage) {
    return patch;
  }

  const pending = findPendingGeneratedArtifactBatch(assistantMessage);
  if (
    !pending ||
    (expectedIdentity &&
      !isGeneratedArtifactBatchIdentityCurrent(
        assistantMessage,
        expectedIdentity
      ))
  ) {
    return patch;
  }
  if (status === "streaming") {
    return patch;
  }

  if (status === "complete" && error === CHAT_RUN_CANCELLED_MESSAGE) {
    return cancelBatch(assistantMessage, patch, pending);
  }

  if (
    status === "complete" &&
    !(typeof patch.rawStream === "string" && patch.rawStream.trim())
  ) {
    return failBatch(
      assistantMessage,
      patch,
      pending,
      "The artifact regeneration completed without output."
    );
  }

  return status === "complete"
    ? completeBatch(assistantMessage, patch, pending)
    : failBatch(assistantMessage, patch, pending, error);
}
