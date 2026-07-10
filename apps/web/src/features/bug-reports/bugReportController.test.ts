import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEmptyBugReportDraft,
  MAX_BUG_REPORT_IMAGES,
  type BugReportDraft,
  type BugReportImage,
  type ChatSession
} from "../../domain/chat/sessionModel";
import {
  createBugReportController,
  type BugReportControllerDependencies,
  type BugReportViewState
} from "./bugReportController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function image(
  id: string,
  options: { captured?: boolean; createdAt?: number } = {}
): BugReportImage {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 4,
    dataUrl: "data:image/png;base64,AAAA",
    captured: options.captured,
    createdAt: options.createdAt ?? 1
  };
}

function draft(
  text = "Details",
  images: BugReportImage[] = [],
  screenshotCapturedAt?: number
): BugReportDraft {
  return {
    text,
    images,
    updatedAt: 1,
    screenshotCapturedAt
  };
}

function session(
  id: string,
  options: {
    title?: string;
    draft?: BugReportDraft;
    content?: string;
  } = {}
): ChatSession {
  return {
    id,
    title: options.title ?? id,
    createdAt: 1,
    updatedAt: 1,
    messages: options.content
      ? [{ id: `message-${id}`, role: "user", content: options.content }]
      : [],
    files: [],
    bugReportDraft: options.draft
  };
}

type ScheduledTask = {
  delayMs: number;
  cancelled: boolean;
  run(): void;
};

function harness(options: {
  sessions?: ChatSession[];
  activeSessionId?: string;
  capturePage?: BugReportControllerDependencies["capturePage"];
  encodeBlob?: BugReportControllerDependencies["encodeBlob"];
  submitReport?: BugReportControllerDependencies["submitReport"];
  now?: () => number;
} = {}) {
  const defaultSession = session("session-a");
  const sessions = new Map(
    (options.sessions ?? [defaultSession]).map((item) => [item.id, item])
  );
  let activeSessionId = options.activeSessionId ?? defaultSession.id;
  let clientId = "client-1";
  let saveCount = 0;
  const states: BugReportViewState[] = [];
  const warnings: Array<[string, unknown]> = [];
  const events: string[] = [];
  const scheduled: ScheduledTask[] = [];
  const submissions: Array<{
    input: Parameters<BugReportControllerDependencies["submitReport"]>[0];
    clientId: string;
  }> = [];

  const controller = createBugReportController(
    {
      getActiveSessionId: () => activeSessionId,
      getSession: (sessionId) => sessions.get(sessionId),
      updateSession: (sessionId, updater) => {
        const current = sessions.get(sessionId);
        if (!current) {
          return false;
        }
        events.push(`update:${sessionId}`);
        sessions.set(sessionId, updater(current));
        return true;
      },
      getClientId: () => clientId,
      saveNow: () => {
        saveCount += 1;
        events.push("save");
      },
      onStateChange: (state) => {
        states.push(state);
        events.push(`state:${state.phase}`);
      }
    },
    {
      capturePage:
        options.capturePage ??
        (async () => new Blob(["png"], { type: "image/png" })),
      encodeBlob:
        options.encodeBlob ??
        (async () => "data:image/png;base64,cG5n"),
      submitReport:
        options.submitReport ??
        (async (input, submittedClientId) => {
          submissions.push({ input, clientId: submittedClientId });
          return "report-1";
        }),
      createImageId: () => "captured-image",
      now: options.now ?? (() => 100),
      getViewport: () => ({ width: 1280, height: 720 }),
      warn: (message, error) => warnings.push([message, error]),
      schedule: (delayMs, task) => {
        const scheduledTask: ScheduledTask = {
          delayMs,
          cancelled: false,
          run() {
            if (!scheduledTask.cancelled) {
              task();
            }
          }
        };
        scheduled.push(scheduledTask);
        events.push(`schedule:${delayMs}`);
        return {
          cancel() {
            scheduledTask.cancelled = true;
            events.push("cancel-timer");
          }
        };
      }
    }
  );

  return {
    controller,
    sessions,
    states,
    warnings,
    events,
    scheduled,
    submissions,
    get activeSessionId() {
      return activeSessionId;
    },
    set activeSessionId(value: string) {
      activeSessionId = value;
    },
    set clientId(value: string) {
      clientId = value;
    },
    get saveCount() {
      return saveCount;
    }
  };
}

describe("bug report controller open and drafts", () => {
  it("returns missing without side effects when the active session is absent", async () => {
    const test = harness({ sessions: [], activeSessionId: "missing" });

    assert.equal(await test.controller.open(), "missing");
    assert.deepEqual(test.states, []);
    assert.deepEqual(test.warnings, []);
  });

  it("opens without capture for an existing marker, captured image, or full draft", async () => {
    const cases = [
      draft("marker", [], 5),
      draft("captured", [image("captured", { captured: true })]),
      draft(
        "full",
        Array.from({ length: MAX_BUG_REPORT_IMAGES }, (_, index) =>
          image(`image-${index}`)
        )
      )
    ];

    for (const bugReportDraft of cases) {
      let captures = 0;
      const test = harness({
        sessions: [session("session-a", { draft: bugReportDraft })],
        capturePage: async () => {
          captures += 1;
          return new Blob();
        }
      });

      assert.equal(await test.controller.open(), "opened");
      assert.equal(test.controller.getState().phase, "editing");
      assert.equal(test.controller.getState().sessionId, "session-a");
      assert.equal(captures, 0);
    }
  });

  it("captures into the locked target using the latest draft", async () => {
    const capture = deferred<Blob>();
    const first = session("session-a", { draft: draft("initial") });
    const second = session("session-b", { draft: draft("other", [], 2) });
    const test = harness({
      sessions: [first, second],
      activeSessionId: first.id,
      capturePage: () => capture.promise
    });

    const opening = test.controller.open();
    assert.equal(test.controller.getState().phase, "capturing");
    test.activeSessionId = second.id;
    test.sessions.set(first.id, {
      ...first,
      bugReportDraft: draft("latest while capturing")
    });
    capture.resolve(new Blob(["png"]));

    assert.equal(await opening, "opened");
    const result = test.sessions.get(first.id)?.bugReportDraft;
    assert.equal(result?.text, "latest while capturing");
    assert.equal(result?.images.length, 1);
    assert.deepEqual(result?.images[0], {
      id: "captured-image",
      name: "page-screenshot.png",
      mimeType: "image/png",
      size: 3,
      dataUrl: "data:image/png;base64,cG5n",
      width: 1280,
      height: 720,
      captured: true,
      createdAt: 100
    });
    assert.equal(result?.screenshotCapturedAt, 100);
    assert.equal(test.sessions.get(second.id)?.bugReportDraft?.text, "other");
    assert.deepEqual(test.events, [
      "state:capturing",
      "update:session-a",
      "state:editing"
    ]);
  });

  it("deduplicates a screenshot added while capture is pending", async () => {
    const capture = deferred<Blob>();
    const target = session("session-a");
    const test = harness({
      sessions: [target],
      capturePage: () => capture.promise
    });
    const opening = test.controller.open();
    const concurrent = image("concurrent", { captured: true, createdAt: 50 });
    test.sessions.set(target.id, {
      ...target,
      bugReportDraft: draft("concurrent", [concurrent])
    });

    capture.resolve(new Blob(["png"]));
    assert.equal(await opening, "opened");
    assert.deepEqual(
      test.sessions
        .get(target.id)
        ?.bugReportDraft?.images.map((item) => [item.id, item.captured]),
      [["concurrent", true]]
    );
    assert.equal(
      test.sessions.get(target.id)?.bugReportDraft?.screenshotCapturedAt,
      100
    );
  });

  it("opens with a recoverable error when capture or encoding fails", async () => {
    const error = new Error("capture failed");
    const test = harness({
      capturePage: async () => {
        throw error;
      }
    });

    assert.equal(
      await test.controller.open(),
      "opened-with-capture-error"
    );
    assert.deepEqual(test.controller.getState(), {
      phase: "editing",
      sessionId: "session-a",
      captureError:
        "Could not capture the page screenshot. You can still add images manually.",
      submitError: null
    });
    assert.deepEqual(test.warnings, [
      ["Could not capture bug report screenshot.", error]
    ]);
  });

  it("deduplicates concurrent opens synchronously", async () => {
    const capture = deferred<Blob>();
    let captures = 0;
    const test = harness({
      capturePage: () => {
        captures += 1;
        return capture.promise;
      }
    });

    const first = test.controller.open();
    assert.equal(await test.controller.open(), "busy");
    assert.equal(captures, 1);
    capture.resolve(new Blob(["png"]));
    assert.equal(await first, "opened");
  });

  it("does not fall back when the locked target disappears during capture", async () => {
    const capture = deferred<Blob>();
    const first = session("session-a");
    const second = session("session-b", { draft: draft("keep", [], 2) });
    const test = harness({
      sessions: [first, second],
      capturePage: () => capture.promise
    });
    const opening = test.controller.open();
    test.sessions.delete(first.id);
    test.activeSessionId = second.id;
    capture.resolve(new Blob(["png"]));

    assert.equal(await opening, "missing");
    assert.equal(test.controller.getState().phase, "closed");
    assert.equal(test.sessions.get(second.id)?.bugReportDraft?.text, "keep");
  });

  it("ignores a stale capture after close and preserves the draft", async () => {
    const capture = deferred<Blob>();
    const existing = draft("keep me");
    const test = harness({
      sessions: [session("session-a", { draft: existing })],
      capturePage: () => capture.promise
    });
    const opening = test.controller.open();

    test.controller.close();
    capture.resolve(new Blob(["png"]));

    assert.equal(await opening, "cancelled");
    assert.equal(test.controller.getState().phase, "closed");
    assert.equal(test.sessions.get("session-a")?.bugReportDraft, existing);
    assert.equal(test.saveCount, 1);
  });

  it("suppresses a rejected capture after close without warning or reopening", async () => {
    const capture = deferred<Blob>();
    const test = harness({ capturePage: () => capture.promise });
    const opening = test.controller.open();
    test.controller.close();

    capture.reject(new Error("late capture failure"));

    assert.equal(await opening, "cancelled");
    assert.equal(test.controller.getState().phase, "closed");
    assert.deepEqual(test.warnings, []);
    assert.deepEqual(
      test.states.map((state) => state.phase),
      ["capturing", "closed"]
    );
  });

  it("changes only the locked session draft and normalizes it", async () => {
    const first = session("session-a", { draft: draft("existing", [], 2) });
    const second = session("session-b", { draft: draft("other", [], 2) });
    const test = harness({ sessions: [first, second] });
    await test.controller.open();
    test.activeSessionId = second.id;
    const oversized = createEmptyBugReportDraft(1);
    oversized.text = "x".repeat(13_000);

    assert.equal(test.controller.changeDraft(oversized), true);
    assert.equal(
      test.sessions.get(first.id)?.bugReportDraft?.text.length,
      12_000
    );
    assert.equal(test.sessions.get(second.id)?.bugReportDraft?.text, "other");
    test.sessions.delete(first.id);
    assert.equal(test.controller.changeDraft(draft("missing")), false);
    test.controller.close();
    assert.equal(test.controller.changeDraft(draft("ignored")), false);
  });
});

describe("bug report controller submit lifecycle", () => {
  it("rejects missing and empty targets without submitting", async () => {
    const missing = harness({ sessions: [], activeSessionId: "missing" });
    assert.equal(await missing.controller.submit(), "missing");

    const empty = harness({
      sessions: [session("session-a", { draft: draft("", [], 5) })]
    });
    await empty.controller.open();
    assert.equal(await empty.controller.submit(), "empty");
    assert.deepEqual(empty.submissions, []);
  });

  it("submits the locked draft, schedules success close, and clears only that target", async () => {
    const first = session("session-a", {
      title: "",
      content: "Fallback title",
      draft: draft("send this", [], 5)
    });
    const second = session("session-b", { draft: draft("keep this", [], 5) });
    const test = harness({ sessions: [first, second] });
    test.clientId = "latest-client";
    await test.controller.open();

    assert.equal(await test.controller.submit(), "submitted");
    assert.equal(test.controller.getState().phase, "submitted");
    assert.equal(test.submissions.length, 1);
    assert.deepEqual(test.submissions[0], {
      input: {
        sessionId: first.id,
        sessionTitle: "Fallback title",
        draft: first.bugReportDraft
      },
      clientId: "latest-client"
    });
    assert.equal(test.scheduled.length, 1);
    assert.equal(test.scheduled[0].delayMs, 1_400);

    test.activeSessionId = second.id;
    const eventStart = test.events.length;
    test.scheduled[0].run();

    assert.equal(test.sessions.get(first.id)?.bugReportDraft, undefined);
    assert.equal(test.sessions.get(second.id)?.bugReportDraft?.text, "keep this");
    assert.equal(test.controller.getState().phase, "closed");
    assert.equal(test.saveCount, 1);
    assert.deepEqual(test.events.slice(eventStart), [
      "update:session-a",
      "state:closed",
      "save"
    ]);
  });

  it("deduplicates concurrent submit attempts", async () => {
    const submission = deferred<string>();
    let calls = 0;
    const test = harness({
      sessions: [session("session-a", { draft: draft("send") })],
      submitReport: () => {
        calls += 1;
        return submission.promise;
      }
    });
    await test.controller.open();

    const first = test.controller.submit();
    assert.equal(await test.controller.submit(), "busy");
    assert.equal(calls, 1);
    submission.resolve("report-1");
    assert.equal(await first, "submitted");
  });

  it("returns to editing with a useful Error or fallback failure message", async () => {
    for (const failure of [new Error("server refused"), "unknown failure"]) {
      const test = harness({
        sessions: [session("session-a", { draft: draft("send") })],
        submitReport: async () => {
          throw failure;
        }
      });
      await test.controller.open();

      assert.equal(await test.controller.submit(), "failed");
      assert.equal(test.controller.getState().phase, "editing");
      assert.equal(
        test.controller.getState().submitError,
        failure instanceof Error
          ? "server refused"
          : "Could not submit bug report."
      );
      assert.equal(test.scheduled.length, 0);
      assert.equal(
        test.sessions.get("session-a")?.bugReportDraft?.text,
        "send"
      );
    }
  });

  it("ignores a pending submit completion after close", async () => {
    const submission = deferred<string>();
    const existing = draft("keep", [], 5);
    const test = harness({
      sessions: [session("session-a", { draft: existing })],
      submitReport: () => submission.promise
    });
    await test.controller.open();
    const submitting = test.controller.submit();

    test.controller.close();
    submission.resolve("report-1");

    assert.equal(await submitting, "cancelled");
    assert.equal(test.controller.getState().phase, "closed");
    assert.equal(test.sessions.get("session-a")?.bugReportDraft, existing);
    assert.equal(test.scheduled.length, 0);
    assert.equal(test.saveCount, 1);
  });

  it("closes without falling back when the submit target is deleted", async () => {
    const submission = deferred<string>();
    const first = session("session-a", { draft: draft("send", [], 5) });
    const second = session("session-b", { draft: draft("keep", [], 5) });
    const test = harness({
      sessions: [first, second],
      submitReport: () => submission.promise
    });
    await test.controller.open();
    const submitting = test.controller.submit();
    test.sessions.delete(first.id);
    test.activeSessionId = second.id;
    submission.resolve("report-1");

    assert.equal(await submitting, "missing");
    assert.equal(test.controller.getState().phase, "closed");
    assert.equal(test.sessions.get(second.id)?.bugReportDraft?.text, "keep");
    assert.equal(test.scheduled.length, 0);
  });

  it("closes when a deleted submit target rejects", async () => {
    const submission = deferred<string>();
    const first = session("session-a", { draft: draft("send", [], 5) });
    const second = session("session-b", { draft: draft("keep", [], 5) });
    const test = harness({
      sessions: [first, second],
      submitReport: () => submission.promise
    });
    await test.controller.open();
    const submitting = test.controller.submit();
    test.sessions.delete(first.id);
    test.activeSessionId = second.id;
    submission.reject(new Error("request failed"));

    assert.equal(await submitting, "missing");
    assert.equal(test.controller.getState().phase, "closed");
    assert.equal(test.sessions.get(second.id)?.bugReportDraft?.text, "keep");
    assert.equal(test.controller.getState().submitError, null);
  });

  it("cancels an old success timer so it cannot clear a reopened draft", async () => {
    const target = session("session-a", { draft: draft("first", [], 5) });
    const test = harness({ sessions: [target] });
    await test.controller.open();
    assert.equal(await test.controller.submit(), "submitted");
    const oldTimer = test.scheduled[0];

    test.controller.close();
    test.sessions.set(target.id, {
      ...target,
      bugReportDraft: draft("new draft", [], 6)
    });
    assert.equal(await test.controller.open(), "opened");
    oldTimer.run();

    assert.equal(oldTimer.cancelled, true);
    assert.equal(
      test.sessions.get(target.id)?.bugReportDraft?.text,
      "new draft"
    );
  });

  it("dispose invalidates stale work but leaves the controller reusable", async () => {
    const capture = deferred<Blob>();
    let captureCalls = 0;
    const test = harness({
      capturePage: () => {
        captureCalls += 1;
        return captureCalls === 1
          ? capture.promise
          : Promise.resolve(new Blob(["next"]));
      }
    });
    const first = test.controller.open();
    test.controller.dispose();
    capture.resolve(new Blob(["old"]));

    assert.equal(await first, "cancelled");
    assert.equal(await test.controller.open(), "opened");
    assert.equal(test.controller.getState().phase, "editing");
    assert.equal(test.saveCount, 0);
  });

  it("dispose suppresses a pending submit and permits a later reopen", async () => {
    const submission = deferred<string>();
    const test = harness({
      sessions: [session("session-a", { draft: draft("send", [], 5) })],
      submitReport: () => submission.promise
    });
    await test.controller.open();
    const submitting = test.controller.submit();
    test.controller.dispose();
    submission.resolve("report-1");

    assert.equal(await submitting, "cancelled");
    assert.equal(test.scheduled.length, 0);
    assert.equal(await test.controller.open(), "opened");
    assert.equal(test.controller.getState().phase, "editing");
  });

  it("dispose cancels a submitted timer without clearing the draft", async () => {
    const existing = draft("keep", [], 5);
    const test = harness({
      sessions: [session("session-a", { draft: existing })]
    });
    await test.controller.open();
    assert.equal(await test.controller.submit(), "submitted");
    const timer = test.scheduled[0];

    test.controller.dispose();
    timer.run();

    assert.equal(timer.cancelled, true);
    assert.equal(test.sessions.get("session-a")?.bugReportDraft, existing);
    assert.equal(test.saveCount, 0);
  });
});
