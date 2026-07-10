import type {
  ArtifactEdit,
  ArtifactEditReference,
  ClientMessage
} from "../../domain/chat/sessionModel";
import type { PageThemeMode } from "../../runtime/streamui/types";
import {
  getArtifactEditDisplayRawStream,
  getArtifactEditParentId,
  getArtifactEditRawStream,
  getResolvedArtifactEditId,
  hasUsableArtifactEditVariant
} from "./artifactEditModel";
import { buildCompletedAssistantPatchFromRawStream } from "./artifactMessageProjection";
import {
  completeArtifactEditVariant,
  failArtifactEditVariant,
  removeArtifactEdit
} from "./artifactEditTransitions";

export type ArtifactEditOperation = {
  kind: "source" | "regeneration";
  targetEditId?: string;
  operationId: string;
  editId: string;
  variantId: string;
  previousActiveEditId?: string;
  source: string;
  prompt: string;
  references: ArtifactEditReference[];
  baseRawStream: string;
  pendingEdit: ArtifactEdit;
  retryOriginalEdit?: ArtifactEdit;
};

export type PrepareArtifactSourceEditInput = {
  prompt: string;
  references: ArtifactEditReference[];
  editId: string;
  variantId: string;
  operationId: string;
  createdAt: number;
};

export type ArtifactEditRegenerationFactories = {
  createEditId(): string;
  createVariantId(): string;
  createOperationId(): string;
  now(): number;
};

export type PrepareArtifactEditRegenerationResult =
  | { status: "missing" }
  | { status: "pending" }
  | { status: "invalid" }
  | { status: "ready"; operation: ArtifactEditOperation };

export type CompleteArtifactEditOperationInput = {
  rawStream: string;
  summary?: string;
  editCount?: number;
};

export function prepareArtifactSourceEdit(
  message: ClientMessage,
  input: PrepareArtifactSourceEditInput
): ArtifactEditOperation | undefined {
  const prompt = input.prompt.trim();
  const previousActiveEditId = getResolvedArtifactEditId(message);
  const source =
    getArtifactEditRawStream(message, previousActiveEditId) ?? "";
  if (message.role !== "assistant" || !prompt || !source.trim()) {
    return undefined;
  }

  const pendingEdit: ArtifactEdit = {
    id: input.editId,
    parentId: previousActiveEditId,
    createdAt: input.createdAt,
    prompt,
    references: input.references,
    activeVariantId: input.variantId,
    variants: [
      {
        id: input.variantId,
        operationId: input.operationId,
        createdAt: input.createdAt,
        status: "pending"
      }
    ],
    status: "pending"
  };

  return {
    kind: "source",
    operationId: input.operationId,
    editId: input.editId,
    variantId: input.variantId,
    previousActiveEditId,
    source,
    prompt,
    references: input.references,
    baseRawStream: message.artifactEditBaseRawStream ?? source,
    pendingEdit
  };
}

export function prepareArtifactEditRegeneration(
  message: ClientMessage,
  editId: string,
  nextPrompt: string | undefined,
  factories: ArtifactEditRegenerationFactories
): PrepareArtifactEditRegenerationResult {
  if (message.role !== "assistant") {
    return { status: "missing" };
  }

  const edits = message.artifactEdits ?? [];
  const edit = edits.find((candidate) => candidate.id === editId);
  if (!edit) {
    return { status: "missing" };
  }
  if (edits.some((candidate) => candidate.status === "pending")) {
    return { status: "pending" };
  }

  const isPromptEdit = nextPrompt !== undefined;
  const prompt = (nextPrompt ?? edit.prompt).trim();
  const sourceEditId = getArtifactEditParentId(edits, edit);
  const source = getArtifactEditRawStream(message, sourceEditId) ?? "";
  if (!prompt || !source.trim()) {
    return { status: "invalid" };
  }

  const retryExistingFailedEdit =
    edit.status === "error" && !hasUsableArtifactEditVariant(edit);
  const variantId =
    retryExistingFailedEdit && edit.activeVariantId
      ? edit.activeVariantId
      : factories.createVariantId();
  const nextEditId = retryExistingFailedEdit
    ? edit.id
    : factories.createEditId();
  const createdAt = factories.now();
  const operationId = factories.createOperationId();
  const pendingEdit: ArtifactEdit = {
    id: nextEditId,
    parentId: sourceEditId,
    createdAt,
    prompt,
    references: edit.references,
    promptBubble: isPromptEdit ? undefined : false,
    activeVariantId: variantId,
    variants: [
      {
        id: variantId,
        operationId,
        createdAt,
        status: "pending"
      }
    ],
    status: "pending"
  };

  return {
    status: "ready",
    operation: {
      kind: "regeneration",
      targetEditId: edit.id,
      operationId,
      editId: nextEditId,
      variantId,
      previousActiveEditId: getResolvedArtifactEditId(message),
      source,
      prompt,
      references: edit.references,
      baseRawStream: message.artifactEditBaseRawStream ?? source,
      pendingEdit,
      ...(retryExistingFailedEdit ? { retryOriginalEdit: edit } : {})
    }
  };
}

function restartFailedEdit(
  edit: ArtifactEdit,
  operation: ArtifactEditOperation
): ArtifactEdit {
  const pendingVariant = operation.pendingEdit.variants[0];
  const hasVariant = edit.variants.some(
    (variant) => variant.id === operation.variantId
  );

  return {
    ...edit,
    prompt: operation.prompt,
    status: "pending",
    error: undefined,
    activeVariantId: operation.variantId,
    variants: hasVariant
      ? edit.variants.map((variant) =>
          variant.id === operation.variantId
            ? {
                ...variant,
                operationId: operation.operationId,
                createdAt: pendingVariant.createdAt,
                status: "pending",
                rawStream: undefined,
                summary: undefined,
                error: undefined,
                editCount: undefined
              }
            : variant
        )
      : [...edit.variants, pendingVariant]
  };
}

export function applyPendingArtifactEditOperation(
  message: ClientMessage,
  operation: ArtifactEditOperation,
  themeMode: PageThemeMode
): ClientMessage {
  if (
    operation.kind === "regeneration" &&
    (!operation.targetEditId ||
      !(message.artifactEdits ?? []).some(
        (edit) => edit.id === operation.targetEditId
      ))
  ) {
    return message;
  }

  const artifactEdits = operation.retryOriginalEdit
    ? (message.artifactEdits ?? []).map((edit) =>
        edit.id === operation.editId
          ? restartFailedEdit(edit, operation)
          : edit
      )
    : [...(message.artifactEdits ?? []), operation.pendingEdit];

  return {
    ...message,
    ...buildCompletedAssistantPatchFromRawStream(operation.source, themeMode),
    artifactEditBaseRawStream:
      message.artifactEditBaseRawStream ?? operation.baseRawStream,
    artifactEdits,
    activeArtifactEditId: operation.editId
  };
}

export function hasPendingArtifactEditOperation(
  message: ClientMessage,
  operation: ArtifactEditOperation
): boolean {
  const edit = message.artifactEdits?.find(
    (candidate) => candidate.id === operation.editId
  );
  if (!edit || edit.status !== "pending") {
    return false;
  }

  const variant = edit.variants.find(
    (candidate) => candidate.id === operation.variantId
  );
  const pendingVariant = operation.pendingEdit.variants.find(
    (candidate) => candidate.id === operation.variantId
  );
  return (
    variant?.status === "pending" &&
    variant.operationId === operation.operationId &&
    variant.createdAt === pendingVariant?.createdAt
  );
}

export function completeArtifactEditOperation(
  message: ClientMessage,
  operation: ArtifactEditOperation,
  input: CompleteArtifactEditOperationInput,
  themeMode: PageThemeMode
): ClientMessage {
  if (!hasPendingArtifactEditOperation(message, operation)) {
    return message;
  }

  return completeArtifactEditVariant(
    {
      ...message,
      ...buildCompletedAssistantPatchFromRawStream(input.rawStream, themeMode)
    },
    {
      editId: operation.editId,
      variantId: operation.variantId,
      rawStream: input.rawStream,
      summary: input.summary,
      editCount: input.editCount,
      baseRawStream: operation.baseRawStream
    }
  );
}

export function failArtifactEditOperation(
  message: ClientMessage,
  operation: ArtifactEditOperation,
  errorMessage: string
): ClientMessage {
  if (!hasPendingArtifactEditOperation(message, operation)) {
    return message;
  }

  return failArtifactEditVariant(
    message,
    operation.editId,
    operation.variantId,
    errorMessage
  );
}

export function cancelArtifactEditOperation(
  message: ClientMessage,
  operation: ArtifactEditOperation,
  themeMode: PageThemeMode
): ClientMessage {
  if (!hasPendingArtifactEditOperation(message, operation)) {
    return message;
  }

  const rolledBack = operation.retryOriginalEdit
    ? {
        ...message,
        artifactEdits: (message.artifactEdits ?? []).map((edit) =>
          edit.id === operation.editId ? operation.retryOriginalEdit! : edit
        ),
        activeArtifactEditId: operation.previousActiveEditId
      }
    : removeArtifactEdit(
        message,
        operation.editId,
        operation.previousActiveEditId
      );
  const fallbackRawStream = getArtifactEditDisplayRawStream(
    rolledBack,
    operation.previousActiveEditId
  );

  return {
    ...rolledBack,
    ...(fallbackRawStream
      ? buildCompletedAssistantPatchFromRawStream(
          fallbackRawStream,
          themeMode
        )
      : {}),
    activeArtifactEditId: operation.previousActiveEditId
  };
}

export type SelectArtifactEditVersionResult = {
  message: ClientMessage;
  selected: boolean;
};

export function selectArtifactEditVersion(
  message: ClientMessage,
  editId: string | undefined,
  themeMode: PageThemeMode
): SelectArtifactEditVersionResult {
  if (message.role !== "assistant") {
    return { message, selected: false };
  }

  const rawStream = getArtifactEditDisplayRawStream(message, editId);
  if (!rawStream) {
    return { message, selected: false };
  }

  return {
    message: {
      ...message,
      ...buildCompletedAssistantPatchFromRawStream(rawStream, themeMode),
      activeArtifactEditId: editId
    },
    selected: true
  };
}
