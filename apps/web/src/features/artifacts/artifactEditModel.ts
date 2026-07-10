import type {
  ArtifactEdit,
  ArtifactEditReference,
  ClientMessage
} from "../../domain/chat/sessionModel";

export type ArtifactVersionInfo = {
  activeIndex: number;
  total: number;
  previousEditId?: string | null;
  nextEditId?: string | null;
  disabled?: boolean;
};

export function getArtifactEditRawStream(
  message: ClientMessage,
  editId: string | undefined
): string | undefined {
  if (!editId) {
    return message.artifactEditBaseRawStream ?? message.rawStream;
  }

  const edit = message.artifactEdits?.find((item) => item.id === editId);
  return edit ? getArtifactEditCompleteRawStream(edit) : undefined;
}

export function getArtifactEditDisplayRawStream(
  message: ClientMessage,
  editId: string | undefined
): string | undefined {
  const rawStream = getArtifactEditRawStream(message, editId);
  if (rawStream || !editId) {
    return rawStream;
  }

  const edits = message.artifactEdits ?? [];
  const edit = edits.find((item) => item.id === editId);
  if (!edit || edit.status !== "error") {
    return undefined;
  }

  return getArtifactEditRawStream(
    message,
    getArtifactEditParentId(edits, edit)
  );
}

export function getArtifactEditActiveVariant(edit: ArtifactEdit) {
  return (
    edit.variants.find((item) => item.id === edit.activeVariantId) ??
    edit.variants[0]
  );
}

export function getArtifactEditCompleteRawStream(
  edit: ArtifactEdit
): string | undefined {
  if (edit.status !== "complete") {
    return undefined;
  }

  const variant = getArtifactEditActiveVariant(edit);
  return variant?.status === "complete" ? variant.rawStream : undefined;
}

export function hasUsableArtifactEditVariant(edit: ArtifactEdit): boolean {
  return Boolean(getArtifactEditCompleteRawStream(edit));
}

export function hasPendingArtifactEditVariant(edit: ArtifactEdit): boolean {
  return (
    edit.status === "pending" ||
    edit.variants.some((variant) => variant.status === "pending")
  );
}

export function shouldShowArtifactEditPromptBubble(edit: ArtifactEdit): boolean {
  return edit.promptBubble !== false;
}

export function shouldKeepFailedArtifactEditVersion(edit: ArtifactEdit): boolean {
  return edit.status === "error" && shouldShowArtifactEditPromptBubble(edit);
}

export function getArtifactEditParentId(
  edits: ArtifactEdit[],
  edit: ArtifactEdit
): string | undefined {
  if (edit.parentId && edits.some((candidate) => candidate.id === edit.parentId)) {
    return edit.parentId;
  }

  if (edit.origin === "chat-run") {
    return undefined;
  }

  const index = edits.findIndex((candidate) => candidate.id === edit.id);
  return index > 0 ? edits[index - 1].id : undefined;
}

export function getArtifactEditChain(
  edits: ArtifactEdit[],
  editId: string | undefined
): ArtifactEdit[] {
  if (!editId) {
    return [];
  }

  const byId = new Map(edits.map((edit) => [edit.id, edit]));
  const chain: ArtifactEdit[] = [];
  const seen = new Set<string>();
  let current = byId.get(editId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const parentId = getArtifactEditParentId(edits, current);
    current = parentId ? byId.get(parentId) : undefined;
  }

  return chain.reverse();
}

export function getResolvedArtifactEditId(
  message: ClientMessage
): string | undefined {
  const edits = message.artifactEdits ?? [];
  if (
    message.activeArtifactEditId &&
    edits.some((edit) => edit.id === message.activeArtifactEditId)
  ) {
    return message.activeArtifactEditId;
  }

  if (!message.rawStream) {
    return undefined;
  }

  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit.status !== "complete") {
      continue;
    }

    const variant =
      edit.variants.find((item) => item.id === edit.activeVariantId) ??
      edit.variants[0];
    if (variant?.status === "complete" && variant.rawStream === message.rawStream) {
      return edit.id;
    }
  }

  return undefined;
}

export function getActiveArtifactEditChain(
  message: ClientMessage
): ArtifactEdit[] {
  return getArtifactEditChain(
    message.artifactEdits ?? [],
    getResolvedArtifactEditId(message)
  );
}

export function getArtifactVersionInfo(
  message: ClientMessage
): ArtifactVersionInfo | undefined {
  const activeEditId = getResolvedArtifactEditId(message) ?? null;
  const hasOriginal = Boolean(
    (message.artifactEditBaseRawStream ?? message.rawStream)?.trim()
  );
  const edits = message.artifactEdits ?? [];
  const versions: Array<{ editId: string | null }> = hasOriginal
    ? [{ editId: null }]
    : [];

  for (const edit of edits) {
    if (
      hasUsableArtifactEditVariant(edit) ||
      hasPendingArtifactEditVariant(edit) ||
      shouldKeepFailedArtifactEditVersion(edit) ||
      edit.id === activeEditId
    ) {
      versions.push({ editId: edit.id });
    }
  }

  if (versions.length <= 1) {
    return undefined;
  }

  const activeIndex = versions.findIndex(
    (version) => version.editId === activeEditId
  );
  const resolvedActiveIndex = activeIndex >= 0 ? activeIndex : 0;
  const isVersionSwitchDisabled =
    message.status === "streaming" || edits.some(hasPendingArtifactEditVariant);

  return {
    activeIndex: resolvedActiveIndex,
    total: versions.length,
    previousEditId: isVersionSwitchDisabled
      ? undefined
      : versions[resolvedActiveIndex - 1]?.editId,
    nextEditId: isVersionSwitchDisabled
      ? undefined
      : versions[resolvedActiveIndex + 1]?.editId,
    disabled: isVersionSwitchDisabled
  };
}

export function getPendingArtifactEditReferences(
  message: ClientMessage
): ArtifactEditReference[] {
  const seen = new Set<string>();
  const references: ArtifactEditReference[] = [];

  for (const edit of message.artifactEdits ?? []) {
    if (edit.status !== "pending") {
      continue;
    }

    for (const reference of edit.references) {
      const key = `${reference.kind}:${reference.selector}:${reference.key}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      references.push(reference);
    }
  }

  return references;
}
