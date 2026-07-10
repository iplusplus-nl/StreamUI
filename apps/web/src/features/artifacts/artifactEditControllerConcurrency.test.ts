import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArtifactEdit } from "../../domain/chat/sessionModel";
import {
  assistant,
  regeneratedRaw
} from "./artifactEditOperationTestFixtures";
import {
  chatSession,
  createArtifactEditControllerHarness,
  deferred,
  selection,
  sourceAssistant
} from "./artifactEditControllerTestHarness";

describe("artifact edit controller regeneration", () => {
  it("clears selections only after an applied regeneration completion", async () => {
    const request = deferred<{
      rawStream: string;
      summary: string;
    }>();
    const test = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      requestEdit: () => request.promise
    });

    const completion = test.controller.regenerate(
      "assistant-1",
      "edit-1",
      "  Revised prompt  "
    );
    assert.equal(test.selectionClears, 0);
    assert.equal(test.requests[0].request.prompt, "Revised prompt");
    assert.equal(
      test.state.sessions[0].messages[0].artifactEdits?.[1].status,
      "pending"
    );

    request.resolve({ rawStream: regeneratedRaw, summary: "Revised" });
    assert.equal(await completion, "completed");
    const message = test.state.sessions[0].messages[0];
    assert.equal(test.selectionClears, 1);
    assert.equal(message.rawStream, regeneratedRaw);
    assert.equal(message.artifactEdits?.[1].status, "complete");
    assert.equal(message.artifactEdits?.[1].prompt, "Revised prompt");
  });

  it("does not clear selections created after switching to another session", async () => {
    const request = deferred<{ rawStream: string }>();
    const sessionA = chatSession("session-a", assistant());
    const sessionB = chatSession(
      "session-b",
      sourceAssistant({ id: "assistant-b" })
    );
    const test = createArtifactEditControllerHarness({
      sessions: [sessionA, sessionB],
      activeSessionId: sessionA.id,
      requestEdit: () => request.promise
    });

    const completion = test.controller.regenerate("assistant-1", "edit-1");
    test.activeSessionId = sessionB.id;
    request.resolve({ rawStream: regeneratedRaw });

    assert.equal(await completion, "completed");
    assert.equal(test.state.sessions[0].messages[0].rawStream, regeneratedRaw);
    assert.equal(test.selectionClears, 0);
    assert.deepEqual(test.selectionClearTargets, []);
  });

  it("preserves selections on regeneration error and cancellation", async () => {
    const failed = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      requestEdit: async () => {
        throw new Error("nope");
      }
    });
    assert.equal(
      await failed.controller.regenerate("assistant-1", "edit-1"),
      "failed"
    );
    assert.equal(failed.selectionClears, 0);
    assert.equal(
      failed.state.sessions[0].messages[0].artifactEdits?.[1].status,
      "error"
    );

    const request = deferred<{ rawStream: string }>();
    const cancelled = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      requestEdit: () => request.promise
    });
    const completion = cancelled.controller.regenerate(
      "assistant-1",
      "edit-1"
    );
    assert.equal(cancelled.controller.cancelActive(), true);
    assert.equal(cancelled.selectionClears, 0);
    assert.equal(
      cancelled.state.sessions[0].messages[0].artifactEdits?.length,
      1
    );
    request.resolve({ rawStream: regeneratedRaw });
    assert.equal(await completion, "cancelled");
    assert.equal(cancelled.selectionClears, 0);
  });

  it("returns validation outcomes before acquiring a lease", async () => {
    const missing = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())]
    });
    assert.equal(
      await missing.controller.regenerate("assistant-1", "missing"),
      "missing"
    );

    const pendingEdit: ArtifactEdit = {
      id: "pending",
      createdAt: 1,
      prompt: "Pending",
      references: [],
      activeVariantId: "pending-variant",
      variants: [
        { id: "pending-variant", createdAt: 1, status: "pending" }
      ],
      status: "pending"
    };
    const pending = createArtifactEditControllerHarness({
      sessions: [
        chatSession(
          "session-a",
          assistant({
            artifactEdits: [...(assistant().artifactEdits ?? []), pendingEdit]
          })
        )
      ]
    });
    assert.equal(
      await pending.controller.regenerate("assistant-1", "edit-1"),
      "pending"
    );

    const invalid = createArtifactEditControllerHarness({
      sessions: [
        chatSession(
          "session-a",
          assistant({
            artifactEditBaseRawStream: "",
            rawStream: "",
            artifactEdits: [
              {
                ...(assistant().artifactEdits?.[0] as ArtifactEdit),
                variants: [
                  {
                    id: "edit-1-variant",
                    createdAt: 1,
                    status: "complete",
                    rawStream: ""
                  }
                ]
              }
            ]
          })
        )
      ]
    });
    assert.equal(
      await invalid.controller.regenerate("assistant-1", "edit-1"),
      "invalid"
    );
    assert.match(invalid.warnings[0].message, /completed source/);

    for (const test of [missing, pending, invalid]) {
      assert.equal(test.leaseAcquisitions, 0);
      assert.equal(test.mutationCalls, 0);
      assert.equal(test.requests.length, 0);
    }
  });

  it("keeps prompt editing synchronous while starting changed prompts", async () => {
    const request = deferred<{ rawStream: string }>();
    const test = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      requestEdit: () => request.promise
    });

    assert.equal(test.controller.editPrompt("assistant-1", "edit-1", " "), false);
    assert.equal(
      test.controller.editPrompt("assistant-1", "edit-1", "Edit edit-1"),
      true
    );
    assert.equal(test.requests.length, 0);
    assert.equal(
      test.controller.editPrompt("assistant-1", "edit-1", "New prompt"),
      true
    );
    assert.equal(test.requests.length, 1);
    assert.equal(test.controller.isRunning(), true);

    request.resolve({ rawStream: regeneratedRaw });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(test.controller.isRunning(), false);
    assert.equal(test.selectionClears, 1);
  });
});

describe("artifact edit controller cancellation and stale work", () => {
  it("rolls back immediately and ignores a late success before a new run settles", async () => {
    const firstRequest = deferred<{ rawStream: string }>();
    const secondRequest = deferred<{ rawStream: string }>();
    let requestIndex = 0;
    const test = createArtifactEditControllerHarness({
      requestEdit: () =>
        requestIndex++ === 0 ? firstRequest.promise : secondRequest.promise
    });

    const first = test.controller.runSourceEdit("First", [selection]);
    assert.equal(test.controller.cancelActive(), true);
    assert.equal(test.controller.cancelActive(), false);
    assert.equal(test.leaseReleases, 1);
    assert.equal(test.savedStates.length, 1);
    assert.equal(test.state.sessions[0].messages[0].artifactEdits, undefined);

    const second = test.controller.runSourceEdit("Second", [selection]);
    const secondPending = test.state.sessions[0].messages[0];
    assert.equal(secondPending.artifactEdits?.[0].prompt, "Second");
    assert.equal(test.leaseAcquisitions, 2);
    assert.equal(test.leaseReleases, 1);

    firstRequest.resolve({
      rawStream:
        "<chat>Late first</chat><streamui><main>Late first</main></streamui>"
    });
    assert.equal(await first, "cancelled");
    assert.equal(test.leaseReleases, 1);
    assert.equal(test.savedStates.length, 1);
    const readCurrentEdits = (): ArtifactEdit[] | undefined =>
      test.state.sessions[0].messages[0].artifactEdits;
    const editsAfterLateCompletion = readCurrentEdits();
    assert.equal(editsAfterLateCompletion?.[0].prompt, "Second");

    secondRequest.resolve({ rawStream: regeneratedRaw });
    assert.equal(await second, "completed");
    assert.equal(test.leaseReleases, 2);
    assert.equal(test.savedStates.length, 2);
  });

  it("locks terminal mutations to the starting session even with duplicate ids", async () => {
    const request = deferred<{ rawStream: string }>();
    const sessionA = chatSession("session-a", sourceAssistant());
    const duplicate = sourceAssistant({ content: "Duplicate untouched" });
    const sessionB = chatSession("session-b", duplicate);
    const test = createArtifactEditControllerHarness({
      sessions: [sessionA, sessionB],
      activeSessionId: sessionA.id,
      requestEdit: () => request.promise
    });

    const completion = test.controller.runSourceEdit("Edit A", [selection]);
    assert.equal(
      test.state.sessions[0].messages[0].artifactEdits?.[0].status,
      "pending"
    );
    assert.equal(test.state.sessions[1].messages[0], duplicate);
    test.activeSessionId = sessionB.id;
    request.resolve({ rawStream: regeneratedRaw });

    assert.equal(await completion, "completed");
    assert.equal(test.state.sessions[0].messages[0].rawStream, regeneratedRaw);
    assert.equal(test.state.sessions[1].messages[0], duplicate);
  });

  it("does not recreate a target deleted before terminal completion", async () => {
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

    request.resolve({ rawStream: regeneratedRaw });
    assert.equal(await completion, "stale");
    assert.deepEqual(test.state.sessions[0].messages, []);
    assert.equal(test.selectionClears, 0);
    assert.equal(test.savedStates.length, 0);
  });

  it("keeps a server-completed pending edit when the local result arrives late", async () => {
    const request = deferred<{ rawStream: string }>();
    const test = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      requestEdit: () => request.promise
    });
    const completion = test.controller.regenerate("assistant-1", "edit-1");
    const pendingMessage = test.state.sessions[0].messages[0];
    const pendingEdit = pendingMessage.artifactEdits?.[1];
    assert.ok(pendingEdit);
    const serverRaw =
      "<chat>Server won</chat><streamui><main>Server won</main></streamui>";
    test.state = {
      ...test.state,
      sessions: [
        {
          ...test.state.sessions[0],
          messages: [
            {
              ...pendingMessage,
              rawStream: serverRaw,
              content: "Server won",
              artifactEdits: pendingMessage.artifactEdits?.map((edit) =>
                edit.id === pendingEdit.id
                  ? {
                      ...edit,
                      status: "complete",
                      variants: edit.variants.map((variant) => ({
                        ...variant,
                        status: "complete",
                        rawStream: serverRaw
                      }))
                    }
                  : edit
              )
            }
          ]
        }
      ]
    };

    request.resolve({ rawStream: regeneratedRaw });
    assert.equal(await completion, "stale");
    assert.equal(test.state.sessions[0].messages[0].rawStream, serverRaw);
    assert.equal(test.selectionClears, 0);
    assert.equal(test.savedStates.length, 0);
  });

  it("rolls back a request-side AbortError and saves once", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const test = createArtifactEditControllerHarness({
      requestEdit: async () => {
        throw abortError;
      }
    });

    assert.equal(
      await test.controller.runSourceEdit("Edit", [selection]),
      "cancelled"
    );
    assert.equal(test.state.sessions[0].messages[0].artifactEdits, undefined);
    assert.equal(test.leaseReleases, 1);
    assert.equal(test.savedStates.length, 1);
  });

  it("dispose aborts and releases without late state, save, or auth effects", async () => {
    const request = deferred<{ rawStream: string }>();
    const test = createArtifactEditControllerHarness({
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: false
      },
      requestEdit: () => request.promise
    });
    const completion = test.controller.runSourceEdit("Edit", [selection]);
    const mutationCalls = test.mutationCalls;
    assert.equal(test.requests[0].signal.aborted, false);

    test.controller.dispose();
    assert.equal(test.requests[0].signal.aborted, true);
    assert.equal(test.leaseReleases, 1);
    assert.equal(test.savedStates.length, 0);
    assert.equal(test.refreshes, 0);
    assert.equal(test.controller.isRunning(), false);

    request.resolve({ rawStream: regeneratedRaw });
    assert.equal(await completion, "cancelled");
    assert.equal(test.mutationCalls, mutationCalls);
    assert.equal(test.leaseReleases, 1);
    assert.equal(test.savedStates.length, 0);
    assert.equal(test.refreshes, 0);
  });

  it("contains managed refresh rejection after terminal state is saved", async () => {
    const test = createArtifactEditControllerHarness({
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: false
      },
      refreshAuthentication: async () => {
        throw new Error("refresh failed");
      }
    });

    assert.equal(
      await test.controller.runSourceEdit("Edit", [selection]),
      "completed"
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(test.savedStates.length, 1);
    assert.equal(test.refreshes, 1);
    assert.equal(test.warnings.length, 1);
    assert.equal(test.warnings[0].message, "Could not refresh ChatHTML Cloud account.");
    assert.match(String(test.warnings[0].error), /refresh failed/);
  });
});
