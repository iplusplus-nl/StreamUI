import { clientRequestHeaders } from "../../api/client";
import { apiUrl } from "../../api/appUrl";
import type { ArtifactEditReference } from "../../domain/chat/sessionModel";
import { normalizeApiSettings } from "../../core/apiSettings";
import { formatChatHttpError } from "../chat/chatErrors";
import { requestBrowserDirectText } from "../providers/browserDirectProvider";
import { COMFORTABLE_LEGIBILITY_PROMPT } from "../../server/visualLegibilityPolicy";

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

const STREAMUI_BLOCK_PATTERN = /<streamui\b[^>]*>[\s\S]*?<\/streamui>/i;

async function requestBrowserDirectArtifactEdit(
  request: ArtifactEditRequest,
  signal: AbortSignal,
  fetchImpl: FetchLike
): Promise<ArtifactEditResponse> {
  const originalBlock = request.source.match(STREAMUI_BLOCK_PATTERN)?.[0];
  if (!originalBlock) {
    throw new Error("The original artifact has no complete streamui block.");
  }
  const rawModelText = await requestBrowserDirectText(
    normalizeApiSettings(request.apiSettings),
    {
      instructions: `You edit an existing ChatHTML artifact.

Return only one complete <streamui>...</streamui> block containing the updated artifact. Do not return markdown fences, JSON, commentary, <chat>, or <sessiontitle>.
- Apply the user's request to ORIGINAL_SOURCE.
- Selected references are anchors for intent and disambiguation, not hard edit boundaries.
- Preserve working behavior that the user did not ask to change.
- Keep valid HTML, CSS, and JavaScript inside the streamui block.
- Never use inline event-handler attributes such as onclick, onchange, oninput, or onsubmit. Bind interactions with addEventListener.

${COMFORTABLE_LEGIBILITY_PROMPT}`,
      input: [
        {
          role: "user",
          content: [
            "USER_PROMPT:",
            request.prompt,
            "",
            "SELECTED_REFERENCES_JSON:",
            JSON.stringify(request.references, null, 2),
            "",
            "ORIGINAL_SOURCE:",
            request.source
          ].join("\n")
        }
      ],
      maxOutputTokens: 32_000
    },
    signal,
    fetchImpl
  );
  throwIfArtifactEditAborted(signal);
  const replacementBlock = rawModelText.match(STREAMUI_BLOCK_PATTERN)?.[0];
  if (!replacementBlock) {
    throw new Error(
      "The direct provider did not return a complete streamui artifact."
    );
  }
  const rawStream = request.source.replace(
    STREAMUI_BLOCK_PATTERN,
    replacementBlock
  );
  if (!didArtifactEditChangeSource(request.source, rawStream)) {
    throw new Error(
      "The artifact edit did not change the source. Try a more specific prompt or select a larger reference."
    );
  }
  return {
    rawStream,
    summary: request.prompt.trim().slice(0, 500),
    edits: [
      {
        note: "Browser-direct artifact replacement",
        findLength: originalBlock.length,
        replaceLength: replacementBlock.length
      }
    ]
  };
}

export async function requestArtifactEdit(
  request: ArtifactEditRequest,
  clientId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<ArtifactEditResponse> {
  throwIfArtifactEditAborted(signal);
  if (normalizeApiSettings(request.apiSettings).apiKeySource === "manual") {
    return requestBrowserDirectArtifactEdit(request, signal, fetchImpl);
  }
  const response = await fetchImpl(apiUrl("/artifact-edits"), {
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
