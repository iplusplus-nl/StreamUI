import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClientMessage } from "../../domain/chat/sessionModel";
import { createChatStreamLineHandler } from "./chatStreamEvents";
import {
  createChatRunState,
  reduceChatRunState,
  type ChatRunState
} from "./chatRunStateMachine";

function assistant(
  overrides: Partial<ClientMessage> = {}
): ClientMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    generationRunId: "run-1",
    status: "streaming",
    rawStream: "abc",
    reasoning: "think",
    streamSequence: 3,
    ...overrides
  };
}

function dispatch(
  state: ChatRunState,
  event: Parameters<typeof reduceChatRunState>[1]
): ChatRunState {
  return reduceChatRunState(state, event).state;
}

describe("chat run state machine", () => {
  it("integrates with the NDJSON handler without pre-advancing its cursor", () => {
    let state = createChatRunState({ runId: "run-1" });
    const apply = (
      event: Parameters<typeof reduceChatRunState>[1]
    ) => {
      const result = reduceChatRunState(state, event);
      state = result.state;
      return result;
    };
    let memoryEvents = 0;
    const handleLine = createChatStreamLineHandler({
      runId: "run-1",
      getLastSequence: () => state.streamSequence,
      onSequence: () => undefined,
      onContent: (text, sequence) => {
        apply({ type: "content", text, sequence });
      },
      onReasoning: (text, sequence) => {
        apply({ type: "reasoning", text, sequence });
      },
      onMemory: (_event, sequence) => {
        if (apply({ type: "memory", sequence }).accepted) {
          memoryEvents += 1;
        }
      },
      onDone: (status, error, sequence) => {
        apply({ type: "done", status, error, sequence });
      }
    });

    handleLine(JSON.stringify({ type: "content", text: "a", seq: 1 }));
    handleLine(JSON.stringify({ type: "content", text: "duplicate", seq: 1 }));
    handleLine(JSON.stringify({ type: "reasoning", text: "think", seq: 2 }));
    handleLine(JSON.stringify({ type: "memory", action: "delete", id: "m", seq: 1 }));
    handleLine(JSON.stringify({ type: "done", status: "complete", seq: 3 }));
    handleLine(JSON.stringify({ type: "content", text: "late", seq: 4 }));

    assert.equal(state.raw, "a");
    assert.equal(state.reasoning, "think");
    assert.equal(state.streamSequence, 3);
    assert.equal(state.terminal?.phase, "complete");
    assert.equal(memoryEvents, 1);
  });

  it("accumulates sequenced and legacy content without allowing cursor regression", () => {
    const initial = createChatRunState({ runId: "run-1", streamSequence: 5 });
    const stale = reduceChatRunState(initial, {
      type: "content",
      text: "stale",
      sequence: 5
    });
    const newer = reduceChatRunState(initial, {
      type: "content",
      text: "new",
      sequence: 6
    });
    const legacy = reduceChatRunState(newer.state, {
      type: "content",
      text: " legacy"
    });

    assert.equal(stale.accepted, false);
    assert.equal(stale.state, initial);
    assert.equal(newer.state.raw, "new");
    assert.equal(newer.state.streamSequence, 6);
    assert.equal(legacy.state.raw, "new legacy");
    assert.equal(legacy.state.streamSequence, 6);
  });

  it("accumulates reasoning and advances memory cursors monotonically", () => {
    let state = createChatRunState({
      runId: "run-1",
      reasoning: "a",
      streamSequence: 2
    });
    state = dispatch(state, { type: "reasoning", text: "b", sequence: 3 });
    state = dispatch(state, { type: "memory", sequence: 8 });
    const staleMemory = reduceChatRunState(state, {
      type: "memory",
      sequence: 4
    });

    assert.equal(state.reasoning, "ab");
    assert.equal(state.streamSequence, 8);
    assert.equal(staleMemory.accepted, true);
    assert.equal(staleMemory.state, state);
    assert.equal(staleMemory.state.streamSequence, 8);
  });

  it("treats EOF without done as detached and never invents completion", () => {
    const state = createChatRunState({ runId: "run-1", raw: "partial" });
    const first = reduceChatRunState(state, { type: "eof" });
    const repeated = reduceChatRunState(first.state, { type: "eof" });

    assert.equal(first.eofDisposition, "detached");
    assert.equal(first.state.terminal, undefined);
    assert.equal(first.state.transportEnded, true);
    assert.equal(repeated.eofDisposition, "detached");
    assert.equal(repeated.accepted, false);
    assert.equal(repeated.state, first.state);
  });

  it("recognizes stream complete and error only after explicit done", () => {
    const initial = createChatRunState({ runId: "run-1" });
    const complete = reduceChatRunState(initial, {
      type: "done",
      status: "complete",
      error: "",
      sequence: 1
    });
    const completeEof = reduceChatRunState(complete.state, { type: "eof" });
    const error = reduceChatRunState(initial, {
      type: "done",
      status: "error",
      error: "Provider failed",
      sequence: 1
    });

    assert.equal(complete.state.terminal?.phase, "complete");
    assert.equal(completeEof.eofDisposition, "terminal");
    assert.equal(error.state.terminal?.phase, "error");
    assert.equal(error.state.terminal?.error, "Provider failed");
  });

  it("rejects duplicate and older done events", () => {
    const initial = createChatRunState({ runId: "run-1", streamSequence: 5 });

    assert.equal(
      reduceChatRunState(initial, {
        type: "done",
        status: "complete",
        error: "",
        sequence: 5
      }).accepted,
      false
    );
    assert.equal(
      reduceChatRunState(initial, {
        type: "done",
        status: "complete",
        error: "",
        sequence: 4
      }).accepted,
      false
    );
  });

  it("accepts a same-sequence server terminal and requests connection abort", () => {
    const initial = createChatRunState({
      runId: "run-1",
      raw: "abc",
      reasoning: "think",
      streamSequence: 3
    });
    const result = reduceChatRunState(initial, {
      type: "server",
      message: assistant({
        status: "error",
        error: "Provider failed"
      })
    });

    assert.equal(result.accepted, true);
    assert.equal(result.phase, "error");
    assert.equal(result.abortConnection, true);
    assert.deepEqual(result.state.terminal, {
      source: "server",
      phase: "error",
      error: "Provider failed"
    });
    assert.equal(result.assistantPatch?.rawStream, "abc");
    assert.equal(result.assistantPatch?.streamSequence, 3);
  });

  it("accepts an older server terminal without truncating newer local data", () => {
    const initial = createChatRunState({
      runId: "run-1",
      raw: "abcdef",
      reasoning: "thinking more",
      streamSequence: 9
    });
    const result = reduceChatRunState(initial, {
      type: "server",
      message: assistant({
        content: "Done",
        rawStream: "abc",
        reasoning: "think",
        streamSequence: 4,
        status: "complete"
      })
    });

    assert.equal(result.accepted, true);
    assert.equal(result.state.raw, "abcdef");
    assert.equal(result.state.reasoning, "thinking more");
    assert.equal(result.state.streamSequence, 9);
    assert.equal(result.assistantPatch?.rawStream, "abcdef");
    assert.equal(result.assistantPatch?.reasoning, "thinking more");
    assert.equal(result.assistantPatch?.streamSequence, 9);
    assert.equal(result.assistantPatch?.content, "Done");
  });

  it("lets a server terminal correct a stream terminal but never return to streaming", () => {
    let state = createChatRunState({ runId: "run-1", streamSequence: 2 });
    state = dispatch(state, {
      type: "done",
      status: "complete",
      error: "",
      sequence: 3
    });
    const corrected = reduceChatRunState(state, {
      type: "server",
      message: assistant({
        rawStream: "server",
        streamSequence: 4,
        status: "error",
        error: "Server failed"
      })
    });
    const lateStreaming = reduceChatRunState(corrected.state, {
      type: "server",
      message: assistant({
        rawStream: "server late",
        streamSequence: 5,
        status: "streaming"
      })
    });
    const lateContent = reduceChatRunState(corrected.state, {
      type: "content",
      text: "late",
      sequence: 5
    });

    assert.equal(corrected.state.terminal?.source, "server");
    assert.equal(corrected.state.terminal?.phase, "error");
    assert.equal(lateStreaming.accepted, false);
    assert.equal(lateContent.accepted, false);
    assert.equal(lateStreaming.state, corrected.state);
    assert.equal(lateContent.state, corrected.state);
  });

  it("locks cancellation against every late stream and server terminal", () => {
    const initial = createChatRunState({
      runId: "run-1",
      raw: "partial",
      streamSequence: 4
    });
    const cancelled = reduceChatRunState(initial, { type: "cancel" });
    const lateServerStreaming = reduceChatRunState(cancelled.state, {
      type: "server",
      message: assistant({ rawStream: "late", streamSequence: 5 })
    });
    const lateServerTerminal = reduceChatRunState(cancelled.state, {
      type: "server",
      message: assistant({ status: "complete", streamSequence: 5 })
    });
    const lateDone = reduceChatRunState(cancelled.state, {
      type: "done",
      status: "complete",
      error: "",
      sequence: 5
    });

    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.abortConnection, true);
    assert.equal(lateServerStreaming.accepted, false);
    assert.equal(lateServerTerminal.accepted, false);
    assert.equal(lateDone.accepted, false);
    assert.equal(lateServerTerminal.state, cancelled.state);
  });

  it("preserves a server terminal when cancellation arrives afterward", () => {
    const terminal = reduceChatRunState(createChatRunState({ runId: "run-1" }), {
      type: "server",
      message: assistant({ status: "complete" })
    });
    const cancelled = reduceChatRunState(terminal.state, { type: "cancel" });

    assert.equal(cancelled.accepted, false);
    assert.equal(cancelled.state, terminal.state);
    assert.equal(cancelled.state.terminal?.source, "server");
  });

  it("rejects foreign runs, users, and stale server streaming snapshots", () => {
    const initial = createChatRunState({
      runId: "run-1",
      raw: "abc",
      reasoning: "think",
      streamSequence: 3
    });
    const user: ClientMessage = {
      id: "user-1",
      role: "user",
      content: "hello"
    };

    assert.equal(
      reduceChatRunState(initial, { type: "server", message: user }).accepted,
      false
    );
    assert.equal(
      reduceChatRunState(initial, {
        type: "server",
        message: assistant({ generationRunId: "run-2", streamSequence: 8 })
      }).accepted,
      false
    );
    assert.equal(
      reduceChatRunState(initial, {
        type: "server",
        message: assistant()
      }).accepted,
      false
    );
  });

  it("accepts legacy server messages without a run id", () => {
    const result = reduceChatRunState(
      createChatRunState({ runId: "run-1" }),
      {
        type: "server",
        message: assistant({
          generationRunId: undefined,
          streamSequence: 1
        })
      }
    );

    assert.equal(result.accepted, true);
    assert.equal(result.state.streamSequence, 1);
  });
});
