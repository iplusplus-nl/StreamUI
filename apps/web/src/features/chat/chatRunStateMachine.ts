import type { ClientMessage } from "../../domain/chat/sessionModel";
import type { ChatRunAssistantPhase } from "./chatRunRequest";

export type ChatRunTerminal = {
  source: "stream" | "server" | "cancel";
  phase: "complete" | "error" | "cancelled";
  error: string;
};

export type ChatRunState = {
  runId: string;
  raw: string;
  reasoning: string;
  streamSequence: number;
  terminal?: ChatRunTerminal;
  transportEnded: boolean;
};

export type ChatRunStateEvent =
  | { type: "content"; text: string; sequence?: number }
  | { type: "reasoning"; text: string; sequence?: number }
  | { type: "memory"; sequence?: number }
  | {
      type: "done";
      status: "complete" | "error";
      error: string;
      sequence?: number;
    }
  | { type: "server"; message: ClientMessage }
  | { type: "cancel" }
  | { type: "eof" };

export type ChatRunStateResult = {
  state: ChatRunState;
  accepted: boolean;
  phase?: ChatRunAssistantPhase;
  assistantPatch?: Partial<ClientMessage>;
  abortConnection: boolean;
  eofDisposition?: "terminal" | "detached";
};

export type CreateChatRunStateInput = {
  runId: string;
  raw?: string;
  reasoning?: string;
  streamSequence?: number;
};

function normalizeSequence(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function terminalAssistantPhase(
  status: ClientMessage["status"] | undefined
): "complete" | "error" | undefined {
  return status === "complete" || status === "error" ? status : undefined;
}

function rejected(state: ChatRunState): ChatRunStateResult {
  return { state, accepted: false, abortConnection: false };
}

function isStaleSequence(state: ChatRunState, sequence?: number): boolean {
  return (
    typeof sequence === "number" &&
    normalizeSequence(sequence) <= state.streamSequence
  );
}

function nextSequence(state: ChatRunState, sequence?: number): number {
  return Math.max(state.streamSequence, normalizeSequence(sequence));
}

function forwardText(current: string, incoming: string): string {
  if (!incoming) {
    return current;
  }
  return incoming.length >= current.length ? incoming : current;
}

function reduceServerMessage(
  state: ChatRunState,
  message: ClientMessage
): ChatRunStateResult {
  if (
    message.role !== "assistant" ||
    (message.generationRunId && message.generationRunId !== state.runId) ||
    state.terminal?.source === "server" ||
    state.terminal?.source === "cancel"
  ) {
    return rejected(state);
  }

  const terminalPhase = terminalAssistantPhase(message.status);
  if (state.terminal?.source === "stream" && !terminalPhase) {
    return rejected(state);
  }

  const serverSequence = normalizeSequence(message.streamSequence);
  const serverRaw = message.rawStream ?? "";
  const serverReasoning = message.reasoning ?? "";
  const hasNewerStream =
    serverSequence > state.streamSequence ||
    serverRaw.length > state.raw.length ||
    serverReasoning.length > state.reasoning.length;

  if (!hasNewerStream && !terminalPhase) {
    return rejected(state);
  }

  const raw = forwardText(state.raw, serverRaw);
  const reasoning = forwardText(state.reasoning, serverReasoning);
  const streamSequence = Math.max(state.streamSequence, serverSequence);
  const nextState: ChatRunState = {
    ...state,
    raw,
    reasoning,
    streamSequence,
    ...(terminalPhase
      ? {
          terminal: {
            source: "server" as const,
            phase: terminalPhase,
            error: message.error ?? ""
          }
        }
      : {})
  };

  return {
    state: nextState,
    accepted: true,
    phase: terminalPhase ?? "streaming",
    assistantPatch: {
      ...message,
      rawStream: raw,
      reasoning,
      streamSequence
    },
    abortConnection: Boolean(terminalPhase)
  };
}

export function createChatRunState(
  input: CreateChatRunStateInput
): ChatRunState {
  return {
    runId: input.runId,
    raw: input.raw ?? "",
    reasoning: input.reasoning ?? "",
    streamSequence: normalizeSequence(input.streamSequence),
    transportEnded: false
  };
}

export function reduceChatRunState(
  state: ChatRunState,
  event: ChatRunStateEvent
): ChatRunStateResult {
  if (event.type === "server") {
    return reduceServerMessage(state, event.message);
  }

  if (event.type === "eof") {
    const nextState = state.transportEnded
      ? state
      : { ...state, transportEnded: true };
    return {
      state: nextState,
      accepted: !state.transportEnded,
      abortConnection: false,
      eofDisposition: state.terminal ? "terminal" : "detached"
    };
  }

  if (event.type === "cancel") {
    if (state.terminal?.source === "server" || state.terminal?.source === "cancel") {
      return rejected(state);
    }
    return {
      state: {
        ...state,
        terminal: {
          source: "cancel",
          phase: "cancelled",
          error: ""
        }
      },
      accepted: true,
      phase: "cancelled",
      abortConnection: true
    };
  }

  if (state.terminal) {
    return rejected(state);
  }

  if (event.type === "memory") {
    const streamSequence = nextSequence(state, event.sequence);
    return {
      state:
        streamSequence === state.streamSequence
          ? state
          : { ...state, streamSequence },
      accepted: true,
      phase: "streaming",
      abortConnection: false
    };
  }

  if (isStaleSequence(state, event.sequence)) {
    return rejected(state);
  }

  const streamSequence = nextSequence(state, event.sequence);
  if (event.type === "content") {
    if (!event.text) {
      return rejected(state);
    }
    return {
      state: {
        ...state,
        raw: state.raw + event.text,
        streamSequence
      },
      accepted: true,
      phase: "streaming",
      abortConnection: false
    };
  }

  if (event.type === "reasoning") {
    if (!event.text) {
      return rejected(state);
    }
    return {
      state: {
        ...state,
        reasoning: state.reasoning + event.text,
        streamSequence
      },
      accepted: true,
      phase: "streaming",
      abortConnection: false
    };
  }

  return {
    state: {
      ...state,
      streamSequence,
      terminal: {
        source: "stream",
        phase: event.status,
        error: event.error
      }
    },
    accepted: true,
    phase: event.status,
    abortConnection: false
  };
}
