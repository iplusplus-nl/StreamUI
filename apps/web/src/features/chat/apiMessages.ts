import type { ClientMessage } from "../../domain/chat/sessionModel";
import {
  buildArtifactContext,
  htmlToTranscriptText,
  type ArtifactContext
} from "../../core/artifactContext";

export { htmlToTranscriptText };

type ApiMessageContentOptions = {
  detail?: "recent" | "summary";
};

const RECENT_CONTEXT_MESSAGE_COUNT = 8;
const MAX_CONTEXT_CHARS = 28_000;
const MAX_RECENT_MESSAGE_CHARS = 8_000;
const MAX_SUMMARY_MESSAGE_CHARS = 2_400;
const STREAMUI_TAG_PATTERN = /<streamui\b/i;

function clipEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function getArtifactContext(message: ClientMessage): ArtifactContext | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }

  if (message.artifactContext) {
    return message.artifactContext;
  }

  if (
    !message.rawStream ||
    (!message.hasStreamUi && !STREAMUI_TAG_PATTERN.test(message.rawStream))
  ) {
    return undefined;
  }

  return buildArtifactContext(message.rawStream);
}

function formatArtifactContext(
  context: ArtifactContext,
  detail: "recent" | "summary"
): string {
  const textSummary = context.textSummary || "No visible text captured.";
  const lines = [
    `[StreamUI artifact ${context.id}]`,
    `Source hash: ${context.sourceHash}; source chars: ${context.sourceChars}`,
    `Visible text summary: ${clipEnd(
      textSummary,
      detail === "recent" ? 1_600 : 700
    )}`,
    `Structure summary: ${clipEnd(
      context.structureSummary || "No structure captured.",
      detail === "recent" ? 1_000 : 500
    )}`,
    `Style summary: ${clipEnd(
      context.styleSummary || "No style hints captured.",
      detail === "recent" ? 1_000 : 400
    )}`,
    `Editable summary: ${clipEnd(
      context.editableSummary || "No editable details captured.",
      detail === "recent" ? 1_200 : 500
    )}`
  ];

  return lines.join("\n");
}

export function getApiMessageContent(
  message: ClientMessage,
  options: ApiMessageContentOptions = {}
): string {
  const detail = options.detail ?? "recent";
  const visibleContent = message.content.trim();
  const artifactContext = getArtifactContext(message);

  if (visibleContent && artifactContext) {
    return `${visibleContent}\n\n${formatArtifactContext(artifactContext, detail)}`;
  }

  if (visibleContent) {
    return visibleContent;
  }

  if (artifactContext) {
    return formatArtifactContext(artifactContext, detail);
  }

  if (
    message.role === "assistant" &&
    message.rawStream &&
    (message.hasStreamUi || STREAMUI_TAG_PATTERN.test(message.rawStream))
  ) {
    return "[Assistant produced a StreamUI artifact for this turn.]";
  }

  return message.content;
}

function getMessageLimit(detail: "recent" | "summary"): number {
  return detail === "recent" ? MAX_RECENT_MESSAGE_CHARS : MAX_SUMMARY_MESSAGE_CHARS;
}

function toCandidateApiMessages(messages: ClientMessage[]) {
  const filteredMessages = messages.filter((message) => message.id !== "welcome");

  return filteredMessages
    .map((message, index) => {
      const detail =
        index >= filteredMessages.length - RECENT_CONTEXT_MESSAGE_COUNT
          ? "recent"
          : "summary";
      const content = clipEnd(
        getApiMessageContent(message, { detail }),
        getMessageLimit(detail)
      );
      const images = message.attachments?.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        dataUrl: attachment.dataUrl
      }));

      return {
        role: message.role,
        content,
        images
      };
    })
    .filter(
      (message) =>
        message.role === "user" ||
        message.content.trim() ||
        (message.images?.length ?? 0) > 0
    );
}

function applyContextBudget<T extends { role: string; content: string }>(
  messages: T[]
): T[] {
  const selected = new Set<number>();
  let latestUserIndex = -1;
  let usedChars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const forceInclude = index === latestUserIndex;
    const cost = message.content.length;

    if (forceInclude || usedChars + cost <= MAX_CONTEXT_CHARS) {
      selected.add(index);
      usedChars += cost;
    }
  }

  return messages.filter((_message, index) => selected.has(index));
}

export function toApiMessages(messages: ClientMessage[]) {
  return applyContextBudget(toCandidateApiMessages(messages));
}
