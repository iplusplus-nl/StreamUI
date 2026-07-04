import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getApiMessageContent,
  htmlToTranscriptText,
  toApiMessages
} from "./apiMessages";
import type { ClientMessage } from "../../domain/chat/sessionModel";

describe("chat apiMessages", () => {
  it("turns artifact html into transcript text", () => {
    assert.equal(
      htmlToTranscriptText("<style>.x{}</style><p>Hello <strong>world</strong></p><script>x()</script>"),
      "Hello world"
    );
  });

  it("prefers visible message content", () => {
    const message: ClientMessage = {
      id: "a1",
      role: "assistant",
      content: "Visible answer",
      rawStream: "<streamui><p>Artifact</p></streamui>"
    };

    const content = getApiMessageContent(message);

    assert.match(content, /^Visible answer/);
    assert.match(content, /\[StreamUI artifact artifact-[a-z0-9]+\]/);
  });

  it("does not treat plain raw assistant text as an artifact", () => {
    const message: ClientMessage = {
      id: "a1",
      role: "assistant",
      content: "Plain answer",
      rawStream: "Plain answer"
    };

    assert.equal(getApiMessageContent(message), "Plain answer");
  });

  it("summarizes assistant streamui artifacts for future turns", () => {
    const message: ClientMessage = {
      id: "a1",
      role: "assistant",
      content: "",
      rawStream:
        "<chat></chat><streamui><section><p>Artifact text</p></section></streamui>"
    };

    const content = getApiMessageContent(message);

    assert.match(content, /\[StreamUI artifact artifact-[a-z0-9]+\]/);
    assert.match(content, /Visible text summary: Artifact text/);
    assert.match(content, /Structure summary: .*section/);
    assert.match(content, /Editable summary: .*visible text: Artifact text/);
  });

  it("uses a placeholder for empty artifacts", () => {
    const message: ClientMessage = {
      id: "a1",
      role: "assistant",
      content: "",
      rawStream: "<chat></chat><streamui><div></div></streamui>"
    };

    const content = getApiMessageContent(message);

    assert.match(content, /\[StreamUI artifact artifact-[a-z0-9]+\]/);
    assert.match(content, /Visible text summary: No visible text captured./);
    assert.match(content, /Structure summary: tags: div/);
  });

  it("uses persisted artifact context before rebuilding from raw html", () => {
    const message: ClientMessage = {
      id: "a1",
      role: "assistant",
      content: "",
      artifactContext: {
        id: "artifact-fixed",
        sourceHash: "fixed",
        sourceChars: 42,
        textSummary: "Stored text",
        styleSummary: "Stored style",
        structureSummary: "Stored structure",
        editableSummary: "Stored editable"
      },
      rawStream: "<chat></chat><streamui><p>Raw text</p></streamui>"
    };

    const content = getApiMessageContent(message);

    assert.match(content, /\[StreamUI artifact artifact-fixed\]/);
    assert.match(content, /Visible text summary: Stored text/);
    assert.doesNotMatch(content, /Raw text/);
  });

  it("filters welcome messages and maps image attachments", () => {
    const messages: ClientMessage[] = [
      { id: "welcome", role: "assistant", content: "Welcome" },
      {
        id: "u1",
        role: "user",
        content: "Describe this",
        attachments: [
          {
            id: "img1",
            name: "photo.png",
            mimeType: "image/png",
            size: 12,
            dataUrl: "data:image/png;base64,aaaa"
          }
        ]
      }
    ];

    assert.deepEqual(toApiMessages(messages), [
      {
        role: "user",
        content: "Describe this",
        images: [
          {
            name: "photo.png",
            mimeType: "image/png",
            size: 12,
            dataUrl: "data:image/png;base64,aaaa"
          }
        ]
      }
    ]);
  });

  it("keeps recent context under budget while preserving the latest user prompt", () => {
    const messages: ClientMessage[] = [];

    for (let index = 0; index < 40; index += 1) {
      messages.push({
        id: `u${index}`,
        role: "user",
        content: `message-${index} ${"x".repeat(2_000)}`
      });
    }

    const apiMessages = toApiMessages(messages);

    assert.equal(
      apiMessages[apiMessages.length - 1].content.startsWith("message-39"),
      true
    );
    assert.equal(
      apiMessages.some((message) => message.content.includes("message-0")),
      false
    );
  });
});
