import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cancelChatRun,
  claimAcceptedChatRunResponse,
  readNdjsonLines,
  requestChatRunEvents,
  startChatRun
} from "./chatApi";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function mockFetch(response = new Response(null, { status: 200 })) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return response;
  };
  return { calls, fetchImpl };
}

describe("chat API", () => {
  it("starts a chat run with the serialized payload and abort signal", async () => {
    const { calls, fetchImpl } = mockFetch();
    const controller = new AbortController();

    await startChatRun(
      { runId: "run-1", messages: [{ role: "user", content: "hello" }] },
      "client-1",
      controller.signal,
      fetchImpl
    );

    assert.equal(calls[0].input, "/api/chat");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.signal, controller.signal);
    assert.deepEqual(calls[0].init?.headers, {
      "Content-Type": "application/json",
      "X-ChatHTML-Client-Id": "client-1"
    });
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      runId: "run-1",
      messages: [{ role: "user", content: "hello" }]
    });
  });

  it("encodes run ids for cancellation and event resumption", async () => {
    const { calls, fetchImpl } = mockFetch();
    const controller = new AbortController();

    await cancelChatRun("run/one", "client-1", fetchImpl);
    await requestChatRunEvents(
      "run/one",
      12,
      "client-1",
      controller.signal,
      fetchImpl
    );

    assert.equal(calls[0].input, "/api/chat/runs/run%2Fone/cancel");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(
      calls[1].input,
      "/api/chat/runs/run%2Fone/events?after=12"
    );
    assert.equal(calls[1].init?.signal, controller.signal);
  });

  it("reads NDJSON lines across arbitrary byte chunks and flushes the tail", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"content","text":"你'));
        controller.enqueue(encoder.encode('好"}\n{"type":"reasoning"'));
        controller.enqueue(encoder.encode(',"text":"done"}\nlast-line'));
        controller.close();
      }
    });
    const lines: string[] = [];

    await readNdjsonLines(body, (line) => lines.push(line));

    assert.deepEqual(lines, [
      '{"type":"content","text":"你好"}',
      '{"type":"reasoning","text":"done"}',
      "last-line"
    ]);
  });

  it("transfers run ownership only after a successful streaming response", () => {
    let accepted = 0;
    const success = new Response("stream", { status: 200 });
    const claimed = claimAcceptedChatRunResponse(success, () => {
      accepted += 1;
    });

    assert.ok(claimed?.body);
    assert.equal(claimed?.response, success);
    assert.equal(accepted, 1);

    assert.equal(
      claimAcceptedChatRunResponse(
        new Response("failed", { status: 500 }),
        () => {
          accepted += 1;
        }
      ),
      undefined
    );
    assert.equal(
      claimAcceptedChatRunResponse(new Response(null, { status: 204 }), () => {
        accepted += 1;
      }),
      undefined
    );
    assert.equal(accepted, 1);
  });
});
