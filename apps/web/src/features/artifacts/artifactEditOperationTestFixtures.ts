import type {
  ArtifactEdit,
  ArtifactEditReference,
  ClientMessage
} from "../../domain/chat/sessionModel";

export const originalRaw =
  "<chat>Original</chat><streamui><main>Original artifact</main></streamui>";
export const editedRaw =
  "<chat>Edited</chat><streamui><main>Edited artifact</main></streamui>";
export const regeneratedRaw =
  "<chat>Regenerated</chat><streamui><main>Regenerated artifact</main></streamui>";
export const reference: ArtifactEditReference = {
  kind: "element",
  key: "hero",
  selector: "#hero",
  label: "Hero",
  preview: "Hero preview"
};

export function completeEdit(
  id: string,
  rawStream: string,
  parentId?: string
): ArtifactEdit {
  return {
    id,
    parentId,
    createdAt: 1,
    prompt: `Edit ${id}`,
    references: [],
    activeVariantId: `${id}-variant`,
    variants: [
      {
        id: `${id}-variant`,
        createdAt: 1,
        status: "complete",
        rawStream
      }
    ],
    status: "complete"
  };
}

export function assistant(
  overrides: Partial<ClientMessage> = {}
): ClientMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Edited",
    rawStream: editedRaw,
    artifactEditBaseRawStream: originalRaw,
    artifactEdits: [completeEdit("edit-1", editedRaw)],
    activeArtifactEditId: "edit-1",
    status: "complete",
    ...overrides
  };
}
