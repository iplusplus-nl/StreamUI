import { buildIframeDocument } from "./buildIframeDocument";
import { completePartialHtml } from "./completePartialHtml";
import type {
  PageThemeMode,
  RenderError,
  RenderSnapshot,
  RenderStatus,
  StreamingRenderer
} from "./types";

const SECURITY_RULES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\b(localStorage|sessionStorage)\b/i,
    message: "Browser storage APIs are not allowed in StreamUI artifacts."
  },
  {
    pattern: /\bdocument\s*\.\s*cookie\b/i,
    message: "Cookie access is not allowed in StreamUI artifacts."
  },
  {
    pattern: /\bdocument\s*\.\s*write\s*\(/i,
    message: "document.write is not allowed in StreamUI artifacts."
  },
  {
    pattern: /\b(?:window\s*\.\s*)?(?:parent|top|opener)\s*\./i,
    message: "Access to parent, top, or opener windows is not allowed."
  },
  {
    pattern: /\bnavigator\s*\.\s*(geolocation|mediaDevices|clipboard)\b/i,
    message: "Browser permission APIs are not allowed in StreamUI artifacts."
  }
];

function makeSnapshot(
  raw: string,
  errors: RenderError[],
  status: RenderStatus,
  themeMode: PageThemeMode
): RenderSnapshot {
  const completedHtml = completePartialHtml(raw, {
    allowScripts: status === "complete",
    allowPartialStyles: status === "complete"
  });

  return {
    raw,
    completedHtml,
    iframeDocument: buildIframeDocument(completedHtml, themeMode),
    errors: [...errors],
    status
  };
}

export function createStreamingRenderer(
  themeMode: PageThemeMode = "night"
): StreamingRenderer {
  let raw = "";
  let status: RenderStatus = "idle";
  let errors: RenderError[] = [];
  let snapshot = makeSnapshot(raw, errors, status, themeMode);
  const seenErrors = new Set<string>();
  const snapshotCallbacks = new Set<(snapshot: RenderSnapshot) => void>();
  const errorCallbacks = new Set<(error: RenderError) => void>();

  const emitSnapshot = () => {
    snapshotCallbacks.forEach((callback) => callback(snapshot));
  };

  const addError = (kind: RenderError["kind"], message: string) => {
    const key = `${kind}:${message}`;
    if (seenErrors.has(key)) {
      return;
    }

    seenErrors.add(key);
    const error = { kind, message, timestamp: Date.now() };
    errors = [...errors, error];
    errorCallbacks.forEach((callback) => callback(error));
  };

  const inspectSecurity = () => {
    for (const rule of SECURITY_RULES) {
      if (rule.pattern.test(raw)) {
        addError("security", rule.message);
      }
    }
  };

  const refresh = () => {
    try {
      inspectSecurity();
      snapshot = makeSnapshot(raw, errors, status, themeMode);
    } catch (error) {
      status = "error";
      addError(
        "html",
        error instanceof Error ? error.message : "Could not complete streamed HTML."
      );
      snapshot = {
        raw,
        completedHtml: "",
        iframeDocument: buildIframeDocument("", themeMode),
        errors: [...errors],
        status
      };
    }
    emitSnapshot();
  };

  return {
    feed(chunk: string) {
      raw += chunk;
      status = "streaming";
      refresh();
    },
    complete() {
      status = "complete";
      refresh();
    },
    getSnapshot() {
      return snapshot;
    },
    reset() {
      raw = "";
      status = "idle";
      errors = [];
      seenErrors.clear();
      snapshot = makeSnapshot(raw, errors, status, themeMode);
      emitSnapshot();
    },
    onSnapshot(callback) {
      snapshotCallbacks.add(callback);
      callback(snapshot);
      return () => {
        snapshotCallbacks.delete(callback);
      };
    },
    onError(callback) {
      errorCallbacks.add(callback);
      return () => {
        errorCallbacks.delete(callback);
      };
    }
  };
}
