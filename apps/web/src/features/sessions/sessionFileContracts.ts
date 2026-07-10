import type { SessionFile } from "../../domain/chat/sessionModel";

export type SessionFileUploadInput = {
  kind: SessionFile["kind"];
  name: string;
  mimeType: string;
  dataUrl?: string;
  text?: string;
  width?: number;
  height?: number;
  sourceMessageId?: string;
  summary?: string;
  draft?: boolean;
};
