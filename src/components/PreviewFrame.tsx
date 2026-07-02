import { useEffect, useRef } from "react";
import { useState } from "react";
import type { RenderError, RenderSnapshot } from "../core/types";

type PreviewFrameProps = {
  snapshot: RenderSnapshot;
  onRuntimeError(error: RenderError): void;
};

export function PreviewFrame({ snapshot, onRuntimeError }: PreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(260);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }

      const data = event.data as {
        source?: string;
        kind?: RenderError["kind"] | "resize";
        message?: string;
        height?: number;
      };

      if (data?.source !== "streamui-runtime") {
        return;
      }

      if (data.kind === "resize" && typeof data.height === "number") {
        setHeight(Math.max(180, Math.ceil(data.height)));
        return;
      }

      onRuntimeError({
        kind: data.kind === "console" ? "console" : "runtime",
        message: data.message || "Unknown iframe runtime event.",
        timestamp: Date.now()
      });
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onRuntimeError]);

  return (
    <iframe
      ref={frameRef}
      className="preview-frame"
      title="StreamUI artifact preview"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      srcDoc={snapshot.iframeDocument}
      style={{ height }}
    />
  );
}
