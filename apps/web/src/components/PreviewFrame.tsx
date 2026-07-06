import { useCallback, useEffect, useRef, useState } from "react";
import {
  copyTextToClipboard,
  downloadTextFile
} from "../core/artifactExport";
import { isIgnoredRuntimeError } from "../core/ignoredRuntimeErrors";
import {
  applyIframeTheme,
  buildIframeBodyHtml,
  buildIframeDocument
} from "../runtime/streamui/sandboxDocument";
import type {
  PageThemeMode,
  RenderError,
  RenderSnapshot,
  StreamUiAction
} from "../runtime/streamui/types";

type PreviewFrameProps = {
  snapshot: RenderSnapshot;
  themeMode: PageThemeMode;
  onRuntimeError(error: RenderError): void;
  onArtifactAction(action: StreamUiAction): void;
};

type CapabilityAction =
  | Extract<StreamUiAction, { type: "copy" }>
  | Extract<StreamUiAction, { type: "download" }>
  | Extract<StreamUiAction, { type: "open-url" }>;

type CapabilityStatus = {
  kind: "success" | "error";
  message: string;
};

const MAX_CAPABILITY_TEXT_CHARS = 1_000_000;

function normalizeCapabilityText(value: unknown): string {
  return String(value ?? "").slice(0, MAX_CAPABILITY_TEXT_CHARS);
}

function normalizeCapabilityLabel(value: unknown): string | undefined {
  const label = String(value ?? "").trim().slice(0, 200);
  return label || undefined;
}

function sanitizeDownloadFilename(value: unknown): string {
  const filename = String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return filename || "chathtml-export.txt";
}

function sanitizeMimeType(value: unknown): string {
  const mimeType = String(value ?? "").trim().slice(0, 120);
  return mimeType || "text/plain;charset=utf-8";
}

function normalizeOpenUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("No URL was provided.");
  }

  const url = new URL(raw, window.location.href);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https URLs can be opened.");
  }

  return url.href;
}

function getCapabilityTitle(action: CapabilityAction): string {
  if (action.type === "copy") {
    return "Copy from artifact";
  }
  if (action.type === "download") {
    return "Download from artifact";
  }
  return "Open link from artifact";
}

function getCapabilityConfirmLabel(action: CapabilityAction): string {
  if (action.type === "copy") {
    return "Copy";
  }
  if (action.type === "download") {
    return "Download";
  }
  return "Open";
}

function getCapabilityPreview(action: CapabilityAction): string {
  if (action.type === "open-url") {
    return action.url;
  }

  return action.text;
}

export function PreviewFrame({
  snapshot,
  themeMode,
  onRuntimeError,
  onArtifactAction
}: PreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialSrcDocRef = useRef<string | null>(null);
  const lastLoadedFullDocumentRef = useRef("");
  const lastAppliedBodyHtmlRef = useRef("");
  const [height, setHeight] = useState(96);
  const [capabilityAction, setCapabilityAction] =
    useState<CapabilityAction | null>(null);
  const [capabilityStatus, setCapabilityStatus] =
    useState<CapabilityStatus | null>(null);

  if (initialSrcDocRef.current === null) {
    initialSrcDocRef.current = buildIframeDocument("", themeMode);
  }

  const measureFrameHeight = useCallback((document: Document) => {
    window.requestAnimationFrame(() => {
      const nextHeight = Math.max(32, Math.ceil(document.body.scrollHeight));
      setHeight((currentHeight) =>
        Math.abs(nextHeight - currentHeight) > 1 ? nextHeight : currentHeight
      );
    });
  }, []);

  const applySnapshotToFrame = useCallback(() => {
    const frame = frameRef.current;
    const document = frame?.contentDocument;
    if (!frame || !document?.body) {
      return;
    }

    if (snapshot.status === "complete") {
      const fullDocument = buildIframeDocument(snapshot.completedHtml, themeMode);
      if (lastLoadedFullDocumentRef.current !== fullDocument) {
        lastLoadedFullDocumentRef.current = fullDocument;
        lastAppliedBodyHtmlRef.current = "";
        frame.srcdoc = fullDocument;
        return;
      }

      measureFrameHeight(document);
      return;
    }

    lastLoadedFullDocumentRef.current = "";
    applyIframeTheme(document, themeMode);

    const bodyHtml = buildIframeBodyHtml(snapshot.completedHtml);
    if (lastAppliedBodyHtmlRef.current !== bodyHtml) {
      document.body.innerHTML = bodyHtml;
      lastAppliedBodyHtmlRef.current = bodyHtml;
    }

    measureFrameHeight(document);
  }, [measureFrameHeight, snapshot.completedHtml, snapshot.status, themeMode]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }

      const data = event.data as {
        source?: string;
        kind?: RenderError["kind"] | "resize" | "action";
        actionType?: string;
        prompt?: string;
        capabilityId?: string;
        label?: string;
        text?: string;
        url?: string;
        filename?: string;
        mimeType?: string;
        message?: string;
        height?: number;
      };

      if (data?.source !== "streamui-runtime") {
        return;
      }

      if (data.kind === "action" && data.actionType === "prompt") {
        const prompt = String(data.prompt || data.message || "").trim();
        const label = String(data.label || "").trim();
        if (prompt) {
          onArtifactAction({
            type: "prompt",
            prompt: prompt.slice(0, 2000),
            ...(label ? { label: label.slice(0, 200) } : {})
          });
        }
        return;
      }

      if (data.kind === "action" && data.actionType === "copy") {
        setCapabilityStatus(null);
        setCapabilityAction({
          type: "copy",
          ...(typeof data.capabilityId === "string" && data.capabilityId
            ? { capabilityId: data.capabilityId }
            : {}),
          text: normalizeCapabilityText(data.text),
          ...(normalizeCapabilityLabel(data.label)
            ? { label: normalizeCapabilityLabel(data.label) }
            : {})
        });
        return;
      }

      if (data.kind === "action" && data.actionType === "download") {
        setCapabilityStatus(null);
        setCapabilityAction({
          type: "download",
          ...(typeof data.capabilityId === "string" && data.capabilityId
            ? { capabilityId: data.capabilityId }
            : {}),
          text: normalizeCapabilityText(data.text),
          filename: sanitizeDownloadFilename(data.filename),
          mimeType: sanitizeMimeType(data.mimeType),
          ...(normalizeCapabilityLabel(data.label)
            ? { label: normalizeCapabilityLabel(data.label) }
            : {})
        });
        return;
      }

      if (data.kind === "action" && data.actionType === "open-url") {
        try {
          setCapabilityStatus(null);
          setCapabilityAction({
            type: "open-url",
            ...(typeof data.capabilityId === "string" && data.capabilityId
              ? { capabilityId: data.capabilityId }
              : {}),
            url: normalizeOpenUrl(data.url),
            ...(normalizeCapabilityLabel(data.label)
              ? { label: normalizeCapabilityLabel(data.label) }
              : {})
          });
        } catch (error) {
          setCapabilityStatus({
            kind: "error",
            message: error instanceof Error ? error.message : "Invalid URL."
          });
        }
        return;
      }

      if (data.kind === "resize" && typeof data.height === "number") {
        setHeight((currentHeight) => {
          const nextHeight = Math.max(32, Math.ceil(data.height ?? 0));

          return Math.abs(nextHeight - currentHeight) > 1
            ? nextHeight
            : currentHeight;
        });
        return;
      }

      const kind: RenderError["kind"] =
        data.kind === "console" ? "console" : "runtime";
      const runtimeError = {
        kind,
        message: data.message || "Unknown iframe runtime event.",
        filename: data.filename,
        timestamp: Date.now()
      };

      if (isIgnoredRuntimeError(runtimeError)) {
        return;
      }

      onRuntimeError(runtimeError);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onArtifactAction, onRuntimeError]);

  useEffect(() => {
    applySnapshotToFrame();
  }, [applySnapshotToFrame]);

  const sendCapabilityResult = useCallback(
    (action: CapabilityAction, ok: boolean, message = "") => {
      if (!action.capabilityId) {
        return;
      }

      frameRef.current?.contentWindow?.postMessage(
        {
          source: "streamui-host",
          kind: "capability-result",
          capabilityId: action.capabilityId,
          ok,
          message
        },
        "*"
      );
    },
    []
  );

  useEffect(() => {
    if (!capabilityStatus || capabilityStatus.kind === "error") {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setCapabilityStatus(null);
    }, 2_200);

    return () => window.clearTimeout(timeoutId);
  }, [capabilityStatus]);

  const runCapabilityAction = async () => {
    if (!capabilityAction) {
      return;
    }

    try {
      if (capabilityAction.type === "copy") {
        if (!capabilityAction.text) {
          throw new Error("Nothing to copy.");
        }
        await copyTextToClipboard(capabilityAction.text);
        setCapabilityStatus({ kind: "success", message: "Copied" });
        sendCapabilityResult(capabilityAction, true);
      } else if (capabilityAction.type === "download") {
        if (!capabilityAction.text) {
          throw new Error("Nothing to download.");
        }
        downloadTextFile(
          capabilityAction.text,
          capabilityAction.filename || "chathtml-export.txt",
          capabilityAction.mimeType
        );
        setCapabilityStatus({ kind: "success", message: "Download started" });
        sendCapabilityResult(capabilityAction, true);
      } else {
        const opened = window.open(
          capabilityAction.url,
          "_blank",
          "noopener,noreferrer"
        );
        if (!opened) {
          throw new Error("The browser blocked this popup.");
        }
        opened.opener = null;
        setCapabilityStatus({ kind: "success", message: "Opened" });
        sendCapabilityResult(capabilityAction, true);
      }
      setCapabilityAction(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Artifact action failed.";
      sendCapabilityResult(capabilityAction, false, message);
      setCapabilityStatus({
        kind: "error",
        message
      });
    }
  };

  const cancelCapabilityAction = () => {
    if (capabilityAction) {
      sendCapabilityResult(capabilityAction, false, "The user cancelled this action.");
    }
    setCapabilityAction(null);
  };

  return (
    <>
      <iframe
        ref={frameRef}
        className="preview-frame"
        title="ChatHTML artifact preview"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={initialSrcDocRef.current}
        onLoad={() => {
          applySnapshotToFrame();
        }}
        style={{ height }}
      />
      {capabilityAction ? (
        <div className="artifact-capability-panel" role="dialog" aria-modal="false">
          <strong>{getCapabilityTitle(capabilityAction)}</strong>
          {capabilityAction.label ? <span>{capabilityAction.label}</span> : null}
          <code>{getCapabilityPreview(capabilityAction)}</code>
          <div className="artifact-capability-actions">
            <button
              className="artifact-capability-secondary"
              type="button"
              onClick={cancelCapabilityAction}
            >
              Cancel
            </button>
            <button
              className="artifact-capability-primary"
              type="button"
              onClick={() => {
                void runCapabilityAction();
              }}
            >
              {getCapabilityConfirmLabel(capabilityAction)}
            </button>
          </div>
        </div>
      ) : null}
      {capabilityStatus ? (
        <div
          className={`artifact-capability-status is-${capabilityStatus.kind}`}
          role={capabilityStatus.kind === "error" ? "alert" : "status"}
        >
          {capabilityStatus.message}
        </div>
      ) : null}
    </>
  );
}
