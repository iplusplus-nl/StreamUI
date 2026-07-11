import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  streamWebDemoResponse,
  webDemoTextFromEvent
} from "./webDemoApi";

describe("Web Demo streaming client", () => {
  it("reads output deltas and completed-only fallbacks", () => {
    assert.deepEqual(
      webDemoTextFromEvent({
        type: "response.output_text.delta",
        delta: "hello"
      }),
      { delta: "hello", completedText: "" }
    );
    assert.equal(
      webDemoTextFromEvent({
        type: "response.completed",
        response: {
          output: [
            { content: [{ type: "output_text", text: "fallback" }] }
          ]
        }
      }).completedText,
      "fallback"
    );
  });

  it("streams split SSE blocks without duplicating completion text", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"hel'
          )
        );
        controller.enqueue(
          encoder.encode(
            'lo"}\n\ndata: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"hello"}]}]}}\n\ndata: [DONE]\n\n'
          )
        );
        controller.close();
      }
    });
    const deltas: string[] = [];
    const text = await streamWebDemoResponse(
      {
        messages: [{ role: "user", content: "hello" }],
        themeMode: "day",
        canvas: { width: 800, height: 500 }
      },
      new AbortController().signal,
      (delta) => deltas.push(delta),
      async () => new Response(body, { status: 200 }),
      "https://service.example"
    );

    assert.equal(text, "hello");
    assert.deepEqual(deltas, ["hello"]);
  });
});
