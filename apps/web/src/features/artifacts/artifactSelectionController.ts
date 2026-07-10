import type { ArtifactSelection } from "../../core/artifactSelection";

export type ArtifactSelectionController = {
  getSelections(): ArtifactSelection[];
  changeSelections(selections: ArtifactSelection[]): void;
  clearSelections(): void;
};

export type ArtifactSelectionControllerPorts = {
  onSelectionsCleared(): void;
};

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
    }
  };
}
