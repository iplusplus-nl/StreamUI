import type { ArtifactSelection } from "../../core/artifactSelection";

export type ArtifactSelectionController = {
  getSelections(): ArtifactSelection[];
  changeSelections(selections: ArtifactSelection[]): void;
  clearSelections(): void;
  clearSelectionsForMessage(messageId: string): void;
};

export type ArtifactSelectionControllerPorts = {
  onSelectionsCleared(messageId?: string): void;
};

export function isArtifactSelectionTargetActive(
  activeSessionId: string,
  targetSessionId: string
): boolean {
  return Boolean(
    activeSessionId.trim() && activeSessionId === targetSessionId
  );
}

export function createArtifactSelectionController(
  ports: ArtifactSelectionControllerPorts
): ArtifactSelectionController {
  let selections: ArtifactSelection[] = [];

  return {
    getSelections() {
      return selections;
    },

    changeSelections(nextSelections) {
      selections = nextSelections;
    },

    clearSelections() {
      selections = [];
      ports.onSelectionsCleared();
    },

    clearSelectionsForMessage(messageId) {
      selections = selections.filter(
        (selection) => selection.messageId !== messageId
      );
      ports.onSelectionsCleared(messageId);
    }
  };
}
