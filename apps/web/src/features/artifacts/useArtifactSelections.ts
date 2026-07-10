import { useMemo, useState } from "react";
import {
  createArtifactSelectionController,
  type ArtifactSelectionController
} from "./artifactSelectionController";

export type ArtifactSelections = ArtifactSelectionController & {
  selectionClearVersion: number;
};

export function useArtifactSelections(): ArtifactSelections {
  const [selectionClearVersion, setSelectionClearVersion] = useState(0);
  const controller = useMemo(
    () =>
      createArtifactSelectionController({
        onSelectionsCleared: () => {
          setSelectionClearVersion((version) => version + 1);
        }
      }),
    []
  );

  return {
    ...controller,
    selectionClearVersion
  };
}
