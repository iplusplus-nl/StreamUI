import {
  buildArtifactContext,
  type ArtifactContext
} from "../../core/artifactContext";
import type { ClientMessage } from "../../domain/chat/sessionModel";
import { extractStreamUiParts } from "../../runtime/streamui/protocol";
import type { RenderSnapshot } from "../../runtime/streamui/types";
import { sanitizeChatErrorMessage } from "./chatErrors";

export type ChatRunPresentationInput = {
  raw: string;
  reasoning: string;
  streamSequence: number;
};

export type CompletedChatRunProjection = {
  patch: Partial<ClientMessage> & {
    artifactContext: ArtifactContext | undefined;
    snapshot: RenderSnapshot | undefined;
    status: "complete";
  };
  streamUiSource?: string;
};

export type StreamingChatRunProjection = {
  patch: Partial<ClientMessage>;
  streamUiSource?: string;
};

export function projectStreamingChatRun(
  raw: string,
  streamSequence?: number
): StreamingChatRunProjection {
  const parts = extractStreamUiParts(raw);
  const streamUiSource = parts.hasStreamUi ? parts.streamui : undefined;
  const artifactContext =
    parts.hasStreamUi && parts.streamUiComplete && parts.streamui.trim()
      ? buildArtifactContext(raw)
      : undefined;
  const sessionTitle =
    parts.sessionTitleComplete && parts.sessionTitle.trim()
      ? parts.sessionTitle
      : undefined;

  return {
    patch: {
      content: parts.chat || (!parts.hasStreamUi ? parts.fallbackText : ""),
      rawStream: raw,
      ...(artifactContext ? { artifactContext } : {}),
      ...(sessionTitle ? { sessionTitle } : {}),
      hasStreamUi: parts.hasStreamUi,
      streamUiComplete: parts.streamUiComplete,
      ...(typeof streamSequence === "number" ? { streamSequence } : {})
    },
    streamUiSource
  };
}

export function projectCompletedChatRun(
  input: ChatRunPresentationInput
): CompletedChatRunProjection {
  const parts = extractStreamUiParts(input.raw);
  const streamUiSource =
    parts.hasStreamUi && parts.streamui.trim() ? parts.streamui : undefined;
  const artifactContext = streamUiSource
    ? buildArtifactContext(input.raw)
    : undefined;

  return {
    patch: {
      content: parts.chat || parts.fallbackText,
      reasoning: input.reasoning,
      sessionTitle:
        parts.sessionTitleComplete && parts.sessionTitle.trim()
          ? parts.sessionTitle
          : undefined,
      rawStream: input.raw,
      streamSequence: input.streamSequence,
      snapshot: undefined,
      artifactContext,
      hasStreamUi: Boolean(streamUiSource),
      streamUiComplete: parts.streamUiComplete,
      status: "complete"
    },
    streamUiSource
  };
}

export function projectFailedChatRun(
  input: ChatRunPresentationInput & { error: string }
): Partial<ClientMessage> {
  const parts = extractStreamUiParts(input.raw);

  return {
    content:
      parts.chat ||
      parts.fallbackText ||
      "I could not complete that request.",
    reasoning: input.reasoning,
    rawStream: input.raw,
    streamSequence: input.streamSequence,
    error: sanitizeChatErrorMessage(input.error),
    status: "error"
  };
}
