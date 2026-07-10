import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ARTIFACT_SELECTIONS } from "../../../core/artifactSelection";
import type {
  ArtifactSelection,
  ArtifactSelectionPayload
} from "../../../core/artifactSelection";
import type {
  ArtifactEdit,
  ClientMessage
} from "../../../domain/chat/sessionModel";
import {
  addArtifactSelection,
  buildArtifactEditTimelineByUserId,
  canShowReasoningActivity,
  groupArtifactSelectionsByMessageId,
  removeArtifactSelectionsForMessage,
  resolveSelectionModeMessageId,
  retainCapturableArtifactSelections,
  retainVisibleArtifactSelections,
  toggleSelectionModeMessageId
} from "./streamThreadModel";

function message(
  id: string,
  role: ClientMessage["role"],
  overrides: Partial<ClientMessage> = {}
): ClientMessage {
  return {
    id,
    role,
    content: id,
    status: role === "assistant" ? "complete" : undefined,
    ...overrides
  };
}

function edit(
  id: string,
  status: ArtifactEdit["status"] = "complete",
  options: {
    parentId?: string;
    promptBubble?: boolean;
    variantStatus?: ArtifactEdit["variants"][number]["status"];
  } = {}
): ArtifactEdit {
  const variantStatus = options.variantStatus ?? status;
  return {
    id,
    parentId: options.parentId,
    createdAt: 1,
    prompt: id,
    references: [],
    promptBubble: options.promptBubble,
    activeVariantId: `${id}-variant`,
    variants: [
      {
        id: `${id}-variant`,
        createdAt: 1,
        status: variantStatus,
        rawStream:
          variantStatus === "complete" ? `<streamui>${id}</streamui>` : undefined
      }
    ],
    status
  };
}

function selection(
  id: string,
  messageId: string,
  key = id,
  kind: ArtifactSelection["kind"] = "element"
): ArtifactSelection {
  return {
    id,
    messageId,
    createdAt: 1,
    kind,
    key,
    selector: `#${key}`,
    label: key,
    preview: key
  };
}

function payload(
  key: string,
  kind: ArtifactSelectionPayload["kind"] = "element"
): ArtifactSelectionPayload {
  return {
    kind,
    key,
    selector: `#${key}`,
    label: key,
    preview: key
  };
}

describe("stream thread model", () => {
  describe("artifact edit timelines", () => {
    it("binds the active visible edit chain to the nearest preceding user", () => {
      const first = edit("edit-1");
      const hidden = edit("edit-2", "complete", {
        parentId: first.id,
        promptBubble: false
      });
      const messages = [
        message("user-1", "user"),
        message("assistant-1", "assistant"),
        message("user-2", "user"),
        message("assistant-2", "assistant", {
          artifactEdits: [first, hidden],
          activeArtifactEditId: hidden.id
        })
      ];

      const timelines = buildArtifactEditTimelineByUserId(messages);

      assert.equal(timelines.has("user-1"), false);
      assert.deepEqual(timelines.get("user-2"), {
        assistantId: "assistant-2",
        edits: [first],
        activeEditId: "edit-2",
        disabled: false
      });
    });

    it("lets the later edited assistant replace an earlier timeline for the same user", () => {
      const messages = [
        message("user-1", "user"),
        message("assistant-1", "assistant", {
          artifactEdits: [edit("edit-1")],
          activeArtifactEditId: "edit-1"
        }),
        message("assistant-2", "assistant", {
          artifactEdits: [edit("edit-2")],
          activeArtifactEditId: "edit-2"
        })
      ];

      const timeline = buildArtifactEditTimelineByUserId(messages).get("user-1");

      assert.equal(timeline?.assistantId, "assistant-2");
      assert.deepEqual(timeline?.edits.map((item) => item.id), ["edit-2"]);
    });

    it("ignores edited assistants without a preceding user", () => {
      const timelines = buildArtifactEditTimelineByUserId([
        message("assistant-1", "assistant", {
          artifactEdits: [edit("edit-1")],
          activeArtifactEditId: "edit-1"
        })
      ]);

      assert.equal(timelines.size, 0);
    });

    it("disables a timeline for streaming assistants and pending variants", () => {
      const streamingTimeline = buildArtifactEditTimelineByUserId([
        message("user-1", "user"),
        message("assistant-1", "assistant", {
          status: "streaming",
          artifactEdits: [edit("edit-1")],
          activeArtifactEditId: "edit-1"
        })
      ]).get("user-1");
      const pendingTimeline = buildArtifactEditTimelineByUserId([
        message("user-2", "user"),
        message("assistant-2", "assistant", {
          artifactEdits: [
            edit("edit-2"),
            edit("edit-3", "complete", { variantStatus: "pending" })
          ],
          activeArtifactEditId: "edit-2"
        })
      ]).get("user-2");

      assert.equal(streamingTimeline?.disabled, true);
      assert.equal(pendingTimeline?.disabled, true);
    });
  });

  describe("artifact selections", () => {
    it("groups selections by message while preserving their order", () => {
      const first = selection("selection-1", "assistant-1");
      const second = selection("selection-2", "assistant-2");
      const third = selection("selection-3", "assistant-1");

      const grouped = groupArtifactSelectionsByMessageId([
        first,
        second,
        third
      ]);

      assert.deepEqual(grouped.get("assistant-1"), [first, third]);
      assert.deepEqual(grouped.get("assistant-2"), [second]);
    });

    it("removes only a targeted message's selections", () => {
      const first = selection("selection-1", "assistant-1");
      const second = selection("selection-2", "assistant-2");
      const current = [first, second];

      assert.deepEqual(
        removeArtifactSelectionsForMessage(current, "assistant-1"),
        [second]
      );
      assert.equal(
        removeArtifactSelectionsForMessage(current, "missing"),
        current
      );
    });

    it("keeps only the target message and replaces a duplicate key at the end", () => {
      const original = [
        selection("other", "assistant-1", "other"),
        selection("old-key", "assistant-2", "key"),
        selection("sibling", "assistant-2", "sibling")
      ];

      const next = addArtifactSelection(
        original,
        "assistant-2",
        payload("key", "text"),
        { id: "new-key", createdAt: 42 }
      );

      assert.deepEqual(next.map((item) => item.id), ["sibling", "new-key"]);
      assert.deepEqual(next[1], {
        ...payload("key", "text"),
        id: "new-key",
        messageId: "assistant-2",
        createdAt: 42
      });
      assert.equal(original.length, 3);
    });

    it("retains only the latest selection limit", () => {
      const original = Array.from(
        { length: MAX_ARTIFACT_SELECTIONS },
        (_, index) => selection(`selection-${index}`, "assistant-1")
      );

      const next = addArtifactSelection(
        original,
        "assistant-1",
        payload("latest"),
        { id: "selection-latest", createdAt: 2 }
      );

      assert.equal(next.length, MAX_ARTIFACT_SELECTIONS);
      assert.equal(next.some((item) => item.id === "selection-0"), false);
      assert.equal(next.at(-1)?.id, "selection-latest");
    });

    it("retains visible selections and preserves the array reference when unchanged", () => {
      const original = [
        selection("selection-1", "assistant-1"),
        selection("selection-2", "assistant-2")
      ];

      const unchanged = retainVisibleArtifactSelections(
        original,
        new Set(["assistant-1", "assistant-2"])
      );
      const filtered = retainVisibleArtifactSelections(
        original,
        new Set(["assistant-2"])
      );

      assert.equal(unchanged, original);
      assert.deepEqual(filtered, [original[1]]);
      assert.notEqual(filtered, original);
    });

    it("keeps text references when editing is disabled and preserves stable references", () => {
      const textOnly = [selection("text", "assistant-1", "text", "text")];
      const mixed = [
        selection("element", "assistant-1"),
        selection("text", "assistant-1", "text", "text")
      ];

      assert.equal(
        retainCapturableArtifactSelections(textOnly, false),
        textOnly
      );
      assert.equal(
        retainCapturableArtifactSelections(mixed, true),
        mixed
      );
      assert.deepEqual(retainCapturableArtifactSelections(mixed, false), [
        mixed[1]
      ]);
    });
  });

  describe("selection mode", () => {
    it("keeps only a complete assistant as the active selection mode message", () => {
      const messages = new Map<string, ClientMessage>([
        ["user", message("user", "user")],
        [
          "streaming",
          message("streaming", "assistant", { status: "streaming" })
        ],
        ["complete", message("complete", "assistant", { status: "complete" })]
      ]);

      assert.equal(resolveSelectionModeMessageId(null, messages), null);
      assert.equal(resolveSelectionModeMessageId("missing", messages), null);
      assert.equal(resolveSelectionModeMessageId("user", messages), null);
      assert.equal(resolveSelectionModeMessageId("streaming", messages), null);
      assert.equal(
        resolveSelectionModeMessageId("complete", messages),
        "complete"
      );
    });

    it("toggles one active selection target and disables the mode globally", () => {
      assert.equal(
        toggleSelectionModeMessageId(null, "assistant-1", true, true),
        "assistant-1"
      );
      assert.equal(
        toggleSelectionModeMessageId("assistant-1", "assistant-1", true, true),
        null
      );
      assert.equal(
        toggleSelectionModeMessageId("assistant-1", "assistant-2", false, true),
        "assistant-1"
      );
      assert.equal(
        toggleSelectionModeMessageId("assistant-1", "assistant-1", false, true),
        null
      );
      assert.equal(
        toggleSelectionModeMessageId("assistant-1", "assistant-2", true, false),
        null
      );
    });
  });

  describe("reasoning activity", () => {
    it("shows streaming assistants and completed assistants with visible reasoning", () => {
      assert.equal(
        canShowReasoningActivity(
          message("streaming", "assistant", { status: "streaming" })
        ),
        true
      );
      assert.equal(
        canShowReasoningActivity(
          message("complete", "assistant", {
            reasoning: "Generating... Actual reasoning"
          })
        ),
        true
      );
      assert.equal(
        canShowReasoningActivity(
          message("error", "assistant", {
            status: "error",
            reasoning: "Partial reasoning"
          })
        ),
        true
      );
    });

    it("hides synthetic-only reasoning, users, and missing messages", () => {
      assert.equal(
        canShowReasoningActivity(
          message("complete", "assistant", { reasoning: "Generating...   " })
        ),
        false
      );
      assert.equal(
        canShowReasoningActivity(
          message("user", "user", {
            status: "streaming",
            reasoning: "Visible but not assistant reasoning"
          })
        ),
        false
      );
      assert.equal(canShowReasoningActivity(undefined), false);
    });
  });
});
