export type UploadedSessionFile = {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  sourceMessageId?: string;
  storageKey?: string;
  contentHash?: string;
  accessToken?: string;
  embedUrl?: string;
  downloadUrl?: string;
  draft?: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  summary?: string;
};

export type ImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  width?: number;
  height?: number;
  sessionFile?: UploadedSessionFile;
  ownerSessionId?: string;
};

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
] as const;

export const MAX_IMAGE_ATTACHMENTS = 4;
