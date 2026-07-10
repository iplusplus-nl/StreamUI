import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppendMessage, CompleteAttachment } from "@assistant-ui/react";
import { imageAttachmentToCompleteAttachment } from "../../core/assistantAttachments";
import type { ImageAttachment } from "../../core/imageAttachments";
import type { ClientMessage } from "../../domain/chat/sessionModel";
import {
  convertMessage,
  getAppendMessageImages,
  getAppendMessageText
} from "./assistantRuntimeAdapter";

function clientMessage(
  overrides: Partial<ClientMessage> = {}
): ClientMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "Hello",
    ...overrides
  };
}

function image(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "image-1",
    name: "diagram.png",
    mimeType: "image/png",
    size: 3,
    dataUrl: "data:image/png;base64,AAAA",
    ...overrides
  };
}

function appendMessage(
  overrides: Partial<AppendMessage> = {}
): AppendMessage {
  return {
    role: "user",
    content: [],
    ...overrides
  } as AppendMessage;
}

describe("assistant runtime adapter", () => {
  it("converts user text and image attachments", () => {
    const attachment = image();
    const converted = convertMessage(
      clientMessage({
        role: "user",
        content: "Question",
        attachments: [attachment]
      })
    );

    assert.deepEqual(converted.content, [{ type: "text", text: "Question" }]);
    assert.deepEqual(converted.attachments, [
      imageAttachmentToCompleteAttachment(attachment)
    ]);
    assert.equal(converted.status, undefined);
  });

  it("maps assistant lifecycle states and omits assistant attachments", () => {
    assert.deepEqual(
      convertMessage(clientMessage({ status: "streaming" })).status,
      { type: "running" }
    );
    assert.deepEqual(
      convertMessage(clientMessage({ status: "error", error: "Provider failed" }))
        .status,
      { type: "incomplete", reason: "error", error: "Provider failed" }
    );
    assert.deepEqual(
      convertMessage(clientMessage({ status: "error", error: undefined })).status,
      {
        type: "incomplete",
        reason: "error",
        error: "The chat request failed."
      }
    );
    assert.deepEqual(convertMessage(clientMessage()).status, {
      type: "complete",
      reason: "stop"
    });
    assert.equal(
      convertMessage(clientMessage({ attachments: [image()] })).attachments,
      undefined
    );
  });

  it("keeps empty message content empty", () => {
    assert.deepEqual(convertMessage(clientMessage({ content: "" })).content, []);
  });

  it("joins only append-message text parts in order", () => {
    const message = appendMessage({
      content: [
        { type: "text", text: "  First " },
        {
          type: "image",
          image: "data:image/png;base64,AAAA",
          filename: "inline.png"
        },
        { type: "text", text: "second  " }
      ]
    });

    assert.equal(getAppendMessageText(message), "First second");
  });

  it("combines valid completed and inline images in stable order", () => {
    const uploaded = image({ id: "uploaded", name: "uploaded.webp" });
    const reconstructed = {
      id: "reconstructed",
      type: "image",
      name: "reconstructed.jpg",
      contentType: "image/jpeg",
      status: { type: "complete" },
      content: [
        {
          type: "image",
          image: "data:image/jpeg;base64,AAAA",
          filename: "reconstructed.jpg"
        }
      ]
    } as unknown as CompleteAttachment;
    const nonImage = {
      id: "file-1",
      type: "file",
      name: "notes.txt",
      contentType: "text/plain",
      status: { type: "complete" },
      content: [{ type: "text", text: "notes" }]
    } as unknown as CompleteAttachment;
    const prefixes: string[] = [];
    const message = appendMessage({
      attachments: [
        imageAttachmentToCompleteAttachment(uploaded),
        reconstructed,
        nonImage
      ],
      content: [
        { type: "text", text: "Prompt" },
        {
          type: "image",
          image: "data:image/png;base64,AAAA",
          filename: "inline.png"
        },
        {
          type: "image",
          image: "data:image/png;base64,AA=="
        }
      ]
    });

    const images = getAppendMessageImages(message, (prefix) => {
      prefixes.push(prefix);
      return `fixed-${prefix}-${prefixes.length}`;
    });

    assert.equal(images[0], uploaded);
    assert.deepEqual(images.slice(1), [
      {
        id: "reconstructed",
        name: "reconstructed.jpg",
        mimeType: "image/jpeg",
        size: 3,
        dataUrl: "data:image/jpeg;base64,AAAA",
        sessionFile: undefined
      },
      {
        id: "fixed-inline-image-1",
        name: "inline.png",
        mimeType: "image/png",
        size: 3,
        dataUrl: "data:image/png;base64,AAAA"
      },
      {
        id: "fixed-inline-image-2",
        name: "image",
        mimeType: "image/png",
        size: 3,
        dataUrl: "data:image/png;base64,AA=="
      }
    ]);
    assert.deepEqual(prefixes, ["inline-image", "inline-image"]);
  });
});
