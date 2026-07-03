import type { PageThemeMode } from "./types";

const CSP = [
  "default-src 'none'",
  "img-src https: data: blob:",
  "style-src 'unsafe-inline' https:",
  "script-src 'unsafe-inline' https:",
  "font-src https: data:",
  "connect-src https:",
  "media-src https: data: blob:",
  "frame-src https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

type IframeThemeTokens = {
  mode: PageThemeMode;
  colorScheme: "light" | "dark";
  pageBg: string;
  text: string;
  muted: string;
  link: string;
  buttonBg: string;
  buttonText: string;
  secondaryBorder: string;
  secondaryText: string;
};

export function getIframeThemeTokens(themeMode: PageThemeMode): IframeThemeTokens {
  if (themeMode === "day") {
    return {
      mode: "day",
      colorScheme: "light",
      pageBg: "#ffffff",
      text: "#18181b",
      muted: "#71717a",
      link: "#18181b",
      buttonBg: "#18181b",
      buttonText: "#ffffff",
      secondaryBorder: "#d4d4d8",
      secondaryText: "#3f3f46"
    };
  }

  return {
    mode: "night",
    colorScheme: "dark",
    pageBg: "#050505",
    text: "#f4f4f5",
    muted: "#a1a1aa",
    link: "#ffffff",
    buttonBg: "#f4f4f5",
    buttonText: "#18181b",
    secondaryBorder: "rgba(255, 255, 255, 0.18)",
    secondaryText: "#e4e4e7"
  };
}

export function applyIframeTheme(document: Document, themeMode: PageThemeMode): void {
  const theme = getIframeThemeTokens(themeMode);
  const root = document.documentElement;

  root.dataset.pageTheme = theme.mode;
  root.style.setProperty("color-scheme", theme.colorScheme);
  root.style.setProperty("--streamui-page-bg", theme.pageBg);
  root.style.setProperty("--streamui-text", theme.text);
  root.style.setProperty("--streamui-muted", theme.muted);
  root.style.setProperty("--streamui-link", theme.link);
  root.style.setProperty("--streamui-button-bg", theme.buttonBg);
  root.style.setProperty("--streamui-button-text", theme.buttonText);
  root.style.setProperty("--streamui-secondary-border", theme.secondaryBorder);
  root.style.setProperty("--streamui-secondary-text", theme.secondaryText);
}

export function buildIframeDocument(
  completedHtml: string,
  themeMode: PageThemeMode = "night"
): string {
  const theme = getIframeThemeTokens(themeMode);

  return `<!doctype html>
<html lang="en" data-page-theme="${theme.mode}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <style>
    :root {
      color-scheme: ${theme.colorScheme};
      --streamui-page-bg: ${theme.pageBg};
      --streamui-text: ${theme.text};
      --streamui-muted: ${theme.muted};
      --streamui-link: ${theme.link};
      --streamui-button-bg: ${theme.buttonBg};
      --streamui-button-text: ${theme.buttonText};
      --streamui-secondary-border: ${theme.secondaryBorder};
      --streamui-secondary-text: ${theme.secondaryText};
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; min-height: 0; background: transparent; }
    body {
      width: 100%;
      overflow: hidden;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--streamui-text);
      background: transparent;
    }
    button, input, select, textarea { font: inherit; }
    .streamui-response {
      width: min(900px, 100%);
      color: var(--streamui-text);
    }
    .streamui-chat {
      width: min(760px, 100%);
      max-width: 100%;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--streamui-text);
      box-shadow: none;
      font-size: 15px;
      line-height: 1.65;
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
      margin-top: 10px;
    }
    .streamui-chat ul,
    .streamui-chat ol {
      padding-left: 20px;
    }
    .streamui-chat li + li {
      margin-top: 5px;
    }
    .streamui-chat a,
    .streamui-link {
      color: var(--streamui-link);
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    .streamui-muted {
      color: var(--streamui-muted);
    }
    .streamui-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .streamui-button {
      border: 1px solid var(--streamui-button-bg);
      border-radius: 999px;
      padding: 7px 12px;
      background: var(--streamui-button-bg);
      color: var(--streamui-button-text);
      font-size: 13px;
      font-weight: 620;
    }
    .streamui-button.secondary {
      border-color: var(--streamui-secondary-border);
      background: transparent;
      color: var(--streamui-secondary-text);
    }
    .streamui-resource {
      margin-top: 12px;
    }
    .streamui-resource img,
    .streamui-resource video,
    .streamui-resource iframe {
      display: block;
      max-width: 100%;
      border: 0;
      border-radius: 6px;
    }
    .streamui-resource figcaption,
    .streamui-sources {
      margin-top: 6px;
      color: var(--streamui-muted);
      font-size: 0.88rem;
      line-height: 1.45;
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
      const isExtensionNoise = (message = "", filename = "") => {
        const text = String(message || "").toLowerCase();
        const file = String(filename || "").toLowerCase();
        const extensionSource =
          file.includes("zotero") ||
          file.includes("safari-web-extension:") ||
          file.includes("moz-extension:") ||
          file.includes("chrome-extension:") ||
          file.includes("extension://");
        const basename = file.split(/[\\\\/]/).pop() || file;
        const injectedScript =
          basename === "inject.js" || basename === "inject_safari.js";

        if (text.includes("zotero") || text.includes("reportactiveurl")) {
          return true;
        }
        if (extensionSource) {
          return true;
        }
        if (
          injectedScript &&
          (text.includes("sandbox access violation") ||
            text.includes("zotero.connector"))
        ) {
          return true;
        }

        return false;
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
      const normalizeExternalLinks = () => {
        document.querySelectorAll("a[href]").forEach((anchor) => {
          const href = anchor.getAttribute("href") || "";
          if (/^https?:\\/\\//i.test(href)) {
            anchor.setAttribute("target", "_blank");
            anchor.setAttribute("rel", "noopener noreferrer");
          }
        });
      };
      const scheduleMeasure = () => requestAnimationFrame(() => {
        normalizeExternalLinks();
        measure();
      });
      window.addEventListener("error", (event) => {
        if (isExtensionNoise(event.message, event.filename)) {
          return;
        }
        post("runtime", event.message, { filename: event.filename || "" });
      });
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason && event.reason.message ? event.reason.message : event.reason;
        if (isExtensionNoise(reason || "")) {
          return;
        }
        post("runtime", reason || "Unhandled promise rejection");
      });
      const originalError = console.error;
      console.error = (...args) => {
        const message = args.map(String).join(" ");
        if (!isExtensionNoise(message)) {
          post("console", message);
        }
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
<style id="streamui-performance-guard">
  *, *::before, *::after {
    background-attachment: scroll !important;
  }
</style>
</body>
</html>`;
}
