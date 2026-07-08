export const MAX_ARTIFACT_SELECTIONS = 8;

export type ArtifactSelectionKind = "element" | "text";

export type ArtifactSelectionPayload = {
  kind: ArtifactSelectionKind;
  key: string;
  selector: string;
  label: string;
  preview: string;
  tagName?: string;
  text?: string;
  html?: string;
};

export type ArtifactSelection = ArtifactSelectionPayload & {
  id: string;
  messageId: string;
  createdAt: number;
};
