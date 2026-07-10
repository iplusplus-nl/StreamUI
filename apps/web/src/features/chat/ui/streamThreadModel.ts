import {
  MAX_ARTIFACT_SELECTIONS,
  canCaptureArtifactSelection,
  type ArtifactSelection,
  type ArtifactSelectionPayload
} from "../../../core/artifactSelection";
import { stripSyntheticReasoningStatus } from "../../../core/reasoningText";
import type {
  ArtifactEdit,
  ClientMessage
} from "../../../domain/chat/sessionModel";
import {
  getActiveArtifactEditChain,
  getResolvedArtifactEditId,
  hasPendingArtifactEditVariant,
  shouldShowArtifactEditPromptBubble
} from "../../artifacts/artifactEditModel";

export type ArtifactEditTimeline = {
  assistantId: string;
  edits: ArtifactEdit[];
  activeEditId?: string;
  disabled?: boolean;
};

export function buildArtifactEditTimelineByUserId(
  messages: readonly ClientMessage[]
): Map<string, ArtifactEditTimeline> {
  const byUserId = new Map<string, ArtifactEditTimeline>();

  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    if (assistant.role !== "assistant" || !assistant.artifactEdits?.length) {
      continue;
    }

    const activeEditId = getResolvedArtifactEditId(assistant);
    const timeline: ArtifactEditTimeline = {
      assistantId: assistant.id,
      edits: getActiveArtifactEditChain(assistant).filter(
        shouldShowArtifactEditPromptBubble
      ),
      activeEditId,
      disabled:
        assistant.status === "streaming" ||
        assistant.artifactEdits.some(hasPendingArtifactEditVariant)
    };

    for (let userIndex = index - 1; userIndex >= 0; userIndex -= 1) {
      const user = messages[userIndex];
      if (user.role !== "user") {
        continue;
      }

      byUserId.set(user.id, timeline);
      break;
    }
  }

  return byUserId;
}

export function groupArtifactSelectionsByMessageId(
  selections: readonly ArtifactSelection[]
): Map<string, ArtifactSelection[]> {
  const grouped = new Map<string, ArtifactSelection[]>();

  for (const selection of selections) {
    const group = grouped.get(selection.messageId) ?? [];
    group.push(selection);
    grouped.set(selection.messageId, group);
  }

  return grouped;
}

export function addArtifactSelection(
  current: readonly ArtifactSelection[],
  messageId: string,
  selection: ArtifactSelectionPayload,
  meta: { id: string; createdAt: number }
): ArtifactSelection[] {
  const nextSelection: ArtifactSelection = {
    ...selection,
    id: meta.id,
    messageId,
    createdAt: meta.createdAt
  };
  const next = current
    .filter(
      (item) => item.messageId === messageId && item.key !== selection.key
    )
    .concat(nextSelection);

  return next.slice(Math.max(0, next.length - MAX_ARTIFACT_SELECTIONS));
}

export function retainVisibleArtifactSelections(
  current: ArtifactSelection[],
  visibleMessageIds: ReadonlySet<string>
): ArtifactSelection[] {
  const next = current.filter((selection) =>
    visibleMessageIds.has(selection.messageId)
  );

  return next.length === current.length ? current : next;
}

export function removeArtifactSelectionsForMessage(
  current: ArtifactSelection[],
  messageId: string
): ArtifactSelection[] {
  const next = current.filter(
    (selection) => selection.messageId !== messageId
  );
  return next.length === current.length ? current : next;
}

export function retainCapturableArtifactSelections(
  current: ArtifactSelection[],
  artifactEditingEnabled: boolean
): ArtifactSelection[] {
  if (artifactEditingEnabled) {
    return current;
  }

  const next = current.filter((selection) =>
    canCaptureArtifactSelection(selection.kind, false)
  );

  return next.length === current.length ? current : next;
}

export function resolveSelectionModeMessageId(
  current: string | null,
  messageById: ReadonlyMap<string, ClientMessage>
): string | null {
  if (!current) {
    return null;
  }

  const activeMessage = messageById.get(current);
  return activeMessage?.role === "assistant" &&
    activeMessage.status === "complete"
    ? current
    : null;
}

export function toggleSelectionModeMessageId(
  current: string | null,
  messageId: string,
  enabled: boolean,
  artifactEditingEnabled: boolean
): string | null {
  if (!artifactEditingEnabled) {
    return null;
  }

  if (enabled) {
    return current === messageId ? null : messageId;
  }

  return current === messageId ? null : current;
}

export function canShowReasoningActivity(
  message: ClientMessage | undefined
): boolean {
  return Boolean(
    message?.role === "assistant" &&
      (message.status === "streaming" ||
        stripSyntheticReasoningStatus(message.reasoning ?? "").trim())
  );
}
