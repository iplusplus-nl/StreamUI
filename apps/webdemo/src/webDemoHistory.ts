import {
  createInitialSessionState,
  normalizeStoredSessionState,
  serializeSessions,
  type SessionState
} from "../../web/src/domain/chat/sessionModel";

export const WEB_DEMO_HISTORY_KEY = "chathtml.webdemo.sessions.v1";

export type WebDemoStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): WebDemoStorage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function normalizeWebDemoHistory(
  input: unknown,
  now = Date.now()
): SessionState {
  const state = normalizeStoredSessionState(input, now, {
    rebuildSnapshots: false,
    interruptPendingArtifactEdits: true
  });
  return {
    ...state,
    sessions: state.sessions.map((session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.role === "assistant" && message.status === "streaming"
          ? {
              ...message,
              status: "error" as const,
              generationOutcome: "error" as const,
              error: "The Web Demo response was interrupted."
            }
          : message
      )
    }))
  };
}

export function loadWebDemoHistory(
  storage: WebDemoStorage | undefined = browserStorage(),
  now = Date.now()
): SessionState {
  if (!storage) {
    return createInitialSessionState(now);
  }
  try {
    return normalizeWebDemoHistory(
      JSON.parse(storage.getItem(WEB_DEMO_HISTORY_KEY) ?? "null"),
      now
    );
  } catch {
    return createInitialSessionState(now);
  }
}

export function saveWebDemoHistory(
  state: SessionState,
  storage: WebDemoStorage | undefined = browserStorage()
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      WEB_DEMO_HISTORY_KEY,
      JSON.stringify({
        activeSessionId: state.activeSessionId,
        sessions: serializeSessions(state.sessions)
      })
    );
  } catch {
    // The demo must remain usable when browser storage is full or unavailable.
  }
}
