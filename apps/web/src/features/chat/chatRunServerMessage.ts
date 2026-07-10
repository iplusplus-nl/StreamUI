import {
  normalizeStoredSessionState,
  type ClientMessage
} from "../../domain/chat/sessionModel";
import { requestSessions } from "../sessions/sessionApi";

export type LoadChatRunServerMessageInput = {
  clientId: string;
  sessionId: string;
  assistantId: string;
  request?: (clientId: string) => Promise<Response>;
  now?: () => number;
};

export async function loadChatRunServerMessage({
  clientId,
  sessionId,
  assistantId,
  request = requestSessions,
  now = Date.now
}: LoadChatRunServerMessageInput): Promise<ClientMessage | undefined> {
  const response = await request(clientId);
  if (!response.ok) {
    throw new Error(`Session sync failed with HTTP ${response.status}.`);
  }

  const serverState = normalizeStoredSessionState(await response.json(), now(), {
    rebuildSnapshots: false,
    interruptPendingArtifactEdits: true
  });
  return serverState.sessions
    .find((session) => session.id === sessionId)
    ?.messages.find((message) => message.id === assistantId);
}
