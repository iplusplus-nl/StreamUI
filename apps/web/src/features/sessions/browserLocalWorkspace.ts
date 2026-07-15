import { createId, type SessionFile } from "../../domain/chat/sessionModel";
import type { SessionFileUploadInput } from "./sessionFileContracts";

export const BROWSER_LOCAL_WORKSPACE_STORAGE_KEY =
  "chathtml.browserWorkspace.v1";

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): WorkspaceStorage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function emptyWorkspacePayload(): string {
  return JSON.stringify({ sessions: [], activeSessionId: "" });
}

export function requestBrowserLocalWorkspace(
  storage: WorkspaceStorage | undefined = browserStorage()
): Promise<Response> {
  let payload = emptyWorkspacePayload();
  try {
    payload = storage?.getItem(BROWSER_LOCAL_WORKSPACE_STORAGE_KEY) || payload;
    JSON.parse(payload);
  } catch {
    payload = emptyWorkspacePayload();
  }
  return Promise.resolve(
    new Response(payload, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  );
}

export function saveBrowserLocalWorkspace(
  serializedState: string,
  storage: WorkspaceStorage | undefined = browserStorage()
): Promise<Response> {
  try {
    JSON.parse(serializedState);
    storage?.setItem(BROWSER_LOCAL_WORKSPACE_STORAGE_KEY, serializedState);
    const revision = (
      JSON.parse(serializedState) as { saveRevision?: unknown }
    ).saveRevision;
    return Promise.resolve(
      Response.json({
        applied: true,
        ...(typeof revision === "number"
          ? { currentSaveRevision: revision }
          : {})
      })
    );
  } catch (error) {
    return Promise.reject(
      new Error(
        error instanceof DOMException && error.name === "QuotaExceededError"
          ? "Browser storage is full. Remove large image sessions and try again."
          : "The local workspace could not be saved in this browser."
      )
    );
  }
}

export function flushBrowserLocalWorkspace(
  serializedState: string,
  storage: WorkspaceStorage | undefined = browserStorage()
): void {
  try {
    JSON.parse(serializedState);
    storage?.setItem(BROWSER_LOCAL_WORKSPACE_STORAGE_KEY, serializedState);
  } catch (error) {
    console.warn("Could not flush the browser-only ChatHTML workspace.", error);
  }
}

export function createBrowserLocalSessionFile(
  input: SessionFileUploadInput
): SessionFile {
  const content = input.dataUrl ?? input.text ?? "";
  return {
    id: createId("local-file"),
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType,
    size: new Blob([content]).size,
    createdAt: Date.now(),
    sourceMessageId: input.sourceMessageId,
    dataUrl: input.dataUrl,
    text: input.text,
    width: input.width,
    height: input.height,
    summary: input.summary
  };
}
