import type { ArtifactSelection } from "../../core/artifactSelection";
import type {
  ChatSession,
  ClientMessage,
  SessionState
} from "../../domain/chat/sessionModel";
import type { PageThemeMode } from "../../runtime/streamui/types";
import type {
  ArtifactEditRequest,
  ArtifactEditResponse
} from "./artifactEditApi";
import {
  createArtifactEditController,
  type ArtifactEditRequestSettings
} from "./artifactEditController";
import {
  assistant,
  originalRaw,
  regeneratedRaw
} from "./artifactEditOperationTestFixtures";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export const selection: ArtifactSelection = {
  id: "selection-1",
  messageId: "assistant-1",
  createdAt: 1,
  kind: "element",
  key: "hero",
  selector: "#hero",
  label: "Hero",
  preview: "Hero preview",
  tagName: "section",
  text: "Hero",
  html: "<section id=\"hero\">Hero</section>"
};

export function sourceAssistant(
  overrides: Partial<ClientMessage> = {}
): ClientMessage {
  return assistant({
    content: "Original",
    rawStream: originalRaw,
    artifactEditBaseRawStream: undefined,
    artifactEdits: undefined,
    activeArtifactEditId: undefined,
    ...overrides
  });
}

export function chatSession(
  id: string,
  message: ClientMessage,
  overrides: Partial<ChatSession> = {}
): ChatSession {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: [message],
    files: [],
    ...overrides
  };
}

export type ArtifactEditRequestCall = {
  request: ArtifactEditRequest;
  clientId: string;
  signal: AbortSignal;
};

export type ArtifactEditControllerHarness = ReturnType<
  typeof createArtifactEditControllerHarness
>;

export function createArtifactEditControllerHarness(options: {
  sessions?: ChatSession[];
  activeSessionId?: string;
  settings?: ArtifactEditRequestSettings;
  requestEdit?: (
    call: ArtifactEditRequestCall
  ) => Promise<ArtifactEditResponse>;
  refreshAuthentication?: () => Promise<void>;
} = {}) {
  const defaultSession = chatSession("session-a", sourceAssistant());
  let state: SessionState = {
    activeSessionId: options.activeSessionId ?? defaultSession.id,
    sessions: options.sessions ?? [defaultSession]
  };
  let activeSessionId = state.activeSessionId;
  let clientId = "client-initial";
  let themeMode: PageThemeMode = "night";
  let externalBusy = false;
  let busyOwner: string | null = null;
  let denyNextLease = false;
  let dropNextMutation = false;
  let throwNextMutation: unknown = null;
  let editId = 0;
  let variantId = 0;
  let operationId = 0;
  let now = 10;
  let requestImpl =
    options.requestEdit ??
    (() => Promise.resolve({ rawStream: regeneratedRaw }));
  let refreshImpl =
    options.refreshAuthentication ?? (() => Promise.resolve());
  let requestSettings: ArtifactEditRequestSettings =
    options.settings ?? {
      apiSettings: { marker: "initial" },
      managed: false,
      requiresAuthentication: false
    };

  const requests: ArtifactEditRequestCall[] = [];
  const warnings: Array<{ message: string; error?: unknown }> = [];
  const events: string[] = [];
  const selectionClearTargets: string[] = [];
  const savedStates: SessionState[] = [];
  let selectionClears = 0;
  let authenticationOpens = 0;
  let leaseAcquisitions = 0;
  let leaseReleases = 0;
  let refreshes = 0;
  let mutationCalls = 0;

  const controller = createArtifactEditController(
    {
      isBusy: () => externalBusy || busyOwner !== null,
      getActiveSessionId: () => activeSessionId,
      getSessionState: () => state,
      resolveRequestSettings: () => requestSettings,
      getClientId: () => clientId,
      getThemeMode: () => themeMode,
      mutateMessage: (target, updater) => {
        mutationCalls += 1;
        events.push(`mutate:${target.sessionId}:${target.assistantId}`);
        if (throwNextMutation !== null) {
          const error = throwNextMutation;
          throwNextMutation = null;
          throw error;
        }
        if (dropNextMutation) {
          dropNextMutation = false;
          return "missing";
        }

        const sessionIndex = state.sessions.findIndex(
          (session) => session.id === target.sessionId
        );
        const session = state.sessions[sessionIndex];
        const messageIndex = session?.messages.findIndex(
          (message) => message.id === target.assistantId
        );
        if (!session || messageIndex === undefined || messageIndex < 0) {
          return "missing";
        }

        const message = session.messages[messageIndex];
        const nextMessage = updater(message);
        if (nextMessage === message) {
          return "unchanged";
        }

        const messages = [...session.messages];
        messages[messageIndex] = nextMessage;
        const sessions = [...state.sessions];
        sessions[sessionIndex] = { ...session, messages };
        state = { ...state, sessions };
        return "applied";
      },
      tryAcquireBusy: (ownerId) => {
        if (denyNextLease) {
          denyNextLease = false;
          return undefined;
        }
        if (externalBusy || busyOwner !== null) {
          return undefined;
        }

        busyOwner = ownerId;
        leaseAcquisitions += 1;
        events.push(`acquire:${ownerId}`);
        let released = false;
        return {
          release() {
            if (released) {
              return;
            }
            released = true;
            leaseReleases += 1;
            events.push(`release:${ownerId}`);
            if (busyOwner === ownerId) {
              busyOwner = null;
            }
          }
        };
      },
      clearSelections: (target) => {
        if (activeSessionId !== target.sessionId) {
          return;
        }
        selectionClears += 1;
        selectionClearTargets.push(target.assistantId);
        events.push(`clear-selections:${target.assistantId}`);
      },
      openAuthentication: () => {
        authenticationOpens += 1;
        events.push("open-authentication");
      },
      saveNow: () => {
        savedStates.push(structuredClone(state));
        events.push("save");
      },
      refreshAuthentication: async () => {
        refreshes += 1;
        events.push("refresh-authentication");
        await refreshImpl();
      },
      warn: (message, error) => {
        warnings.push({ message, error });
      }
    },
    {
      requestEdit: async (request, requestClientId, signal) => {
        const call = { request, clientId: requestClientId, signal };
        requests.push(call);
        events.push("request");
        return requestImpl(call);
      },
      createEditId: () => `generated-edit-${++editId}`,
      createVariantId: () => `generated-variant-${++variantId}`,
      createOperationId: () => `operation-${++operationId}`,
      now: () => now,
      isAbortError: (error) =>
        error instanceof Error && error.name === "AbortError",
      sanitizeError: (error, fallback) =>
        error instanceof Error && error.message.trim()
          ? `sanitized:${error.message}`
          : fallback
    }
  );

  return {
    controller,
    requests,
    warnings,
    events,
    selectionClearTargets,
    savedStates,
    get state() {
      return state;
    },
    set state(next: SessionState) {
      state = next;
    },
    get activeSessionId() {
      return activeSessionId;
    },
    set activeSessionId(value: string) {
      activeSessionId = value;
    },
    get clientId() {
      return clientId;
    },
    set clientId(value: string) {
      clientId = value;
    },
    get themeMode() {
      return themeMode;
    },
    set themeMode(value: PageThemeMode) {
      themeMode = value;
    },
    get externalBusy() {
      return externalBusy;
    },
    set externalBusy(value: boolean) {
      externalBusy = value;
    },
    get busyOwner() {
      return busyOwner;
    },
    get selectionClears() {
      return selectionClears;
    },
    get authenticationOpens() {
      return authenticationOpens;
    },
    get leaseAcquisitions() {
      return leaseAcquisitions;
    },
    get leaseReleases() {
      return leaseReleases;
    },
    get refreshes() {
      return refreshes;
    },
    get mutationCalls() {
      return mutationCalls;
    },
    set requestSettings(value: ArtifactEditRequestSettings) {
      requestSettings = value;
    },
    set requestImpl(value: typeof requestImpl) {
      requestImpl = value;
    },
    set refreshImpl(value: typeof refreshImpl) {
      refreshImpl = value;
    },
    set denyNextLease(value: boolean) {
      denyNextLease = value;
    },
    set dropNextMutation(value: boolean) {
      dropNextMutation = value;
    },
    set throwNextMutation(value: unknown) {
      throwNextMutation = value;
    },
    set now(value: number) {
      now = value;
    }
  };
}
