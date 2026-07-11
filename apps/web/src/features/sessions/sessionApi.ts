import type { SessionFile } from "../../domain/chat/sessionModel";
import { clientRequestHeaders } from "../../api/client";
import { apiUrl } from "../../api/appUrl";
import type { SessionFileUploadInput } from "./sessionFileContracts";

export type { SessionFileUploadInput } from "./sessionFileContracts";

type FetchLike = typeof fetch;

export type SessionPageExitTransport = {
  fetch: FetchLike;
  sendBeacon?: (url: string, data: BodyInit) => boolean;
};

export type SessionPageExitEnvironment = {
  fetch: FetchLike;
  navigator?: {
    sendBeacon?(url: string, data: BodyInit): boolean;
  };
};

export function sessionRequestHeaders(
  clientId: string,
  contentType?: string
): HeadersInit {
  return clientRequestHeaders(clientId, contentType);
}

export function requestSessionIndex(
  clientId: string,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return fetchImpl(apiUrl("/sessions/index"), {
    headers: sessionRequestHeaders(clientId)
  });
}

export function requestSessions(
  clientId: string,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return fetchImpl(apiUrl("/sessions"), {
    headers: sessionRequestHeaders(clientId)
  });
}

export async function uploadSessionFile(
  sessionId: string,
  input: SessionFileUploadInput,
  clientId: string,
  fetchImpl: FetchLike = fetch
): Promise<SessionFile> {
  const response = await fetchImpl(
    apiUrl(`/sessions/${encodeURIComponent(sessionId)}/files`),
    {
      method: "POST",
      headers: sessionRequestHeaders(clientId, "application/json"),
      body: JSON.stringify({ ...input, clientId })
    }
  );

  const payload = (await response.json().catch(() => ({}))) as {
    file?: unknown;
    error?: unknown;
  };
  if (!response.ok || !payload.file) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `File upload failed with HTTP ${response.status}.`
    );
  }

  return payload.file as SessionFile;
}

export async function deleteSessionFile(
  sessionId: string,
  fileId: string,
  clientId: string,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const response = await fetchImpl(
    apiUrl(
      `/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(
        fileId
      )}`
    ),
    {
      method: "DELETE",
      headers: sessionRequestHeaders(clientId)
    }
  );

  if (!response.ok) {
    throw new Error(`File delete failed with HTTP ${response.status}.`);
  }
}

export function saveSerializedSessionState(
  serializedState: string,
  clientId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return fetchImpl(apiUrl("/sessions"), {
    method: "PUT",
    headers: sessionRequestHeaders(clientId, "application/json"),
    signal,
    body: serializedState
  });
}

export function createSessionPageExitTransport(
  environment: SessionPageExitEnvironment
): SessionPageExitTransport {
  return {
    fetch: environment.fetch.bind(environment),
    sendBeacon:
      typeof environment.navigator?.sendBeacon === "function"
        ? environment.navigator.sendBeacon.bind(environment.navigator)
        : undefined
  };
}

function defaultPageExitTransport(): SessionPageExitTransport {
  return typeof window !== "undefined"
    ? createSessionPageExitTransport(window)
    : { fetch };
}

export function saveSessionStateOnPageExit(
  serializedState: string,
  clientId: string,
  transport: SessionPageExitTransport = defaultPageExitTransport()
): void {
  if (transport.sendBeacon) {
    const body = new Blob([serializedState], { type: "application/json" });
    if (transport.sendBeacon(apiUrl("/sessions"), body)) {
      return;
    }
  }

  void transport
    .fetch(apiUrl("/sessions"), {
      method: "PUT",
      headers: sessionRequestHeaders(clientId, "application/json"),
      keepalive: true,
      body: serializedState
    })
    .catch((error) => {
      console.warn("Could not flush ChatHTML sessions before page exit.", error);
    });
}
