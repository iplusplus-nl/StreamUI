import { useCallback, useEffect, useRef, useState } from "react";
import {
  copyTextToClipboard,
  downloadTextFile
} from "../core/artifactExport";
import { isIgnoredRuntimeError } from "../core/ignoredRuntimeErrors";
import type { ArtifactSelectionPayload } from "../core/artifactSelection";
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
  selectionModeActive?: boolean;
  selectedSelections?: PreviewSelectionTarget[];
  onRuntimeError(error: RenderError): void;
  onArtifactAction(action: StreamUiAction): void;
  onArtifactSelection?(selection: ArtifactSelectionPayload): void;
  onSelectionModeChange?(enabled: boolean): void;
};

type CapabilityAction =
  | Extract<StreamUiAction, { type: "copy" }>
  | Extract<StreamUiAction, { type: "download" }>
  | Extract<StreamUiAction, { type: "open-url" }>;

type CapabilityStatus = {
  kind: "success" | "error";
  message: string;
};

type PreviewSelectionTarget = Pick<
  ArtifactSelectionPayload,
  "key" | "kind" | "selector"
>;

const MAX_CAPABILITY_TEXT_CHARS = 1_000_000;
const MAX_SELECTION_KEY_CHARS = 700;
const MAX_SELECTION_SELECTOR_CHARS = 1200;
const MAX_SELECTION_LABEL_CHARS = 220;
const MAX_SELECTION_PREVIEW_CHARS = 420;
const MAX_SELECTION_TEXT_CHARS = 2200;
const MAX_SELECTION_HTML_CHARS = 12500;
const MIN_PREVIEW_HEIGHT = 32;
const HEIGHT_EPSILON = 6;
const SMALL_SHRINK_PX = 12;
const SHRINK_SETTLE_MS = 700;

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

function normalizeSelectionString(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeArtifactSelectionPayload(
  value: unknown
): ArtifactSelectionPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Record<string, unknown>;
  const kind = input.kind === "text" ? "text" : input.kind === "element" ? "element" : null;
  const key = normalizeSelectionString(input.key, MAX_SELECTION_KEY_CHARS);
  const selector = normalizeSelectionString(
    input.selector,
    MAX_SELECTION_SELECTOR_CHARS
  );
  if (!kind || !key || !selector) {
    return null;
  }

  const label =
    normalizeSelectionString(input.label, MAX_SELECTION_LABEL_CHARS) ||
    (kind === "text" ? "Selected text" : "Selected element");
  const preview =
    normalizeSelectionString(input.preview, MAX_SELECTION_PREVIEW_CHARS) ||
    label;
  const tagName = normalizeSelectionString(input.tagName, 80).toLowerCase();
  const text = normalizeSelectionString(input.text, MAX_SELECTION_TEXT_CHARS);
  const html = String(input.html ?? "").slice(0, MAX_SELECTION_HTML_CHARS);

  return {
    kind,
    key,
    selector,
    label,
    preview,
    ...(tagName ? { tagName } : {}),
    ...(text ? { text } : {}),
    ...(html ? { html } : {})
  };
}

export function PreviewFrame({
  snapshot,
  themeMode,
  selectionModeActive = false,
  selectedSelections = [],
  onRuntimeError,
  onArtifactAction,
  onArtifactSelection,
  onSelectionModeChange
}: PreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialSrcDocRef = useRef<string | null>(null);
  const lastLoadedFullDocumentRef = useRef("");
  const lastAppliedBodyHtmlRef = useRef("");
  const pendingShrinkRef = useRef<{ height: number; startedAt: number } | null>(
    null
  );
  const [height, setHeight] = useState(96);
  const [capabilityAction, setCapabilityAction] =
    useState<CapabilityAction | null>(null);
  const [capabilityStatus, setCapabilityStatus] =
    useState<CapabilityStatus | null>(null);
  const artifactActionsEnabled = snapshot.status === "complete";

  if (initialSrcDocRef.current === null) {
    initialSrcDocRef.current = buildIframeDocument("", themeMode, false);
  }

  const applyMeasuredHeight = useCallback((value: number) => {
    const nextHeight = Math.max(MIN_PREVIEW_HEIGHT, Math.ceil(value));
    const now = performance.now();
    setHeight((currentHeight) => {
      if (
        nextHeight >= currentHeight ||
        currentHeight - nextHeight <= SMALL_SHRINK_PX
      ) {
        pendingShrinkRef.current = null;
        return Math.abs(nextHeight - currentHeight) > HEIGHT_EPSILON
          ? nextHeight
          : currentHeight;
      }

      const pending = pendingShrinkRef.current;
      if (
        !pending ||
        Math.abs(pending.height - nextHeight) > HEIGHT_EPSILON
      ) {
        pendingShrinkRef.current = {
          height: nextHeight,
          startedAt: now
        };
        return currentHeight;
      }

      if (now - pending.startedAt < SHRINK_SETTLE_MS) {
        return currentHeight;
      }

      pendingShrinkRef.current = null;
      return Math.abs(nextHeight - currentHeight) > HEIGHT_EPSILON
        ? nextHeight
        : currentHeight;
    });
  }, []);

  const requestFrameMeasure = useCallback(() => {
    window.requestAnimationFrame(() => {
      frameRef.current?.contentWindow?.postMessage(
        {
          source: "streamui-host",
          kind: "measure"
        },
        "*"
      );
    });
  }, []);

  const postSelectionState = useCallback(() => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) {
      return;
    }

    frameWindow.postMessage(
      {
        source: "streamui-host",
        kind: "selection-mode",
        enabled: Boolean(selectionModeActive && artifactActionsEnabled)
      },
      "*"
    );
    frameWindow.postMessage(
      {
        source: "streamui-host",
        kind: "selection-targets",
        targets: selectedSelections.map((selection) => ({
          key: selection.key,
          kind: selection.kind,
          selector: selection.selector
        }))
      },
      "*"
    );
  }, [artifactActionsEnabled, selectedSelections, selectionModeActive]);

  const applySnapshotToFrame = useCallback(() => {
    const frame = frameRef.current;
    const document = frame?.contentDocument;
    if (!frame || !document?.body) {
      return;
    }

    if (snapshot.status === "complete") {
      const fullDocument = buildIframeDocument(
        snapshot.completedHtml,
        themeMode,
        true
      );
      if (lastLoadedFullDocumentRef.current !== fullDocument) {
        lastLoadedFullDocumentRef.current = fullDocument;
        lastAppliedBodyHtmlRef.current = "";
        frame.srcdoc = fullDocument;
        return;
      }

      requestFrameMeasure();
      return;
    }

    lastLoadedFullDocumentRef.current = "";
    applyIframeTheme(document, themeMode);
    document.body.dataset.streamuiActionsEnabled = "false";

    const bodyHtml = buildIframeBodyHtml(snapshot.completedHtml);
    if (lastAppliedBodyHtmlRef.current !== bodyHtml) {
      document.body.innerHTML = bodyHtml;
      document.body.dataset.streamuiActionsEnabled = "false";
      lastAppliedBodyHtmlRef.current = bodyHtml;
    }

    requestFrameMeasure();
  }, [requestFrameMeasure, snapshot.completedHtml, snapshot.status, themeMode]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }

      const data = event.data as {
        source?: string;
        kind?:
          | RenderError["kind"]
          | "resize"
          | "action"
          | "selection"
          | "selection-mode-change";
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
        enabled?: boolean;
        selection?: unknown;
      };

      if (data?.source !== "streamui-runtime") {
        return;
      }

      if (data.kind === "action" && !artifactActionsEnabled) {
        return;
      }

      if (data.kind === "selection-mode-change") {
        onSelectionModeChange?.(Boolean(data.enabled));
        return;
      }

      if (data.kind === "selection") {
        if (!artifactActionsEnabled) {
          return;
        }

        const selection = normalizeArtifactSelectionPayload(data.selection);
        if (selection) {
          onArtifactSelection?.(selection);
        }
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
        applyMeasuredHeight(data.height);
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
  }, [
    applyMeasuredHeight,
    artifactActionsEnabled,
    onArtifactAction,
    onArtifactSelection,
    onSelectionModeChange,
    onRuntimeError
  ]);

  useEffect(() => {
    applySnapshotToFrame();
  }, [applySnapshotToFrame]);

  useEffect(() => {
    postSelectionState();
  }, [postSelectionState]);

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
          postSelectionState();
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
