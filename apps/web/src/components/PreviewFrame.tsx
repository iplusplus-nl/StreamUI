import { useCallback, useEffect, useRef, useState } from "react";
import { isIgnoredRuntimeError } from "../core/ignoredRuntimeErrors";
import type { RenderError, RenderSnapshot } from "../core/types";

type PreviewFrameProps = {
  snapshot: RenderSnapshot;
  onRuntimeError(error: RenderError): void;
};

const STREAMING_COMMIT_INTERVAL_MS = 120;
const SCROLL_SETTLE_MS = 160;

function runBodyScripts(document: Document) {
  document.body.querySelectorAll("script").forEach((script) => {
    const executableScript = document.createElement("script");

    Array.from(script.attributes).forEach((attribute) => {
      executableScript.setAttribute(attribute.name, attribute.value);
    });

    executableScript.text = script.text;
    script.replaceWith(executableScript);
  });
}

export function PreviewFrame({ snapshot, onRuntimeError }: PreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const initialDocumentRef = useRef(snapshot.iframeDocument);
  const latestSnapshotRef = useRef(snapshot);
  const renderFrameRef = useRef<number | null>(null);
  const commitTimeoutRef = useRef<number | null>(null);
  const scrollSettleTimeoutRef = useRef<number | null>(null);
  const lastCommitTimeRef = useRef(0);
  const isParentScrollingRef = useRef(false);
  const renderedHtmlRef = useRef(snapshot.completedHtml);
  const completedHtmlRef = useRef(
    snapshot.status === "complete" ? snapshot.completedHtml : ""
  );
  const [height, setHeight] = useState(260);

  const commitSnapshot = useCallback((nextSnapshot: RenderSnapshot) => {
    const document = frameRef.current?.contentDocument;
    if (!document?.body) {
      return;
    }

    if (renderedHtmlRef.current === nextSnapshot.completedHtml) {
      return;
    }

    if (nextSnapshot.status === "complete") {
      if (completedHtmlRef.current === nextSnapshot.completedHtml) {
        return;
      }

      document.body.innerHTML = nextSnapshot.completedHtml;
      runBodyScripts(document);
      renderedHtmlRef.current = nextSnapshot.completedHtml;
      completedHtmlRef.current = nextSnapshot.completedHtml;
      lastCommitTimeRef.current = performance.now();
      return;
    }

    completedHtmlRef.current = "";
    document.body.innerHTML = nextSnapshot.completedHtml;
    renderedHtmlRef.current = nextSnapshot.completedHtml;
    lastCommitTimeRef.current = performance.now();
  }, []);

  const scheduleCommit = useCallback(() => {
    if (
      renderFrameRef.current !== null ||
      commitTimeoutRef.current !== null
    ) {
      return;
    }

    const nextSnapshot = latestSnapshotRef.current;
    if (
      nextSnapshot.status === "streaming" &&
      isParentScrollingRef.current
    ) {
      commitTimeoutRef.current = window.setTimeout(() => {
        commitTimeoutRef.current = null;
        scheduleCommit();
      }, SCROLL_SETTLE_MS);
      return;
    }

    const elapsed = performance.now() - lastCommitTimeRef.current;
    const delay =
      nextSnapshot.status === "streaming"
        ? Math.max(0, STREAMING_COMMIT_INTERVAL_MS - elapsed)
        : 0;

    commitTimeoutRef.current = window.setTimeout(() => {
      commitTimeoutRef.current = null;
      renderFrameRef.current = window.requestAnimationFrame(() => {
        renderFrameRef.current = null;
        commitSnapshot(latestSnapshotRef.current);
      });
    }, delay);
  }, [commitSnapshot]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }

      const data = event.data as {
        source?: string;
        kind?: RenderError["kind"] | "resize";
        message?: string;
        filename?: string;
        height?: number;
      };

      if (data?.source !== "streamui-runtime") {
        return;
      }

      if (data.kind === "resize" && typeof data.height === "number") {
        setHeight((currentHeight) => {
          const nextHeight = Math.max(180, Math.ceil(data.height ?? 0));
          if (latestSnapshotRef.current.status === "streaming") {
            return nextHeight > currentHeight + 1 ? nextHeight : currentHeight;
          }

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
  }, [onRuntimeError]);

  useEffect(() => {
    latestSnapshotRef.current = snapshot;
    scheduleCommit();
  }, [scheduleCommit, snapshot]);

  useEffect(() => {
    const scrollContainer = frameRef.current?.closest(".message-list");

    const handleScroll = () => {
      isParentScrollingRef.current = true;

      if (scrollSettleTimeoutRef.current !== null) {
        window.clearTimeout(scrollSettleTimeoutRef.current);
      }

      scrollSettleTimeoutRef.current = window.setTimeout(() => {
        scrollSettleTimeoutRef.current = null;
        isParentScrollingRef.current = false;
        scheduleCommit();
      }, SCROLL_SETTLE_MS);
    };

    scrollContainer?.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollContainer?.removeEventListener("scroll", handleScroll);
      if (renderFrameRef.current !== null) {
        window.cancelAnimationFrame(renderFrameRef.current);
      }
      if (commitTimeoutRef.current !== null) {
        window.clearTimeout(commitTimeoutRef.current);
      }
      if (scrollSettleTimeoutRef.current !== null) {
        window.clearTimeout(scrollSettleTimeoutRef.current);
      }
    };
  }, [scheduleCommit]);

  return (
    <iframe
      ref={frameRef}
      className="preview-frame"
      title="StreamUI artifact preview"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={initialDocumentRef.current}
      onLoad={() => commitSnapshot(latestSnapshotRef.current)}
      style={{ height }}
    />
  );
}
