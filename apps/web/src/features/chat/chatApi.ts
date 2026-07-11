import { clientRequestHeaders } from "../../api/client";
import { apiUrl } from "../../api/appUrl";

type FetchLike = typeof fetch;

export type AcceptedChatRunResponse = {
  response: Response;
  body: ReadableStream<Uint8Array>;
};

export type ChatRunCancellationOutcome =
  | "cancelled"
  | "complete"
  | "error";

export type CancelChatRunResult = {
  runId: string;
  outcome: ChatRunCancellationOutcome;
  transitioned: boolean;
};

export function claimAcceptedChatRunResponse(
  response: Response,
  onAccepted?: () => void,
  onAcceptedError: (error: unknown) => void = (error) => {
    console.warn("Chat run acceptance observer failed.", error);
  }
): AcceptedChatRunResponse | undefined {
  if (!response.ok || !response.body) {
    return undefined;
  }

  try {
    onAccepted?.();
  } catch (error) {
    onAcceptedError(error);
  }
  return { response, body: response.body };
}

export function startChatRun(
  payload: unknown,
  clientId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return fetchImpl(apiUrl("/chat"), {
    method: "POST",
    headers: clientRequestHeaders(clientId, "application/json"),
    signal,
    body: JSON.stringify(payload)
  });
}

export async function cancelChatRun(
  runId: string,
  clientId: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<CancelChatRunResult> {
  const response = await fetchImpl(
    apiUrl(`/chat/runs/${encodeURIComponent(runId)}/cancel`),
    {
      method: "POST",
      headers: clientRequestHeaders(clientId),
      signal
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to cancel chat run ${runId} (${response.status}).`
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Chat run cancellation returned invalid JSON for ${runId}.`);
  }

  const result = payload as {
    runId?: unknown;
    outcome?: unknown;
    transitioned?: unknown;
  };
  if (
    !payload ||
    typeof payload !== "object" ||
    result.runId !== runId ||
    typeof result.outcome !== "string" ||
    (result.outcome !== "cancelled" &&
      result.outcome !== "complete" &&
      result.outcome !== "error") ||
    typeof result.transitioned !== "boolean"
  ) {
    throw new Error(
      `Chat run cancellation returned an invalid result for ${runId}.`
    );
  }

  return {
    runId,
    outcome: result.outcome,
    transitioned: result.transitioned
  };
}

export function requestChatRunEvents(
  runId: string,
  afterSequence: number,
  clientId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return fetchImpl(
    apiUrl(
      `/chat/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(
        String(afterSequence)
      )}`
    ),
    {
      headers: clientRequestHeaders(clientId),
      signal
    }
  );
}

export async function readNdjsonLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(onLine);
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  if (buffer.trim()) {
    buffer.split("\n").forEach(onLine);
  }
}
