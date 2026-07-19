import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResponsesTerminalFailureError } from "./responsesEventReducer.js";
import {
  createChatCompletionsMessages,
  getChatCompletionsEndpoint,
  streamChatCompletionsOnce
} from "./chatCompletionsStreamClient.js";
import type { ResponsesStreamApiSettings } from "./responsesStreamClient.js";

const apiSettings: ResponsesStreamApiSettings = {
  providerName: "Test Provider",
  baseUrl: "https://provider.example/v1",
  apiKeySource: "manual",
  apiKeyEnvironmentName: "",
  apiKey: "secret",
  model: "test-model",
  reasoningEffort: "low"
};

function state() {
  return {
    contentChars: 0,
    contentEvents: 0,
    reasoningChars: 0,
    reasoningEvents: 0
  };
}

describe("Chat Completions stream client", () => {
  it("derives the standard endpoint and converts Responses history", () => {
    assert.equal(
      getChatCompletionsEndpoint("https://provider.example/v1/"),
      "https://provider.example/v1/chat/completions"
    );
    assert.deepEqual(
      createChatCompletionsMessages(
        [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello" }]
          },
          {
            type: "function_call",
            call_id: "call-1",
            name: "retrieve",
            arguments: '{"query":"news"}'
          },
          {
            type: "function_call_output",
            call_id: "call-1",
            output: '{"result":"ok"}'
          }
        ],
        "System instructions"
      ),
      [
        { role: "system", content: "System instructions" },
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "retrieve",
                arguments: '{"query":"news"}'
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: '{"result":"ok"}'
        }
      ]
    );
  });

  it("streams content and reasoning while aggregating tool-call deltas", async () => {
    const events: Array<{ type: string; text: string }> = [];
    const streamState = state();
    let requestBody: Record<string, unknown> | undefined;
    const calls = await streamChatCompletionsOnce({
      endpoint: "https://provider.example/v1/chat/completions",
      apiSettings,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Find this" }]
        }
      ],
      instructions: "Use tools when needed.",
      tools: [
        {
          type: "function",
          name: "retrieve",
          description: "Retrieve a page",
          strict: null,
          parameters: { type: "object", properties: {} }
        }
      ],
      emit: (event) => events.push(event),
      state: streamState,
      signal: new AbortController().signal,
      useOpenRouterReasoning: true,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          [
            'data: {"choices":[{"delta":{"reasoning":"Think ","content":"Working ","tool_calls":[{"index":0,"id":"call-1","function":{"name":"retrieve","arguments":"{\\"query\\":"}}]},"finish_reason":null}]}',
            "",
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"docs\\"}"}}]},"finish_reason":"tool_calls"}]}',
            "",
            "data: [DONE]",
            ""
          ].join("\n")
        );
      }
    });

    assert.equal(requestBody?.max_tokens, 16_000);
    assert.equal(Array.isArray(requestBody?.messages), true);
    assert.deepEqual(requestBody?.reasoning, { effort: "low" });
    assert.deepEqual(events, [
      { type: "content", text: "Working " },
      { type: "reasoning", text: "Think " }
    ]);
    assert.deepEqual(calls, [
      {
        type: "function_call",
        id: "call-1",
        call_id: "call-1",
        name: "retrieve",
        arguments: '{"query":"docs"}'
      }
    ]);
    assert.equal(streamState.contentChars, 8);
    assert.equal(streamState.reasoningChars, 6);
  });

  it("surfaces non-terminal finish reasons as incomplete", async () => {
    await assert.rejects(
      streamChatCompletionsOnce({
        endpoint: "https://provider.example/v1/chat/completions",
        apiSettings,
        input: [],
        instructions: "Answer.",
        tools: [],
        emit: () => undefined,
        state: state(),
        signal: new AbortController().signal,
        useOpenRouterReasoning: false,
        fetchImpl: async () =>
          new Response(
            [
              'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}',
              "",
              "data: [DONE]",
              ""
            ].join("\n")
          )
      }),
      (error: unknown) => {
        assert.ok(error instanceof ResponsesTerminalFailureError);
        assert.equal(error.incompleteReason, "length");
        return true;
      }
    );
  });
});
