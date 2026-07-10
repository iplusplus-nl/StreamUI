import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactSelection } from "../../core/artifactSelection";
import {
  createArtifactSelectionController,
  isArtifactSelectionTargetActive
} from "./artifactSelectionController";

function selection(
  key: string,
  messageId = "assistant-1"
): ArtifactSelection {
  return {
    id: `selection-${key}`,
    messageId,
    kind: "element",
    selector: `#${key}`,
    key,
    label: key,
    preview: key,
    createdAt: 1
  };
}

test("artifact selection controller preserves changes and notifies explicit clears", () => {
  let clearCount = 0;
  const controller = createArtifactSelectionController({
    onSelectionsCleared: () => {
      clearCount += 1;
    }
  });
  const selections = [selection("first"), selection("second")];

  assert.deepEqual(controller.getSelections(), []);
  controller.changeSelections(selections);
  assert.equal(controller.getSelections(), selections);
  assert.equal(clearCount, 0);

  controller.clearSelections();
  assert.deepEqual(controller.getSelections(), []);
  assert.notEqual(controller.getSelections(), selections);
  assert.equal(clearCount, 1);

  controller.clearSelections();
  assert.deepEqual(controller.getSelections(), []);
  assert.equal(clearCount, 2);
});

test("artifact selection controller clears only the requested message", () => {
  const clearTargets: Array<string | undefined> = [];
  const controller = createArtifactSelectionController({
    onSelectionsCleared: (messageId) => clearTargets.push(messageId)
  });
  const first = selection("first", "assistant-1");
  const second = selection("second", "assistant-2");
  controller.changeSelections([first, second]);

  controller.clearSelectionsForMessage("assistant-1");

  assert.deepEqual(controller.getSelections(), [second]);
  assert.deepEqual(clearTargets, ["assistant-1"]);
});

test("artifact selection target must still own the active session", () => {
  assert.equal(isArtifactSelectionTargetActive("session-a", "session-a"), true);
  assert.equal(isArtifactSelectionTargetActive("session-b", "session-a"), false);
  assert.equal(isArtifactSelectionTargetActive("", "session-a"), false);
});
