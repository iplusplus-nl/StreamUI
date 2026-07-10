import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactSelection } from "../../core/artifactSelection";
import { createArtifactSelectionController } from "./artifactSelectionController";

function selection(key: string): ArtifactSelection {
  return {
    id: `selection-${key}`,
    messageId: "assistant-1",
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
