import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createComposerSessionDraftController,
  type ComposerDraftState
} from "./composerSessionDraftController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function file(name: string): File {
  return { name } as File;
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function harness() {
  let state: ComposerDraftState = { text: "", attachments: [] };
  const added: File[] = [];
  let clears = 0;
  const controller = createComposerSessionDraftController(
    {
      getState: () => state,
      setText: (text) => {
        state = { ...state, text };
      },
      addAttachment: async (nextFile) => {
        added.push(nextFile);
        state = {
          ...state,
          attachments: [...state.attachments, { file: nextFile }]
        };
      },
      clearAttachments: async () => {
        clears += 1;
        state = { ...state, attachments: [] };
      }
    },
    "first"
  );

  return {
    controller,
    added,
    get state() {
      return state;
    },
    set state(next: ComposerDraftState) {
      state = next;
    },
    get clears() {
      return clears;
    }
  };
}

describe("composer session drafts", () => {
  it("restores text and attachments only to the session that owns them", async () => {
    const test = harness();
    const screenshot = file("screenshot.png");
    test.state = {
      text: "draft for first",
      attachments: [{ file: screenshot }]
    };
    test.controller.capture();

    test.controller.activate("second");
    assert.equal(test.state.text, "");
    await flushAsyncWork();
    assert.deepEqual(test.state.attachments, []);

    test.state = { ...test.state, text: "draft for second" };
    test.controller.capture();
    test.controller.activate("first");
    assert.equal(test.state.text, "draft for first");
    await flushAsyncWork();

    assert.deepEqual(test.added, [screenshot]);
    assert.deepEqual(test.state.attachments, [{ file: screenshot }]);
    assert.equal(test.controller.getDraft("second")?.text, "draft for second");
    assert.equal(test.clears, 2);
  });

  it("does not let a stale attachment restore leak into a later session", async () => {
    let state: ComposerDraftState = { text: "", attachments: [] };
    const firstClear = deferred<void>();
    let clearCount = 0;
    const added: string[] = [];
    const controller = createComposerSessionDraftController(
      {
        getState: () => state,
        setText: (text) => {
          state = { ...state, text };
        },
        addAttachment: async (nextFile) => {
          added.push(nextFile.name);
        },
        clearAttachments: () => {
          state = { ...state, attachments: [] };
          clearCount += 1;
          return clearCount === 1 ? firstClear.promise : Promise.resolve();
        }
      },
      "first"
    );

    state = { text: "", attachments: [{ file: file("first.png") }] };
    controller.capture();
    controller.activate("second");
    controller.activate("third");
    firstClear.resolve();
    await flushAsyncWork();

    assert.deepEqual(added, []);
    assert.equal(state.text, "");
  });

  it("drops an explicitly deleted session draft", async () => {
    const test = harness();
    test.state = {
      text: "delete me",
      attachments: [{ file: file("delete.png") }]
    };
    test.controller.capture();
    test.controller.discardSession("first");
    await flushAsyncWork();

    assert.equal(test.controller.getDraft("first"), undefined);
    assert.deepEqual(test.state, { text: "", attachments: [] });
  });

  it("reports the exact session ids whose empty sessions need protection", async () => {
    let state: ComposerDraftState = { text: "", attachments: [] };
    const notifications: string[][] = [];
    const controller = createComposerSessionDraftController(
      {
        getState: () => state,
        setText: (text) => {
          state = { ...state, text };
        },
        addAttachment: async () => undefined,
        clearAttachments: async () => {
          state = { ...state, attachments: [] };
        }
      },
      "first",
      {
        onDraftSessionIdsChange: (ids) =>
          notifications.push(Array.from(ids).sort())
      }
    );

    state = { text: "first draft", attachments: [] };
    controller.capture();
    controller.activate("second");
    await flushAsyncWork();
    state = { text: "second draft", attachments: [] };
    controller.capture();
    controller.discardSession("first");

    assert.deepEqual(Array.from(controller.getDraftSessionIds()), ["second"]);
    assert.deepEqual(notifications.at(-1), ["second"]);
    assert.ok(
      notifications.some(
        (ids) => ids.length === 2 && ids.includes("first") && ids.includes("second")
      )
    );
  });

  it("does not leak previous-session files when clearing attachments fails", async () => {
    const firstFile = file("first.png");
    let state: ComposerDraftState = {
      text: "first draft",
      attachments: [{ file: firstFile }]
    };
    const errors: string[] = [];
    const safetyChanges: boolean[] = [];
    let rejectClear = true;
    const controller = createComposerSessionDraftController(
      {
        getState: () => state,
        setText: (text) => {
          state = { ...state, text };
        },
        addAttachment: async (nextFile) => {
          state = {
            ...state,
            attachments: [...state.attachments, { file: nextFile }]
          };
        },
        clearAttachments: async () => {
          if (rejectClear) {
            throw new Error("clear failed");
          }
          state = { ...state, attachments: [] };
        }
      },
      "first",
      {
        onError: (message) => errors.push(message),
        onAttachmentSafetyChange: (blocked) => safetyChanges.push(blocked)
      }
    );

    controller.capture();
    controller.activate("second");
    await flushAsyncWork();
    state = { ...state, text: "second draft" };
    controller.capture();

    assert.deepEqual(controller.getDraft("first")?.files, [firstFile]);
    assert.deepEqual(controller.getDraft("second"), {
      text: "second draft",
      files: []
    });
    assert.match(errors[0], /draft is still stored/i);
    assert.equal(controller.hasUnsafeAttachments(), true);

    rejectClear = false;
    controller.retryAttachmentCleanup();
    await flushAsyncWork();
    assert.equal(controller.hasUnsafeAttachments(), false);
    assert.deepEqual(state.attachments, []);
    assert.deepEqual(safetyChanges, [true, false]);
  });

  it("retains files that fail to re-upload instead of truncating the draft", async () => {
    const targetFile = file("target.png");
    let state: ComposerDraftState = {
      text: "target draft",
      attachments: [{ file: targetFile }]
    };
    let rejectAdds = false;
    const controller = createComposerSessionDraftController(
      {
        getState: () => state,
        setText: (text) => {
          state = { ...state, text };
        },
        addAttachment: async (nextFile) => {
          if (rejectAdds) {
            throw new Error("upload failed");
          }
          state = {
            ...state,
            attachments: [...state.attachments, { file: nextFile }]
          };
        },
        clearAttachments: async () => {
          state = { ...state, attachments: [] };
        }
      },
      "target"
    );

    controller.capture();
    controller.activate("other");
    await flushAsyncWork();
    rejectAdds = true;
    controller.activate("target");
    await flushAsyncWork();

    assert.deepEqual(controller.getDraft("target")?.files, [targetFile]);
    assert.equal(controller.hasUnsafeAttachments(), true);
  });

  it("serializes rapid clears so an older transition cannot remove the current draft", async () => {
    const currentFile = file("current.png");
    const firstFile = file("first.png");
    let state: ComposerDraftState = {
      text: "current",
      attachments: [{ file: currentFile }]
    };
    const delayedClear = deferred<void>();
    let delayNextClear = false;
    const controller = createComposerSessionDraftController(
      {
        getState: () => state,
        setText: (text) => {
          state = { ...state, text };
        },
        addAttachment: async (nextFile) => {
          state = {
            ...state,
            attachments: [...state.attachments, { file: nextFile }]
          };
        },
        clearAttachments: async () => {
          if (delayNextClear) {
            delayNextClear = false;
            await delayedClear.promise;
          }
          state = { ...state, attachments: [] };
        }
      },
      "current"
    );

    controller.capture();
    controller.activate("first");
    await flushAsyncWork();
    state = { text: "first", attachments: [{ file: firstFile }] };
    controller.capture();

    delayNextClear = true;
    controller.activate("middle");
    controller.activate("current");
    await flushAsyncWork();
    assert.equal(controller.hasUnsafeAttachments(), true);

    delayedClear.resolve();
    await flushAsyncWork();
    await flushAsyncWork();

    assert.deepEqual(state.attachments, [{ file: currentFile }]);
    assert.equal(controller.hasUnsafeAttachments(), false);
  });
});
