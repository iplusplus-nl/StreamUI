import { clientRequestHeaders } from "../../api/client";

type FetchLike = typeof fetch;

export type AcceptedChatRunResponse = {
  response: Response;
  body: ReadableStream<Uint8Array>;
};

export function claimAcceptedChatRunResponse(
  response: Response,
  onAccepted?: () => void
): AcceptedChatRunResponse | undefined {
  if (!response.ok || !response.body) {
    return undefined;
  }
  onAccepted?.();
  return { response, body: response.body };
}

export function startChatRun(
  payload: unknown,
  clientId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return fetchImpl("/api/chat", {
    method: "POST",
    headers: clientRequestHeaders(clientId, "application/json"),
    signal,
    body: JSON.stringify(payload)
  });
}

export function cancelChatRun(
  runId: string,
  clientId: string,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return fetchImpl(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: clientRequestHeaders(clientId)
  });
}

export function requestChatRunEvents(
  runId: string,
  afterSequence: number,
  clientId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return fetchImpl(
    `/api/chat/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(
      String(afterSequence)
    )}`,
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
