import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assistant,
  regeneratedRaw
} from "./artifactEditOperationTestFixtures";
import {
  chatSession,
  createArtifactEditControllerHarness,
  deferred,
  selection,
  sourceAssistant,
  type ArtifactEditControllerHarness
} from "./artifactEditControllerTestHarness";

function completePendingRegeneration(
  test: ArtifactEditControllerHarness,
  rawStream: string
): void {
  const session = test.state.sessions[0];
  const message = session.messages[0];
  const pendingEdit = message.artifactEdits?.find(
    (edit) => edit.status === "pending"
  );
  assert.ok(pendingEdit);
  test.state = {
    ...test.state,
    sessions: [
      {
        ...session,
        messages: [
          {
            ...message,
            content: "Server complete",
            rawStream,
            artifactEdits: message.artifactEdits?.map((edit) =>
              edit.id === pendingEdit.id
                ? {
                    ...edit,
                    status: "complete",
                    variants: edit.variants.map((variant) => ({
                      ...variant,
                      status: "complete",
                      rawStream
                    }))
                  }
                : edit
            )
          }
        ]
      }
    ]
  };
}

describe("artifact edit controller lifecycle barriers", () => {
  it("rejects work while disposed and becomes reusable only after activate", async () => {
    const test = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())]
    });
    test.controller.dispose();
    test.controller.dispose();

    assert.equal(
      await test.controller.runSourceEdit("Edit", [selection]),
      "cancelled"
    );
    assert.equal(
      await test.controller.regenerate("assistant-1", "edit-1"),
      "cancelled"
    );
    assert.equal(
      test.controller.editPrompt("assistant-1", "edit-1", "Changed"),
      false
    );
    assert.equal(test.controller.cancelActive(), false);
    assert.equal(test.leaseAcquisitions, 0);
    assert.equal(test.mutationCalls, 0);
    assert.equal(test.requests.length, 0);
    assert.equal(test.savedStates.length, 0);

    test.state = {
      activeSessionId: "session-a",
      sessions: [chatSession("session-a", sourceAssistant())]
    };
    test.controller.activate();
    test.controller.activate();
    assert.equal(
      await test.controller.runSourceEdit("After activate", [selection]),
      "completed"
    );
    assert.equal(test.requests.length, 1);
    assert.equal(test.savedStates.length, 1);
  });

  it("keeps disposed A late rejection from touching activated B", async () => {
    const firstRequest = deferred<{ rawStream: string }>();
    const secondRequest = deferred<{ rawStream: string }>();
    let requestIndex = 0;
    const test = createArtifactEditControllerHarness({
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: false
      },
      requestEdit: () =>
        requestIndex++ === 0 ? firstRequest.promise : secondRequest.promise
    });

    const first = test.controller.runSourceEdit("First", [selection]);
    test.controller.dispose();
    test.state = {
      activeSessionId: "session-a",
      sessions: [chatSession("session-a", sourceAssistant())]
    };
    test.controller.activate();
    const second = test.controller.runSourceEdit("Second", [selection]);
    const mutationCallsBeforeLate = test.mutationCalls;
    const releasesBeforeLate = test.leaseReleases;

    firstRequest.reject(new Error("late first failure"));
    assert.equal(await first, "cancelled");
    assert.equal(test.mutationCalls, mutationCallsBeforeLate);
    assert.equal(test.leaseReleases, releasesBeforeLate);
    assert.equal(test.savedStates.length, 0);
    assert.equal(test.refreshes, 0);
    assert.equal(
      test.state.sessions[0].messages[0].artifactEdits?.[0].prompt,
      "Second"
    );

    secondRequest.resolve({ rawStream: regeneratedRaw });
    assert.equal(await second, "completed");
    assert.equal(test.leaseReleases, 2);
    assert.equal(test.savedStates.length, 1);
    assert.equal(test.refreshes, 1);
  });

  it("suppresses a previous lifecycle refresh rejection", async () => {
    const refresh = deferred<void>();
    const test = createArtifactEditControllerHarness({
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: false
      },
      refreshAuthentication: () => refresh.promise
    });

    assert.equal(
      await test.controller.runSourceEdit("Edit", [selection]),
      "completed"
    );
    assert.equal(test.refreshes, 1);
    test.controller.dispose();
    test.controller.activate();
    refresh.reject(new Error("old refresh failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(test.warnings.length, 0);
    assert.equal(test.savedStates.length, 1);
  });
});

describe("artifact edit controller stale terminals", () => {
  it("does not save a provider failure after its target is deleted", async () => {
    const request = deferred<{ rawStream: string }>();
    const test = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      requestEdit: () => request.promise
    });
    const completion = test.controller.regenerate("assistant-1", "edit-1");
    test.state = {
      ...test.state,
      sessions: [{ ...test.state.sessions[0], messages: [] }]
    };

    request.reject(new Error("provider failure"));
    assert.equal(await completion, "stale");
    assert.deepEqual(test.state.sessions[0].messages, []);
    assert.equal(test.savedStates.length, 0);
    assert.equal(test.selectionClears, 0);
    assert.equal(test.leaseReleases, 1);
  });

  it("preserves server completion when a local AbortError arrives later", async () => {
    const request = deferred<{ rawStream: string }>();
    const test = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      requestEdit: () => request.promise
    });
    const completion = test.controller.regenerate("assistant-1", "edit-1");
    const serverRaw =
      "<chat>Server complete</chat><streamui><main>Server complete</main></streamui>";
    completePendingRegeneration(test, serverRaw);
    const abortError = new Error("late abort");
    abortError.name = "AbortError";

    request.reject(abortError);
    assert.equal(await completion, "stale");
    assert.equal(test.state.sessions[0].messages[0].rawStream, serverRaw);
    assert.equal(test.savedStates.length, 0);
    assert.equal(test.selectionClears, 0);
  });

  it("does not save cancel when the target disappeared but still refreshes managed auth", async () => {
    const request = deferred<{ rawStream: string }>();
    const test = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: false
      },
      requestEdit: () => request.promise
    });
    const completion = test.controller.regenerate("assistant-1", "edit-1");
    test.state = {
      ...test.state,
      sessions: [{ ...test.state.sessions[0], messages: [] }]
    };

    assert.equal(test.controller.cancelActive(), true);
    assert.equal(test.savedStates.length, 0);
    assert.equal(test.refreshes, 1);
    assert.equal(test.leaseReleases, 1);
    request.reject(new Error("late failure"));
    assert.equal(await completion, "cancelled");
    assert.equal(test.refreshes, 1);
    assert.equal(test.savedStates.length, 0);
  });

  it("handles an unauthenticated prompt edit without starting work", () => {
    const test = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: true
      }
    });

    assert.equal(
      test.controller.editPrompt("assistant-1", "edit-1", "Changed prompt"),
      true
    );
    assert.equal(test.authenticationOpens, 1);
    assert.equal(test.mutationCalls, 0);
    assert.equal(test.requests.length, 0);
    assert.equal(test.selectionClears, 0);
    assert.equal(test.savedStates.length, 0);
    assert.equal(test.refreshes, 0);
  });
});
