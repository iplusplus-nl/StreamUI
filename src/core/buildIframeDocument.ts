const CSP = [
  "default-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline' https:",
  "script-src 'unsafe-inline' https:",
  "font-src data: https:",
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
