import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ImageAttachment,
  UploadedSessionFile
} from "../../core/imageAttachments";
import type {
  ChatSession,
  ClientMessage,
  SessionState
} from "../../domain/chat/sessionModel";
import type { RenderSnapshot } from "../../runtime/streamui/types";
import { createGenerationActivityCoordinator } from "../chat/generationActivityCoordinator";
import type {
  GeneratedArtifactBatchCompletion,
  StartGeneratedArtifactBatchInput,
  StartGeneratedArtifactBatchResult
} from "./generatedArtifactBatchController";
import {
  createVisualRepairController,
  type VisualRepairControllerPorts
} from "./visualRepairController";

const RAW = "<streamui><main>Original</main></streamui>";

function snapshot(
  raw = RAW,
  status: RenderSnapshot["status"] = "complete"
): RenderSnapshot {
  return {
    raw,
    completedHtml: `<main>${raw}</main>`,
    iframeDocument: `<html>${raw}</html>`,
    errors: [],
    status
  };
}

function messages(
  raw = RAW,
  ids: { user?: string; assistant?: string } = {}
): ClientMessage[] {
  return [
    {
      id: ids.user ?? "user-1",
      role: "user",
      content: `Build ${raw}`,
      fileIds: ["source-file"]
    },
    {
      id: ids.assistant ?? "assistant-1",
      role: "assistant",
      content: "Artifact",
      rawStream: raw,
      snapshot: snapshot(raw),
      status: "complete"
    }
  ];
}

function session(
  id = "session-1",
  raw = RAW,
  ids?: { user?: string; assistant?: string }
): ChatSession {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    model: "vision-model",
    messages: messages(raw, ids),
    files: []
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function capturedImage(): ImageAttachment {
  return {
    id: "captured-image",
    name: "assistant-1-render.png",
    mimeType: "image/png",
    size: 12,
    dataUrl: "data:image/png;base64,AAAA"
  };
}

function uploadedImage(): UploadedSessionFile {
  return {
    id: "uploaded-image",
    kind: "image",
    name: "assistant-1-render.png",
    mimeType: "image/png",
    size: 12,
    createdAt: 10,
    storageKey: "session-1/uploaded-image/blob.png",
    contentHash: "hash-1",
    draft: true
  };
}

type StartBatch = (
  input: StartGeneratedArtifactBatchInput
) => StartGeneratedArtifactBatchResult;

function harness() {
  let state: SessionState = {
    sessions: [session()],
    activeSessionId: "session-1"
  };
  let themeMode: "day" | "night" = "night";
  let requestModel = "vision-model";
  let requiresAuthentication = false;
  let supportsImage = true;
  let acceptRun = true;
  let id = 0;
  let authenticationOpenCount = 0;
  let capture: VisualRepairControllerPorts["captureScreenshot"] = async () =>
    capturedImage();
  let upload: VisualRepairControllerPorts["stageScreenshot"] = async () =>
    uploadedImage();
  let deleteFile: VisualRepairControllerPorts["discardScreenshot"] = async () =>
    undefined;
  let completion: Promise<GeneratedArtifactBatchCompletion> = Promise.resolve({
    status: "fulfilled"
  });
  let startBatchOverride: StartBatch | undefined;
  const captures: Array<{
    snapshot: RenderSnapshot;
    width: number;
    themeMode: "day" | "night";
    assistantId: string;
  }> = [];
  const uploads: Array<{
    sessionId: string;
    assistantId: string;
    attachment: ImageAttachment;
  }> = [];
  const deletions: Array<{
    sessionId: string;
    assistantId: string;
    fileId: string;
  }> = [];
  const batchInputs: StartGeneratedArtifactBatchInput[] = [];
  const diagnostics: Array<{
    snapshot: RenderSnapshot;
    width: number;
    themeMode: "day" | "night";
  }> = [];
  const runningChanges: boolean[] = [];
  const warnings: Array<{ message: string; error: unknown }> = [];
  const busyChanges: boolean[] = [];
  const activity = createGenerationActivityCoordinator({
    onBusyChange: (busy) => busyChanges.push(busy)
  });

  const ports: VisualRepairControllerPorts = {
    getState: () => state,
    getThemeMode: () => themeMode,
    resolveRequestContext: () => ({
      model: requestModel,
      requiresAuthentication
    }),
    isBusy: activity.isBusy,
    tryAcquireLocal: activity.tryAcquireLocal,
    promoteLocalToChat: activity.promoteLocalToChat,
    startGeneratedBatch: (input) => {
      batchInputs.push(input);
      if (startBatchOverride) {
        return startBatchOverride(input);
      }
      if (acceptRun) {
        input.onRunAccepted?.();
      }
      return {
        status: "started",
        operation: {} as never,
        completion
      };
    },
    openAuthentication: () => {
      authenticationOpenCount += 1;
    },
    captureScreenshot: async (
      currentSnapshot,
      width,
      currentThemeMode,
      assistantId
    ) => {
      captures.push({
        snapshot: currentSnapshot,
        width,
        themeMode: currentThemeMode,
        assistantId
      });
      return capture(
        currentSnapshot,
        width,
        currentThemeMode,
        assistantId
      );
    },
    stageScreenshot: async (target, attachment) => {
      uploads.push({ ...target, attachment });
      return upload(target, attachment);
    },
    discardScreenshot: async (target, fileId) => {
      deletions.push({ ...target, fileId });
      await deleteFile(target, fileId);
    },
    getDiagnostics: (currentSnapshot, width, currentThemeMode) => {
      diagnostics.push({
        snapshot: currentSnapshot,
        width,
        themeMode: currentThemeMode
      });
      return "diagnostics-text";
    },
    supportsImageInput: () => supportsImage,
    createId: (prefix) => `${prefix}-${++id}`,
    onRunningChange: (running) => runningChanges.push(running),
    warn: (message, error) => warnings.push({ message, error })
  };
  const controller = createVisualRepairController(ports);

  return {
    controller,
    activity,
    captures,
    uploads,
    deletions,
    batchInputs,
    diagnostics,
    runningChanges,
    warnings,
    busyChanges,
    get state() {
      return state;
    },
    set state(next: SessionState) {
      state = next;
    },
    set themeMode(next: "day" | "night") {
      themeMode = next;
    },
    set requestModel(next: string) {
      requestModel = next;
    },
    set requiresAuthentication(next: boolean) {
      requiresAuthentication = next;
    },
    set supportsImage(next: boolean) {
      supportsImage = next;
    },
    set acceptRun(next: boolean) {
      acceptRun = next;
    },
    set completion(next: Promise<GeneratedArtifactBatchCompletion>) {
      completion = next;
    },
    set capture(next: VisualRepairControllerPorts["captureScreenshot"]) {
      capture = next;
    },
    set upload(next: VisualRepairControllerPorts["stageScreenshot"]) {
      upload = next;
    },
    set deleteFile(next: VisualRepairControllerPorts["discardScreenshot"]) {
      deleteFile = next;
    },
    set startBatch(next: StartBatch) {
      startBatchOverride = next;
    },
    get authenticationOpenCount() {
      return authenticationOpenCount;
    }
  };
}

function input(
  overrides: Partial<{
    sessionId: string;
    assistantId: string;
    snapshot: RenderSnapshot;
    width: number;
  }> = {}
) {
  return {
    sessionId: "session-1",
    assistantId: "assistant-1",
    snapshot: snapshot(),
    width: 900,
    ...overrides
  };
}

describe("visual repair controller admission", () => {
  it("rejects incomplete snapshots and missing or stale exact targets before work", async () => {
    const invalid = harness();
    assert.equal(
      await invalid.controller.start(
        input({ snapshot: snapshot(RAW, "streaming") })
      ),
      "invalid"
    );

    const missing = harness();
    assert.equal(
      await missing.controller.start(input({ sessionId: "missing" })),
      "missing"
    );
    assert.equal(
      await missing.controller.start(input({ assistantId: "missing" })),
      "missing"
    );

    const stale = harness();
    assert.equal(
      await stale.controller.start(input({ snapshot: snapshot("changed") })),
      "stale"
    );

    for (const test of [invalid, missing, stale]) {
      assert.equal(test.captures.length, 0);
      assert.equal(test.uploads.length, 0);
      assert.equal(test.activity.isBusy(), false);
    }
  });

  it("opens managed authentication before reserving or capturing", async () => {
    const test = harness();
    test.requiresAuthentication = true;

    assert.equal(
      await test.controller.start(input()),
      "authentication-required"
    );
    assert.equal(test.authenticationOpenCount, 1);
    assert.equal(test.captures.length, 0);
    assert.equal(test.activity.isBusy(), false);
    assert.deepEqual(test.runningChanges, []);
  });

  it("locks duplicate assistant ids to the explicit session", async () => {
    const test = harness();
    const otherRaw = "<streamui><main>Other</main></streamui>";
    test.state = {
      sessions: [
        session("session-1"),
        session("session-2", otherRaw, {
          user: "user-2",
          assistant: "assistant-1"
        })
      ],
      activeSessionId: "session-1"
    };

    assert.equal(
      await test.controller.start(
        input({ sessionId: "session-2", snapshot: snapshot(otherRaw) })
      ),
      "finished"
    );
    assert.equal(test.uploads[0].sessionId, "session-2");
    assert.equal(test.batchInputs[0].sessionId, "session-2");
    assert.equal(test.batchInputs[0].sourceUserMessageId, "user-2");
  });

  it("serializes same-tick starts and respects external activity", async () => {
    const test = harness();
    const capture = deferred<ImageAttachment>();
    test.capture = () => capture.promise;
    const first = test.controller.start(input());

    assert.equal(await test.controller.start(input()), "busy");
    assert.equal(test.controller.cancelActive(), true);
    capture.resolve(capturedImage());
    assert.equal(await first, "cancelled");

    const external = harness();
    const externalLease = external.activity.tryAcquireChatRun("existing-run");
    assert.ok(externalLease);
    assert.equal(await external.controller.start(input()), "busy");
    externalLease.release();
  });

  it("re-emits running state when activation follows an early start", async () => {
    const test = harness();
    const capture = deferred<ImageAttachment>();
    test.capture = () => capture.promise;
    const result = test.controller.start(input());

    test.controller.activate();
    assert.deepEqual(test.runningChanges, [true, true]);

    assert.equal(test.controller.cancelActive(), true);
    capture.resolve(capturedImage());
    assert.equal(await result, "cancelled");
    assert.deepEqual(test.runningChanges, [true, true, false]);
  });
});

describe("visual repair controller request lifecycle", () => {
  it("captures, uploads, atomically promotes, and transfers cleanup to the server", async () => {
    const test = harness();

    assert.equal(
      await test.controller.start(input({ width: 2_000 })),
      "finished"
    );

    assert.deepEqual(test.captures.map(({ width, themeMode, assistantId }) => ({
      width,
      themeMode,
      assistantId
    })), [
      { width: 1_100, themeMode: "night", assistantId: "assistant-1" }
    ]);
    assert.equal(test.uploads.length, 1);
    assert.equal(test.batchInputs.length, 1);
    const request = test.batchInputs[0];
    assert.equal(request.sessionId, "session-1");
    assert.equal(request.assistantId, "assistant-1");
    assert.equal(request.sourceUserMessageId, "user-1");
    assert.equal(request.historyMode, "through-target-assistant");
    assert.equal(request.ephemeralAttachments, true);
    assert.equal(request.attachments?.[0].id, "uploaded-image");
    assert.equal(request.attachments?.[0].ownerSessionId, "session-1");
    assert.equal(request.runId, "run-2");
    assert.ok(request.chatActivityLease);
    assert.equal(request.assistantPatch?.repairOfMessageId, "assistant-1");
    assert.equal(request.assistantPatch?.repairAttempt, 1);
    assert.equal(test.deletions.length, 0);
    assert.equal(test.activity.isBusy(), false);
    assert.deepEqual(test.busyChanges, [true, false]);
    assert.deepEqual(test.runningChanges, [true, false]);
  });

  it("uses diagnostics without image work for a text-only model", async () => {
    const test = harness();
    test.supportsImage = false;

    assert.equal(await test.controller.start(input({ width: 100 })), "finished");
    assert.equal(test.captures.length, 0);
    assert.equal(test.uploads.length, 0);
    assert.equal(test.deletions.length, 0);
    assert.deepEqual(
      test.diagnostics.map(({ width, themeMode }) => ({ width, themeMode })),
      [{ width: 320, themeMode: "night" }]
    );
    assert.equal(test.batchInputs[0].attachments?.length, 0);
    assert.equal(test.batchInputs[0].ephemeralAttachments, false);
    assert.match(test.batchInputs[0].prompt, /diagnostics-text/);
  });

  it("deletes a client-owned screenshot when the run is not accepted", async () => {
    const test = harness();
    test.acceptRun = false;

    assert.equal(await test.controller.start(input()), "failed");
    assert.deepEqual(test.deletions, [
      {
        sessionId: "session-1",
        assistantId: "assistant-1",
        fileId: "uploaded-image"
      }
    ]);
    assert.equal(test.activity.isBusy(), false);
  });

  it("retries idempotent client cleanup before reporting a leak", async () => {
    const recovered = harness();
    recovered.acceptRun = false;
    let attempts = 0;
    recovered.deleteFile = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`delete attempt ${attempts}`);
      }
    };

    assert.equal(await recovered.controller.start(input()), "failed");
    assert.equal(recovered.deletions.length, 3);
    assert.equal(recovered.warnings.length, 0);

    const failed = harness();
    failed.acceptRun = false;
    const deleteFailure = new Error("delete unavailable");
    failed.deleteFile = async () => {
      throw deleteFailure;
    };

    assert.equal(await failed.controller.start(input()), "failed");
    assert.equal(failed.deletions.length, 3);
    assert.deepEqual(failed.warnings, [
      {
        message: "Could not delete the temporary visual repair screenshot.",
        error: deleteFailure
      }
    ]);
  });

  it("reports generated request rejection without reclaiming server-owned cleanup", async () => {
    const test = harness();
    const failure = new Error("request rejected");
    test.completion = Promise.resolve({ status: "rejected", error: failure });

    assert.equal(await test.controller.start(input()), "failed");
    assert.equal(test.deletions.length, 0);
    assert.equal(test.activity.isBusy(), false);
  });

  it("exposes the exact running target for cancellation across session switches", async () => {
    const test = harness();
    const batchCompletion = deferred<GeneratedArtifactBatchCompletion>();
    test.completion = batchCompletion.promise;
    const result = test.controller.start(input());
    await flushAsyncWork();

    assert.deepEqual(test.controller.getActiveRun(), {
      sessionId: "session-1",
      assistantId: "assistant-1",
      runId: "run-2"
    });
    assert.equal(test.controller.cancelActive(), false);
    assert.equal(test.activity.isBusy(), true);

    batchCompletion.resolve({ status: "fulfilled" });
    assert.equal(await result, "finished");
    assert.equal(test.controller.getActiveRun(), undefined);
    assert.equal(test.activity.isBusy(), false);
  });
});

describe("visual repair controller cancellation and stale guards", () => {
  it("contains capture and upload failures without leaking activity", async () => {
    const captureFailure = new Error("capture failed");
    const capture = harness();
    capture.capture = async () => {
      throw captureFailure;
    };
    assert.equal(await capture.controller.start(input()), "failed");
    assert.equal(capture.uploads.length, 0);
    assert.equal(capture.deletions.length, 0);
    assert.equal(capture.activity.isBusy(), false);
    assert.deepEqual(capture.warnings, [
      {
        message: "Could not run visual artifact repair.",
        error: captureFailure
      }
    ]);

    const uploadFailure = new Error("upload failed");
    const upload = harness();
    upload.upload = async () => {
      throw uploadFailure;
    };
    assert.equal(await upload.controller.start(input()), "failed");
    assert.equal(upload.uploads.length, 1);
    assert.equal(upload.deletions.length, 0);
    assert.equal(upload.activity.isBusy(), false);
    assert.deepEqual(upload.warnings, [
      {
        message: "Could not run visual artifact repair.",
        error: uploadFailure
      }
    ]);
  });

  it("cancels capture and ignores its late result", async () => {
    const test = harness();
    const capture = deferred<ImageAttachment>();
    test.capture = () => capture.promise;
    const result = test.controller.start(input());

    assert.equal(test.controller.cancelActive(), true);
    assert.equal(test.activity.isBusy(), false);
    capture.resolve(capturedImage());

    assert.equal(await result, "cancelled");
    assert.equal(test.uploads.length, 0);
    assert.equal(test.batchInputs.length, 0);
    assert.deepEqual(test.runningChanges, [true, false]);
  });

  it("cleans an upload that arrives after cancellation", async () => {
    const test = harness();
    const upload = deferred<UploadedSessionFile>();
    test.upload = () => upload.promise;
    const result = test.controller.start(input());
    await flushAsyncWork();

    assert.equal(test.uploads.length, 1);
    assert.equal(test.controller.cancelActive(), true);
    upload.resolve(uploadedImage());

    assert.equal(await result, "cancelled");
    assert.equal(test.batchInputs.length, 0);
    assert.equal(test.deletions.length, 1);
    assert.equal(test.deletions[0].fileId, "uploaded-image");
    assert.equal(test.activity.isBusy(), false);
  });

  it("rejects source-user changes during capture before uploading", async () => {
    const test = harness();
    const capture = deferred<ImageAttachment>();
    test.capture = () => capture.promise;
    const result = test.controller.start(input());
    test.state.sessions[0].messages[0].content = "Edited source";
    capture.resolve(capturedImage());

    assert.equal(await result, "stale");
    assert.equal(test.uploads.length, 0);
    assert.equal(test.batchInputs.length, 0);
    assert.equal(test.activity.isBusy(), false);
  });

  it("rejects target deletion and snapshot changes during capture", async () => {
    const deleted = harness();
    const deletedCapture = deferred<ImageAttachment>();
    deleted.capture = () => deletedCapture.promise;
    const deletedResult = deleted.controller.start(input());
    deleted.state.sessions[0].messages = deleted.state.sessions[0].messages.filter(
      (message) => message.id !== "assistant-1"
    );
    deletedCapture.resolve(capturedImage());
    assert.equal(await deletedResult, "stale");
    assert.equal(deleted.uploads.length, 0);

    const changed = harness();
    const changedCapture = deferred<ImageAttachment>();
    changed.capture = () => changedCapture.promise;
    const changedResult = changed.controller.start(input());
    const assistant = changed.state.sessions[0].messages[1];
    if (assistant.snapshot) {
      assistant.snapshot = { ...assistant.snapshot, raw: "changed snapshot" };
    }
    changedCapture.resolve(capturedImage());
    assert.equal(await changedResult, "stale");
    assert.equal(changed.uploads.length, 0);
  });

  it("cleans the upload when the assistant revision changes", async () => {
    const test = harness();
    const upload = deferred<UploadedSessionFile>();
    test.upload = () => upload.promise;
    const result = test.controller.start(input());
    await flushAsyncWork();
    test.state.sessions[0].messages[1].rawStream = "changed raw";
    upload.resolve(uploadedImage());

    assert.equal(await result, "stale");
    assert.equal(test.batchInputs.length, 0);
    assert.equal(test.deletions.length, 1);
  });

  it("rechecks authentication before upload and after upload", async () => {
    const beforeUpload = harness();
    const capture = deferred<ImageAttachment>();
    beforeUpload.capture = () => capture.promise;
    const beforeResult = beforeUpload.controller.start(input());
    beforeUpload.requiresAuthentication = true;
    capture.resolve(capturedImage());

    assert.equal(await beforeResult, "authentication-required");
    assert.equal(beforeUpload.authenticationOpenCount, 1);
    assert.equal(beforeUpload.uploads.length, 0);

    const afterUpload = harness();
    const upload = deferred<UploadedSessionFile>();
    afterUpload.upload = () => upload.promise;
    const afterResult = afterUpload.controller.start(input());
    await flushAsyncWork();
    afterUpload.requiresAuthentication = true;
    upload.resolve(uploadedImage());

    assert.equal(await afterResult, "authentication-required");
    assert.equal(afterUpload.authenticationOpenCount, 1);
    assert.equal(afterUpload.deletions.length, 1);
    assert.equal(afterUpload.batchInputs.length, 0);
  });

  it("treats model or theme changes as stale and cleans an uploaded image", async () => {
    for (const changeContext of [
      (test: ReturnType<typeof harness>) => {
        test.requestModel = "text-only-model";
      },
      (test: ReturnType<typeof harness>) => {
        test.themeMode = "day";
      }
    ]) {
      const test = harness();
      const upload = deferred<UploadedSessionFile>();
      test.upload = () => upload.promise;
      const result = test.controller.start(input());
      await flushAsyncWork();
      changeContext(test);
      upload.resolve(uploadedImage());

      assert.equal(await result, "stale");
      assert.equal(test.deletions.length, 1);
      assert.equal(test.batchInputs.length, 0);
      assert.equal(test.activity.isBusy(), false);
    }
  });

  it("cleans up when promotion loses to a restored run", async () => {
    const test = harness();
    const upload = deferred<UploadedSessionFile>();
    test.upload = () => upload.promise;
    const result = test.controller.start(input());
    await flushAsyncWork();
    const restoredLease = test.activity.registerRestoredChatRun("restored-run");
    assert.ok(restoredLease);
    upload.resolve(uploadedImage());

    assert.equal(await result, "busy");
    assert.equal(test.deletions.length, 1);
    assert.equal(test.batchInputs.length, 0);
    assert.equal(test.activity.isBusy(), true);
    restoredLease.release();
    assert.equal(test.activity.isBusy(), false);
  });

  it("contains start exceptions and releases both activity leases", async () => {
    const test = harness();
    const failure = new Error("start failed");
    test.startBatch = () => {
      throw failure;
    };

    assert.equal(await test.controller.start(input()), "failed");
    assert.equal(test.deletions.length, 1);
    assert.equal(test.activity.isBusy(), false);
    assert.deepEqual(test.warnings, [
      { message: "Could not run visual artifact repair.", error: failure }
    ]);
  });

  it("maps non-started generated batch outcomes and cleans the upload", async () => {
    for (const status of ["busy", "missing", "invalid", "failed"] as const) {
      const test = harness();
      test.startBatch = () => ({ status });

      assert.equal(
        await test.controller.start(input()),
        status === "busy" ? "busy" : "failed"
      );
      assert.equal(test.deletions.length, 1);
      assert.equal(test.activity.isBusy(), false);
    }
  });

  it("dispose cancels preparing work and old completions cannot affect a new task", async () => {
    const test = harness();
    const firstCapture = deferred<ImageAttachment>();
    test.capture = () => firstCapture.promise;
    const first = test.controller.start(input());
    test.controller.dispose();
    assert.equal(test.activity.isBusy(), false);

    test.controller.activate();
    test.capture = async () => capturedImage();
    assert.equal(await test.controller.start(input()), "finished");

    firstCapture.resolve(capturedImage());
    assert.equal(await first, "cancelled");
    assert.equal(test.batchInputs.length, 1);
    assert.equal(test.activity.isBusy(), false);
  });

  it("dispose hides a running task without releasing its chat lease and activate restores it", async () => {
    const test = harness();
    const batchCompletion = deferred<GeneratedArtifactBatchCompletion>();
    test.completion = batchCompletion.promise;
    const result = test.controller.start(input());
    await flushAsyncWork();

    test.controller.dispose();
    assert.equal(test.controller.isRunning(), false);
    assert.equal(test.controller.getActiveRun(), undefined);
    assert.equal(test.activity.isBusy(), true);

    test.controller.activate();
    assert.equal(test.controller.isRunning(), true);
    assert.deepEqual(test.controller.getActiveRun(), {
      sessionId: "session-1",
      assistantId: "assistant-1",
      runId: "run-2"
    });

    batchCompletion.resolve({ status: "fulfilled" });
    assert.equal(await result, "finished");
    assert.equal(test.activity.isBusy(), false);
    assert.deepEqual(test.runningChanges, [true, false, true, false]);
  });

  it("activate resynchronizes false after a running task finishes while disposed", async () => {
    const test = harness();
    const batchCompletion = deferred<GeneratedArtifactBatchCompletion>();
    test.completion = batchCompletion.promise;
    const result = test.controller.start(input());
    await flushAsyncWork();

    test.controller.dispose();
    batchCompletion.resolve({ status: "fulfilled" });
    assert.equal(await result, "finished");
    test.controller.activate();

    assert.equal(test.controller.isRunning(), false);
    assert.deepEqual(test.runningChanges, [true, false, false, false]);
  });
});
