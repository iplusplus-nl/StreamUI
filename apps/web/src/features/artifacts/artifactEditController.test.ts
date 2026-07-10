import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageAttachment } from "../../core/imageAttachments";
import { assistant } from "./artifactEditOperationTestFixtures";
import {
  chatSession,
  createArtifactEditControllerHarness,
  deferred,
  selection,
  sourceAssistant
} from "./artifactEditControllerTestHarness";

describe("artifact edit controller source lifecycle", () => {
  it("runs pending, request, complete, release, and save in order", async () => {
    const request = deferred<{
      rawStream: string;
      summary: string;
      edits: Array<{ note: string }>;
    }>();
    const test = createArtifactEditControllerHarness({
      requestEdit: () => request.promise
    });

    const completion = test.controller.runSourceEdit("  Enlarge hero  ", [
      selection
    ]);

    const pending = test.state.sessions[0].messages[0];
    assert.equal(test.controller.isRunning(), true);
    assert.equal(test.leaseAcquisitions, 1);
    assert.equal(test.leaseReleases, 0);
    assert.equal(test.selectionClears, 1);
    assert.equal(test.requests.length, 1);
    assert.equal(test.requests[0].clientId, "client-initial");
    assert.deepEqual(test.requests[0].request.apiSettings, {
      marker: "initial"
    });
    assert.equal(test.requests[0].request.prompt, "Enlarge hero");
    assert.equal(test.requests[0].request.references[0].key, "hero");
    assert.equal(pending.artifactEdits?.[0].status, "pending");
    assert.deepEqual(test.events.slice(0, 4), [
      "acquire:operation-1",
      "mutate:session-a:assistant-1",
      "clear-selections:assistant-1",
      "request"
    ]);

    test.clientId = "client-late";
    test.themeMode = "day";
    request.resolve({
      rawStream:
        "<chat>Completed</chat><streamui><main>Completed artifact</main></streamui>",
      summary: "Done",
      edits: [{ note: "changed" }]
    });

    assert.equal(await completion, "completed");
    const completed = test.state.sessions[0].messages[0];
    assert.equal(completed.content, "Completed");
    assert.equal(completed.artifactEdits?.[0].status, "complete");
    assert.equal(completed.artifactEdits?.[0].variants[0].summary, "Done");
    assert.equal(completed.artifactEdits?.[0].variants[0].editCount, 1);
    assert.equal(test.controller.isRunning(), false);
    assert.equal(test.busyOwner, null);
    assert.equal(test.leaseReleases, 1);
    assert.equal(test.savedStates.length, 1);
    assert.equal(
      test.savedStates[0].sessions[0].messages[0].artifactEdits?.[0].status,
      "complete"
    );
    assert.deepEqual(test.events.slice(-3), [
      "mutate:session-a:assistant-1",
      "release:operation-1",
      "save"
    ]);
  });

  it("rejects invalid source inputs without acquiring busy or requesting", async () => {
    const blank = createArtifactEditControllerHarness();
    assert.equal(
      await blank.controller.runSourceEdit("   ", [selection]),
      "invalid"
    );
    assert.equal(
      await blank.controller.runSourceEdit("Edit", []),
      "invalid"
    );

    const mixed = createArtifactEditControllerHarness();
    assert.equal(
      await mixed.controller.runSourceEdit("Edit", [
        selection,
        { ...selection, id: "selection-2", messageId: "assistant-2" }
      ]),
      "invalid"
    );
    assert.match(mixed.warnings[0].message, /single artifact/);

    const emptySource = createArtifactEditControllerHarness({
      sessions: [
        chatSession(
          "session-a",
          sourceAssistant({ rawStream: "", content: "No artifact" })
        )
      ]
    });
    assert.equal(
      await emptySource.controller.runSourceEdit("Edit", [selection]),
      "invalid"
    );
    assert.match(emptySource.warnings[0].message, /completed artifact source/);

    const missing = createArtifactEditControllerHarness({
      activeSessionId: "missing"
    });
    assert.equal(
      await missing.controller.runSourceEdit("Edit", [selection]),
      "missing"
    );

    for (const test of [blank, mixed, emptySource, missing]) {
      assert.equal(test.leaseAcquisitions, 0);
      assert.equal(test.mutationCalls, 0);
      assert.equal(test.requests.length, 0);
      assert.equal(test.savedStates.length, 0);
      assert.equal(test.selectionClears, 0);
    }
  });

  it("rejects attachments and preserves the existing warning", async () => {
    const test = createArtifactEditControllerHarness();
    const attachment: ImageAttachment = {
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      size: 1,
      dataUrl: "data:image/png;base64,AA=="
    };

    assert.equal(
      await test.controller.runSourceEdit("Edit", [selection], [attachment]),
      "unsupported-attachments"
    );
    assert.match(test.warnings[0].message, /do not support attachments/);
    assert.equal(test.leaseAcquisitions, 0);
    assert.equal(test.requests.length, 0);
  });

  it("opens managed authentication without any edit side effect", async () => {
    const source = createArtifactEditControllerHarness({
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: true
      }
    });
    assert.equal(
      await source.controller.runSourceEdit("Edit", [selection]),
      "authentication-required"
    );

    const regeneration = createArtifactEditControllerHarness({
      sessions: [chatSession("session-a", assistant())],
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: true
      }
    });
    assert.equal(
      await regeneration.controller.regenerate("assistant-1", "edit-1"),
      "authentication-required"
    );

    for (const test of [source, regeneration]) {
      assert.equal(test.authenticationOpens, 1);
      assert.equal(test.leaseAcquisitions, 0);
      assert.equal(test.mutationCalls, 0);
      assert.equal(test.requests.length, 0);
      assert.equal(test.selectionClears, 0);
      assert.equal(test.savedStates.length, 0);
      assert.equal(test.refreshes, 0);
    }
  });

  it("uses the atomic lease to block external and same-tick double starts", async () => {
    const blocked = createArtifactEditControllerHarness();
    blocked.externalBusy = true;
    assert.equal(
      await blocked.controller.runSourceEdit("Edit", [selection]),
      "busy"
    );
    assert.equal(blocked.leaseAcquisitions, 0);
    assert.equal(blocked.mutationCalls, 0);

    const request = deferred<{ rawStream: string }>();
    const test = createArtifactEditControllerHarness({
      requestEdit: () => request.promise
    });
    const first = test.controller.runSourceEdit("First", [selection]);
    assert.equal(
      await test.controller.runSourceEdit("Second", [selection]),
      "busy"
    );
    assert.equal(test.leaseAcquisitions, 1);
    assert.equal(test.requests.length, 1);
    assert.equal(test.state.sessions[0].messages[0].artifactEdits?.length, 1);

    request.resolve({
      rawStream:
        "<chat>First</chat><streamui><main>First result</main></streamui>"
    });
    assert.equal(await first, "completed");
  });

  it("does not request or clear selection when acquire or pending apply fails", async () => {
    const denied = createArtifactEditControllerHarness();
    denied.denyNextLease = true;
    assert.equal(
      await denied.controller.runSourceEdit("Edit", [selection]),
      "busy"
    );
    assert.equal(denied.mutationCalls, 0);
    assert.equal(denied.requests.length, 0);

    const missing = createArtifactEditControllerHarness();
    missing.dropNextMutation = true;
    assert.equal(
      await missing.controller.runSourceEdit("Edit", [selection]),
      "missing"
    );
    assert.equal(missing.leaseAcquisitions, 1);
    assert.equal(missing.leaseReleases, 1);
    assert.equal(missing.requests.length, 0);
    assert.equal(missing.selectionClears, 0);
    assert.equal(missing.savedStates.length, 0);
  });

  it("releases its lease when the pending mutation throws", async () => {
    const test = createArtifactEditControllerHarness();
    test.throwNextMutation = new Error("mutation failed");

    assert.equal(
      await test.controller.runSourceEdit("Edit", [selection]),
      "failed"
    );
    assert.equal(test.leaseAcquisitions, 1);
    assert.equal(test.leaseReleases, 1);
    assert.equal(test.controller.isRunning(), false);
    assert.equal(test.requests.length, 0);
    assert.equal(test.savedStates.length, 0);
    assert.equal(test.selectionClears, 0);
    assert.equal(test.warnings[0].message, "Could not initialize artifact edit.");
  });

  it("fails with a sanitized error, saves terminal state, and refreshes managed auth", async () => {
    const test = createArtifactEditControllerHarness({
      settings: {
        apiSettings: { marker: "managed" },
        managed: true,
        requiresAuthentication: false
      },
      requestEdit: async () => {
        throw new Error("provider detail");
      }
    });

    assert.equal(
      await test.controller.runSourceEdit("Edit", [selection]),
      "failed"
    );
    const failed = test.state.sessions[0].messages[0].artifactEdits?.[0];
    assert.equal(failed?.status, "error");
    assert.equal(failed?.error, "sanitized:provider detail");
    assert.equal(test.leaseReleases, 1);
    assert.equal(test.savedStates.length, 1);
    assert.equal(test.refreshes, 1);
    assert.equal(test.selectionClears, 1);
  });
});
