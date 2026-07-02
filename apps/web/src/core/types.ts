export type RenderStatus = "idle" | "streaming" | "complete" | "error";

export type RenderErrorKind = "html" | "runtime" | "security" | "console";

export type RenderError = {
  kind: RenderErrorKind;
  message: string;
  timestamp: number;
};

export type RenderSnapshot = {
  raw: string;
  completedHtml: string;
  iframeDocument: string;
  errors: RenderError[];
  status: RenderStatus;
};

export type StreamingRenderer = {
  feed(chunk: string): void;
  complete(): void;
  getSnapshot(): RenderSnapshot;
  reset(): void;
  onSnapshot(callback: (snapshot: RenderSnapshot) => void): () => void;
  onError(callback: (error: RenderError) => void): () => void;
};

export type ExtractedStreamUiParts = {
  chat: string;
  streamui: string;
  hasChat: boolean;
  hasStreamUi: boolean;
  streamUiComplete: boolean;
  fallbackText: string;
};
