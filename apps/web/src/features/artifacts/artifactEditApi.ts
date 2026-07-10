import { clientRequestHeaders } from "../../api/client";
import type { ArtifactEditReference } from "../../domain/chat/sessionModel";
import { formatChatHttpError } from "../chat/chatErrors";

type FetchLike = typeof fetch;

function throwIfArtifactEditAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  const error = new Error("The artifact edit request was aborted.");
  error.name = "AbortError";
  throw error;
}

export type ArtifactEditResponse = {
  rawStream: string;
  summary?: string;
  edits?: Array<{
    note?: string;
    occurrence?: number;
    findLength?: number;
    replaceLength?: number;
  }>;
};

export type ArtifactEditRequest = {
  source: string;
  prompt: string;
  references: ArtifactEditReference[];
  apiSettings: unknown;
};

export function normalizeArtifactEditResponse(
  input: unknown
): ArtifactEditResponse {
  if (!input || typeof input !== "object") {
    throw new Error("The artifact edit response was empty.");
  }

  const response = input as Partial<ArtifactEditResponse>;
  if (typeof response.rawStream !== "string" || !response.rawStream.trim()) {
    throw new Error("The artifact edit did not return updated source.");
  }

  return {
    rawStream: response.rawStream,
    summary:
      typeof response.summary === "string" && response.summary.trim()
        ? response.summary.trim().slice(0, 500)
        : undefined,
    edits: Array.isArray(response.edits) ? response.edits : undefined
  };
}

export function didArtifactEditChangeSource(
  before: string,
  after: string
): boolean {
  return before.trim() !== after.trim();
}

export async function requestArtifactEdit(
  request: ArtifactEditRequest,
  clientId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<ArtifactEditResponse> {
  throwIfArtifactEditAborted(signal);
  const response = await fetchImpl("/api/artifact-edits", {
    method: "POST",
    headers: clientRequestHeaders(clientId, "application/json"),
    signal,
    body: JSON.stringify(request)
  });
  throwIfArtifactEditAborted(signal);

  if (!response.ok) {
    const errorText = await response.text();
    throwIfArtifactEditAborted(signal);
    throw new Error(formatChatHttpError(response, errorText));
  }

  const responseBody = await response.json();
  throwIfArtifactEditAborted(signal);
  const result = normalizeArtifactEditResponse(responseBody);
  if (!didArtifactEditChangeSource(request.source, result.rawStream)) {
    throw new Error(
      "The artifact edit did not change the source. Try a more specific prompt or select a larger reference."
    );
  }

  return result;
}
