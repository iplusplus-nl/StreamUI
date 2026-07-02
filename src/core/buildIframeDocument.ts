const CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "font-src data:",
  "connect-src 'none'",
  "media-src data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

export function buildIframeDocument(completedHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; min-height: 0; background: transparent; }
    body {
      width: 100%;
      overflow: hidden;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #172033;
      background: transparent;
    }
    button, input, select, textarea { font: inherit; }
    .streamui-response {
      width: min(760px, 100%);
      color: #1f2937;
    }
    .streamui-chat {
      width: fit-content;
      max-width: 100%;
      padding: 12px 14px;
      border: 1px solid #e1e7ef;
      border-radius: 8px;
      background: #ffffff;
      color: #1f2937;
      box-shadow: 0 8px 24px rgba(26, 37, 61, 0.07);
    }
    .streamui-chat p,
    .streamui-chat ul,
    .streamui-chat ol {
      margin: 0;
    }
    .streamui-chat p + p,
    .streamui-chat p + ul,
    .streamui-chat p + ol,
    .streamui-chat ul + p,
    .streamui-chat ol + p {
      margin-top: 8px;
    }
    .streamui-chat ul,
    .streamui-chat ol {
      padding-left: 20px;
    }
    .streamui-chat li + li {
      margin-top: 4px;
    }
    .streamui-muted {
      color: #667085;
    }
    .streamui-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .streamui-button {
      border: 0;
      border-radius: 8px;
      padding: 9px 12px;
      background: #1d4ed8;
      color: #ffffff;
      font-weight: 650;
    }
    .streamui-button.secondary {
      border: 1px solid #cdd8e7;
      background: #f8fafc;
      color: #27415f;
    }
  </style>
  <script>
    (() => {
      const post = (kind, message, extra = {}) => {
        try {
          window.parent.postMessage({
            source: "streamui-runtime",
            kind,
            message: String(message || "Unknown runtime event"),
            ...extra
          }, "*");
        } catch {}
      };
      let lastHeight = 0;
      const measure = () => {
        const body = document.body;
        const html = document.documentElement;
        const height = Math.ceil(Math.max(
          body?.scrollHeight || 0,
          body?.offsetHeight || 0,
          html?.scrollHeight || 0,
          html?.offsetHeight || 0
        ));
        if (height && Math.abs(height - lastHeight) > 1) {
          lastHeight = height;
          post("resize", "resize", { height });
        }
      };
      const scheduleMeasure = () => requestAnimationFrame(measure);
      window.addEventListener("error", (event) => {
        post("runtime", event.message);
      });
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason && event.reason.message ? event.reason.message : event.reason;
        post("runtime", reason || "Unhandled promise rejection");
      });
      const originalError = console.error;
      console.error = (...args) => {
        post("console", args.map(String).join(" "));
        originalError.apply(console, args);
      };
      window.addEventListener("load", scheduleMeasure);
      window.addEventListener("resize", scheduleMeasure);
      new ResizeObserver(scheduleMeasure).observe(document.documentElement);
      new MutationObserver(scheduleMeasure).observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
      });
      scheduleMeasure();
    })();
  </script>
</head>
<body>
${completedHtml}
</body>
</html>`;
}
