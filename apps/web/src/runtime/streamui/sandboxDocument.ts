import type { PageThemeMode } from "./types";

const CSP = [
  "default-src 'none'",
  "img-src 'self' https: http://127.0.0.1:* http://localhost:* data: blob:",
  "style-src 'unsafe-inline' https:",
  "script-src 'unsafe-inline' https:",
  "font-src https: data:",
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
  "media-src 'self' https: http://127.0.0.1:* http://localhost:* data: blob:",
  "frame-src https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

const MATHJAX_SCRIPT_SRC = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js";

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

export function buildIframeBodyHtml(completedHtml: string): string {
  return `${completedHtml}
<style id="streamui-performance-guard">
  *, *::before, *::after {
    background-attachment: scroll !important;
  }
</style>`;
}

export function buildIframeDocument(
  completedHtml: string,
  themeMode: PageThemeMode = "night",
  actionsEnabled = true
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
      overflow: visible;
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
      cursor: pointer;
    }
    .streamui-button.secondary {
      border-color: var(--streamui-secondary-border);
      background: transparent;
      color: var(--streamui-secondary-text);
    }
    .streamui-button:disabled,
    .streamui-button[aria-disabled="true"],
    [data-streamui-prompt][aria-busy="true"],
    [data-streamui-copy][aria-busy="true"],
    [data-streamui-download][aria-busy="true"],
    [data-streamui-open-url][aria-busy="true"] {
      cursor: progress;
      opacity: 0.62;
    }
    body[data-streamui-actions-enabled="false"] [data-streamui-prompt],
    body[data-streamui-actions-enabled="false"] [data-streamui-copy],
    body[data-streamui-actions-enabled="false"] [data-streamui-copy-target],
    body[data-streamui-actions-enabled="false"] [data-streamui-download],
    body[data-streamui-actions-enabled="false"] [data-streamui-download-target],
    body[data-streamui-actions-enabled="false"] [data-streamui-open-url] {
      cursor: progress !important;
      opacity: 0.62;
    }
    body[data-streamui-actions-enabled="false"] *,
    body[data-streamui-actions-enabled="false"] *::before,
    body[data-streamui-actions-enabled="false"] *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
    body[data-streamui-selection-mode="true"] {
      cursor: crosshair;
    }
    .streamui-selection-hover,
    .streamui-selection-selected,
    .streamui-selection-busy {
      position: fixed;
      z-index: 2147483645;
      display: none;
      pointer-events: none;
      border-radius: 6px;
      box-shadow:
        inset 0 0 0 2px rgba(37, 99, 235, 0.96),
        0 0 0 1px rgba(255, 255, 255, 0.75);
      background: rgba(37, 99, 235, 0.08);
    }
    .streamui-selection-selected {
      z-index: 2147483644;
      box-shadow:
        inset 0 0 0 2px rgba(22, 163, 74, 0.96),
        0 0 0 1px rgba(255, 255, 255, 0.75);
      background: rgba(22, 163, 74, 0.1);
    }
    .streamui-selection-busy {
      z-index: 2147483643;
      overflow: hidden;
      border-radius: 8px;
      box-shadow:
        inset 0 0 0 2px rgba(37, 99, 235, 0.88),
        0 0 0 1px rgba(255, 255, 255, 0.82),
        0 14px 34px rgba(37, 99, 235, 0.18);
      background: rgba(37, 99, 235, 0.2);
      backdrop-filter: blur(3px) saturate(0.72);
    }
    .streamui-selection-busy::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.32), transparent 42%),
        repeating-linear-gradient(
          135deg,
          rgba(37, 99, 235, 0.24) 0,
          rgba(37, 99, 235, 0.24) 8px,
          rgba(147, 197, 253, 0.22) 8px,
          rgba(147, 197, 253, 0.22) 16px
        );
      opacity: 0.62;
      animation: streamui-selection-busy-sheen 980ms linear infinite;
    }
    .streamui-selection-busy::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 26px;
      height: 26px;
      margin-left: -13px;
      margin-top: -13px;
      border: 3px solid rgba(255, 255, 255, 0.72);
      border-top-color: #2563eb;
      border-radius: 999px;
      background: transparent;
      box-shadow: 0 8px 22px rgba(24, 24, 27, 0.24);
      animation: streamui-selection-busy-spin 780ms linear infinite;
    }
    .streamui-selection-busy .streamui-selection-label {
      display: none;
    }
    @keyframes streamui-selection-busy-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes streamui-selection-busy-sheen {
      from {
        background-position: 0 0, 0 0;
      }
      to {
        background-position: 0 0, 22px 22px;
      }
    }
    .streamui-selection-label {
      position: absolute;
      left: 0;
      bottom: calc(100% + 4px);
      max-width: min(320px, 90vw);
      overflow: hidden;
      padding: 3px 7px;
      border-radius: 6px;
      color: #ffffff;
      background: #2563eb;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 11px;
      font-weight: 720;
      line-height: 1.3;
      text-overflow: ellipsis;
      white-space: nowrap;
      box-shadow: 0 8px 22px rgba(24, 24, 27, 0.18);
    }
    .streamui-selection-selected .streamui-selection-label {
      background: #16a34a;
    }
    .streamui-text-selection-toolbar {
      position: fixed;
      z-index: 2147483647;
      display: none;
      align-items: center;
      gap: 5px;
      padding: 4px;
      border: 1px solid rgba(24, 24, 27, 0.12);
      border-radius: 8px;
      color: #18181b;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 12px 32px rgba(24, 24, 27, 0.18);
      pointer-events: auto;
    }
    .streamui-text-selection-preview {
      display: inline-flex;
      max-width: min(260px, 48vw);
      min-height: 26px;
      align-items: center;
      overflow: hidden;
      padding: 0 8px;
      border-radius: 6px;
      color: #3f3f46;
      background: #f4f4f5;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      font-weight: 620;
      line-height: 1;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .streamui-text-selection-toolbar button {
      min-height: 26px;
      padding: 0 8px;
      border: 0;
      border-radius: 6px;
      color: #18181b;
      background: transparent;
      cursor: pointer;
      font-size: 12px;
      font-weight: 680;
    }
    .streamui-text-selection-toolbar button[data-selection-kind="text"] {
      color: #ffffff;
      background: #18181b;
    }
    .streamui-text-selection-toolbar button[data-selection-kind="text"]:hover {
      background: #27272a;
    }
    .streamui-text-selection-toolbar button:hover {
      background: #f4f4f5;
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
      const MATHJAX_SCRIPT_SRC = "${MATHJAX_SCRIPT_SRC}";
      window.MathJax = {
        tex: {
          inlineMath: [["\\\\(", "\\\\)"]],
          displayMath: [["\\\\[", "\\\\]"], ["$$", "$$"]],
          processEscapes: true
        },
        options: {
          skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"]
        },
        startup: {
          typeset: false
        }
      };
      const MAX_CAPABILITY_TEXT_CHARS = 1000000;
      const pendingHostCapabilities = new Map();
      let hostCapabilitySequence = 0;
      const createHostCapabilityId = () =>
        "capability-" + Date.now().toString(36) + "-" + (++hostCapabilitySequence).toString(36);
      const postHostCapability = (actionType, payload = {}) => {
        const capabilityId = createHostCapabilityId();
        const request = new Promise((resolve, reject) => {
          pendingHostCapabilities.set(capabilityId, { resolve, reject });
        });
        post("action", actionType, {
          actionType,
          capabilityId,
          ...payload
        });
        return request;
      };
      let scheduledMeasureFrame = 0;
      let mathJaxScriptRequested = false;
      let mathJaxTypesetFrame = 0;
      let mathJaxTypesetting = false;
      let mathJaxTypesetAgain = false;
      const scheduleMeasure = () => {
        if (scheduledMeasureFrame) {
          return;
        }

        scheduledMeasureFrame = requestAnimationFrame(() => {
          scheduledMeasureFrame = 0;
          normalizeExternalLinks();
          measure();
        });
      };
      const bodyContainsMathDelimiters = () => {
        const text = document.body ? document.body.textContent || "" : "";
        return (
          text.includes("\\\\(") ||
          text.includes("\\\\[") ||
          text.includes("$$")
        );
      };
      const isPreviewComplete = () =>
        document.body?.dataset.streamuiActionsEnabled !== "false";
      const ensureMathJax = () => {
        const mathJax = window.MathJax;
        if (mathJax && typeof mathJax.typesetPromise === "function") {
          return true;
        }

        if (mathJaxScriptRequested || !bodyContainsMathDelimiters()) {
          return false;
        }

        mathJaxScriptRequested = true;
        const script = document.createElement("script");
        script.id = "streamui-mathjax";
        script.src = MATHJAX_SCRIPT_SRC;
        script.async = true;
        script.onload = () => scheduleMathTypeset();
        script.onerror = () => post("runtime", "MathJax could not be loaded.");
        document.head.appendChild(script);
        return false;
      };
      const scheduleMathTypeset = () => {
        if (!isPreviewComplete() || !bodyContainsMathDelimiters()) {
          return;
        }

        if (mathJaxTypesetFrame) {
          return;
        }

        mathJaxTypesetFrame = requestAnimationFrame(() => {
          mathJaxTypesetFrame = 0;
          if (!bodyContainsMathDelimiters()) {
            return;
          }

          if (!ensureMathJax()) {
            return;
          }

          const mathJax = window.MathJax;
          if (!mathJax || typeof mathJax.typesetPromise !== "function") {
            return;
          }

          if (mathJaxTypesetting) {
            mathJaxTypesetAgain = true;
            return;
          }

          mathJaxTypesetting = true;
          Promise.resolve(mathJax.typesetPromise([document.body]))
            .catch((error) => {
              const message =
                error && (error.message || error.toString)
                  ? error.message || error.toString()
                  : "MathJax typesetting failed.";
              post("runtime", message);
            })
            .finally(() => {
              mathJaxTypesetting = false;
              scheduleMeasure();
              if (mathJaxTypesetAgain) {
                mathJaxTypesetAgain = false;
                scheduleMathTypeset();
              }
            });
        });
      };
      window.streamuiTypesetMath = scheduleMathTypeset;
      window.addEventListener("message", (event) => {
        const data = event.data || {};
        if (data.source === "streamui-host" && data.kind === "measure") {
          scheduleMeasure();
          return;
        }

        if (
          data.source !== "streamui-host" ||
          data.kind !== "capability-result" ||
          typeof data.capabilityId !== "string"
        ) {
          return;
        }

        const pending = pendingHostCapabilities.get(data.capabilityId);
        if (!pending) {
          return;
        }

        pendingHostCapabilities.delete(data.capabilityId);
        if (data.ok) {
          pending.resolve();
        } else {
          pending.reject(new DOMException(
            String(data.message || "The host rejected this capability request."),
            "NotAllowedError"
          ));
        }
      });
      const bridgedClipboardWriteText = (text) => {
        return postHostCapability("copy", {
          label: "Clipboard write",
          text: String(text ?? "").slice(0, MAX_CAPABILITY_TEXT_CHARS)
        });
      };
      const installClipboardBridge = () => {
        try {
          if (navigator.clipboard) {
            Object.defineProperty(navigator.clipboard, "writeText", {
              configurable: true,
              value: bridgedClipboardWriteText
            });
            Object.defineProperty(navigator.clipboard, "readText", {
              configurable: true,
              value: () => Promise.reject(new DOMException(
                "Clipboard reads are not available inside ChatHTML artifacts.",
                "NotAllowedError"
              ))
            });
            return;
          }
        } catch {}

        try {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: bridgedClipboardWriteText,
              readText: () => Promise.reject(new DOMException(
                "Clipboard reads are not available inside ChatHTML artifacts.",
                "NotAllowedError"
              ))
            }
          });
        } catch {}
      };
      installClipboardBridge();
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
      const HEIGHT_SAFETY_PADDING = 28;
      const HEIGHT_EPSILON = 6;
      const SHRINK_SETTLE_MS = 700;
      const SMALL_SHRINK_PX = 12;
      let lastHeight = 0;
      let pendingShrinkHeight = 0;
      let pendingShrinkStartedAt = 0;
      let pendingShrinkTimer = 0;
      const hasPositionedAncestor = (element, body) => {
        let parent = element.parentElement;
        while (parent && parent !== body && parent !== document.documentElement) {
          if (getComputedStyle(parent).position !== "static") {
            return true;
          }
          parent = parent.parentElement;
        }

        return false;
      };
      const isViewportOverlay = (element, body, style) => {
        if (style.position === "fixed") {
          return true;
        }
        if (style.position !== "absolute") {
          return false;
        }

        return !hasPositionedAncestor(element, body);
      };
      const getLayoutBottom = (element, body) => {
        const bodyTop = body.getBoundingClientRect().top;
        const rect = element.getBoundingClientRect();
        return rect.bottom - bodyTop;
      };
      const measureContentHeight = () => {
        const body = document.body;
        if (!body) {
          return 32;
        }

        let maxBottom = body.firstElementChild
          ? 0
          : body.getBoundingClientRect().height;
        body.querySelectorAll("*").forEach((element) => {
          if (
            ["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META", "TITLE"].includes(
              element.tagName
            )
          ) {
            return;
          }

          const rect = element.getBoundingClientRect();
          if (!rect.width && !rect.height) {
            return;
          }

          const style = getComputedStyle(element);
          if (style.display === "none" || style.visibility === "collapse") {
            return;
          }
          if (isViewportOverlay(element, body, style)) {
            return;
          }

          const marginBottom = Number.parseFloat(style.marginBottom) || 0;
          maxBottom = Math.max(
            maxBottom,
            getLayoutBottom(element, body) + marginBottom
          );
        });

        const bodyStyle = getComputedStyle(body);
        const paddingBottom = Number.parseFloat(bodyStyle.paddingBottom) || 0;
        return Math.max(
          32,
          Math.ceil(maxBottom + paddingBottom + HEIGHT_SAFETY_PADDING)
        );
      };
      const clearPendingShrinkTimer = () => {
        if (pendingShrinkTimer) {
          window.clearTimeout(pendingShrinkTimer);
          pendingShrinkTimer = 0;
        }
      };
      const schedulePendingShrinkMeasure = () => {
        if (pendingShrinkTimer || !pendingShrinkStartedAt) {
          return;
        }

        const elapsed = performance.now() - pendingShrinkStartedAt;
        const delay = Math.max(0, SHRINK_SETTLE_MS - elapsed) + 20;
        pendingShrinkTimer = window.setTimeout(() => {
          pendingShrinkTimer = 0;
          measure();
        }, delay);
      };
      const shouldPostHeight = (height) => {
        if (!lastHeight) {
          return true;
        }
        if (height >= lastHeight || lastHeight - height <= SMALL_SHRINK_PX) {
          pendingShrinkHeight = 0;
          pendingShrinkStartedAt = 0;
          clearPendingShrinkTimer();
          return Math.abs(height - lastHeight) > HEIGHT_EPSILON;
        }

        const now = performance.now();
        if (
          !pendingShrinkHeight ||
          Math.abs(height - pendingShrinkHeight) > HEIGHT_EPSILON
        ) {
          pendingShrinkHeight = height;
          pendingShrinkStartedAt = now;
          clearPendingShrinkTimer();
          schedulePendingShrinkMeasure();
          return false;
        }

        if (now - pendingShrinkStartedAt < SHRINK_SETTLE_MS) {
          schedulePendingShrinkMeasure();
          return false;
        }

        clearPendingShrinkTimer();
        return true;
      };
      const measure = () => {
        const height = measureContentHeight();
        if (height && shouldPostHeight(height)) {
          lastHeight = height;
          pendingShrinkHeight = 0;
          pendingShrinkStartedAt = 0;
          clearPendingShrinkTimer();
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
      const MAX_ACTION_PROMPT_CHARS = 2000;
      const findPromptAction = (target) => {
        if (!(target instanceof Element)) {
          return null;
        }

        return target.closest("[data-streamui-prompt]");
      };
      const areHostActionsEnabled = () =>
        document.body?.dataset.streamuiActionsEnabled !== "false";
      const MAX_SELECTION_PREVIEW_CHARS = 360;
      const MAX_SELECTION_TEXT_CHARS = 2000;
      const MAX_SELECTION_HTML_CHARS = 12000;
      const selectionSkipTags = new Set([
        "HTML",
        "BODY",
        "HEAD",
        "SCRIPT",
        "STYLE",
        "TEMPLATE",
        "LINK",
        "META",
        "TITLE"
      ]);
      let selectionModeEnabled = false;
      let selectionHoverTarget = null;
      let selectedSelectionTargets = [];
      let busySelectionTargets = [];
      let hoverOverlay = null;
      let selectedOverlayLayer = null;
      let busyOverlayLayer = null;
      let textSelectionToolbar = null;
      let textSelectionRange = null;
      let textSelectionPayload = null;
      let textSelectionToolbarPointerDown = false;

      const compactSelectionText = (value) =>
        String(value || "").replace(/\\s+/g, " ").trim();
      const truncateSelectionText = (value, limit) =>
        compactSelectionText(value).slice(0, limit);
      const isSafeCssIdentifier = (value) =>
        /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(String(value || ""));
      const isInternalSelectionElement = (element) =>
        Boolean(
          element?.closest?.(
            ".streamui-selection-hover,.streamui-selection-selected,.streamui-selection-busy,.streamui-text-selection-toolbar"
          )
        );
      const OVERSIZED_SELECTION_EDGE_TOLERANCE = 32;
      const OVERSIZED_SELECTION_AREA_RATIO = 0.86;
      const coversIframeViewport = (rect) => {
        const viewportWidth = Math.max(
          1,
          document.documentElement?.clientWidth || window.innerWidth
        );
        const viewportHeight = Math.max(
          1,
          document.documentElement?.clientHeight || window.innerHeight
        );
        return (
          rect.left <= 1 &&
          rect.top <= 1 &&
          rect.width >= viewportWidth - 2 &&
          rect.height >= viewportHeight - 2
        );
      };
      const isOversizedSelectionTarget = (element) => {
        if (!(element instanceof Element)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const viewportWidth = Math.max(
          1,
          document.documentElement?.clientWidth || window.innerWidth
        );
        const viewportHeight = Math.max(
          1,
          document.documentElement?.clientHeight || window.innerHeight
        );
        const visibleLeft = Math.max(0, rect.left);
        const visibleTop = Math.max(0, rect.top);
        const visibleRight = Math.min(viewportWidth, rect.right);
        const visibleBottom = Math.min(viewportHeight, rect.bottom);
        const visibleWidth = Math.max(0, visibleRight - visibleLeft);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
        const visibleAreaRatio =
          (visibleWidth * visibleHeight) / (viewportWidth * viewportHeight);
        const nearlyFullWidth =
          rect.left <= OVERSIZED_SELECTION_EDGE_TOLERANCE &&
          rect.right >= viewportWidth - OVERSIZED_SELECTION_EDGE_TOLERANCE;
        const nearlyFullHeight =
          rect.top <= OVERSIZED_SELECTION_EDGE_TOLERANCE &&
          rect.bottom >= viewportHeight - OVERSIZED_SELECTION_EDGE_TOLERANCE;

        return (
          coversIframeViewport(rect) ||
          (nearlyFullWidth && nearlyFullHeight) ||
          (visibleAreaRatio >= OVERSIZED_SELECTION_AREA_RATIO &&
            visibleWidth >= viewportWidth * 0.75 &&
            visibleHeight >= viewportHeight * 0.75)
        );
      };
      const isElementVisibleForSelection = (element) => {
        if (!(element instanceof Element) || selectionSkipTags.has(element.tagName)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) {
          return false;
        }
        if (isOversizedSelectionTarget(element)) {
          return false;
        }

        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const findSelectableElement = (target) => {
        let element =
          target instanceof Element
            ? target
            : target?.parentElement instanceof Element
              ? target.parentElement
              : null;

        while (element && element !== document.body) {
          if (
            !isInternalSelectionElement(element) &&
            isElementVisibleForSelection(element)
          ) {
            return element;
          }
          element = element.parentElement;
        }

        return null;
      };
      const getNthOfType = (element) => {
        let index = 1;
        let sibling = element.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === element.tagName) {
            index += 1;
          }
          sibling = sibling.previousElementSibling;
        }
        return index;
      };
      const hasSameTagSibling = (element) => {
        const parent = element.parentElement;
        if (!parent) {
          return false;
        }

        return Array.from(parent.children).some(
          (child) => child !== element && child.tagName === element.tagName
        );
      };
      const getElementSelector = (element) => {
        if (!(element instanceof Element) || !document.body?.contains(element)) {
          return "";
        }

        const parts = [];
        let current = element;
        while (current && current !== document.body) {
          const tagName = current.tagName.toLowerCase();
          let part = tagName;
          const id = current.getAttribute("id") || "";

          if (id && isSafeCssIdentifier(id)) {
            part += "#" + id;
            return part;
          }

          const classNames = Array.from(current.classList || [])
            .filter(
              (className) =>
                isSafeCssIdentifier(className) &&
                !className.startsWith("streamui-selection")
            )
            .slice(0, 2);
          if (classNames.length) {
            part += "." + classNames.join(".");
          }
          if (!classNames.length || hasSameTagSibling(current)) {
            part += ":nth-of-type(" + getNthOfType(current) + ")";
          }
          parts.unshift(part);
          current = current.parentElement;
        }

        return parts.length ? "body > " + parts.join(" > ") : "";
      };
      const getElementLabel = (element) => {
        const tagName = element.tagName.toLowerCase();
        const id = element.getAttribute("id");
        const classNames = Array.from(element.classList || [])
          .filter(
            (className) =>
              !className.startsWith("streamui-selection") &&
              isSafeCssIdentifier(className)
          )
          .slice(0, 2);
        return (
          tagName +
          (id && isSafeCssIdentifier(id) ? "#" + id : "") +
            (classNames.length ? "." + classNames.join(".") : "")
        );
      };
      const textHiddenTags = new Set([
        "SCRIPT",
        "STYLE",
        "TEMPLATE",
        "NOSCRIPT"
      ]);
      const isElementHiddenForSelectionText = (element, root) => {
        let current = element;
        while (current && current instanceof Element && current !== root.parentElement) {
          if (
            textHiddenTags.has(current.tagName) ||
            current.getAttribute("aria-hidden") === "true" ||
            isInternalSelectionElement(current)
          ) {
            return true;
          }

          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse"
          ) {
            return true;
          }

          if (current === root) {
            break;
          }
          current = current.parentElement;
        }

        return false;
      };
      const normalizeCssGeneratedText = (value) => {
        const content = String(value || "").trim();
        if (!content || content === "none" || content === "normal") {
          return "";
        }

        return content
          .replace(/^["']|["']$/g, "")
          .replace(/\\\\A/g, " ")
          .replace(/\\\\0000a/gi, " ");
      };
      const isDomLikeSelectionLabel = (value) =>
        /^[a-z][a-z0-9-]*(?:[#.:\[][^\s]*)?$/i.test(compactSelectionText(value));
      const getSelectionPreviewFromHtml = (html) => {
        if (!html) {
          return "";
        }

        const template = document.createElement("template");
        template.innerHTML = String(html || "");
        template.content
          .querySelectorAll("script,style,template,noscript,[aria-hidden='true']")
          .forEach((node) => node.remove());

        const root = template.content.firstElementChild;
        if (!root) {
          return truncateSelectionText(
            template.content.textContent,
            MAX_SELECTION_PREVIEW_CHARS
          );
        }

        const controlValue =
          "value" in root && typeof root.value === "string" ? root.value : "";
        const text =
          controlValue ||
          root.getAttribute("aria-label") ||
          root.getAttribute("title") ||
          root.textContent ||
          "";
        return truncateSelectionText(text, MAX_SELECTION_PREVIEW_CHARS);
      };
      const getPseudoElementText = (element) =>
        compactSelectionText(
          normalizeCssGeneratedText(getComputedStyle(element, "::before").content) +
            " " +
            normalizeCssGeneratedText(getComputedStyle(element, "::after").content)
        );
      const getVisibleElementText = (element) => {
        if (!(element instanceof Element)) {
          return "";
        }

        const parts = [];
        const pushText = (value) => {
          const text = compactSelectionText(value);
          if (!text) {
            return;
          }
          parts.push(text);
        };

        pushText(getPseudoElementText(element));

        const elementWalker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_ELEMENT,
          {
            acceptNode(node) {
              return node instanceof Element &&
                !isElementHiddenForSelectionText(node, element)
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
            }
          }
        );
        let elementNode = elementWalker.nextNode();
        while (elementNode) {
          pushText(getPseudoElementText(elementNode));
          elementNode = elementWalker.nextNode();
        }

        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode(node) {
              const text = compactSelectionText(node.nodeValue);
              const parent = node.parentElement;
              if (!text || !parent) {
                return NodeFilter.FILTER_REJECT;
              }

              return isElementHiddenForSelectionText(parent, element)
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
            }
          }
        );

        let node = walker.nextNode();
        while (node) {
          pushText(node.nodeValue);
          if (parts.join(" ").length >= MAX_SELECTION_PREVIEW_CHARS) {
            break;
          }
          node = walker.nextNode();
        }

        if (!parts.length && typeof element.textContent === "string") {
          pushText(element.textContent);
        }

        return truncateSelectionText(parts.join(" "), MAX_SELECTION_PREVIEW_CHARS);
      };
      const getElementPreview = (element) => {
        if ("value" in element && typeof element.value === "string") {
          return truncateSelectionText(element.value, MAX_SELECTION_PREVIEW_CHARS);
        }

        const visibleText = getVisibleElementText(element);
        const htmlText = getSelectionPreviewFromHtml(element.outerHTML || "");
        const accessibleText =
          visibleText ||
          htmlText ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.getAttribute("alt") ||
          element.textContent ||
          element.getAttribute("src") ||
          "";
        return truncateSelectionText(accessibleText, MAX_SELECTION_PREVIEW_CHARS);
      };
      const getElementDisplayLabel = (element) => {
        const preview = getElementPreview(element);
        if (preview && !isDomLikeSelectionLabel(preview)) {
          return preview;
        }

        return (
          getSelectionPreviewFromHtml(element.outerHTML || "") ||
          preview ||
          getElementLabel(element)
        );
      };
      const getSelectionTargetLabel = (target, element) => {
        const preview = truncateSelectionText(
          target?.preview || target?.label || "",
          120
        );
        if (preview) {
          return preview;
        }

        return getElementDisplayLabel(element);
      };
      const resolveSelectedTarget = (target) => {
        if (!target || typeof target.selector !== "string") {
          return null;
        }

        try {
          const element = document.querySelector(target.selector);
          if (element) {
            return element;
          }

          const legacyIdSelector = /^body\s*>\s*([a-z][a-z0-9-]*#[a-zA-Z_-][a-zA-Z0-9_-]*)$/i.exec(
            target.selector
          );
          return legacyIdSelector ? document.querySelector(legacyIdSelector[1]) : null;
        } catch {
          return null;
        }
      };
      const createSelectionOverlay = (className) => {
        if (!document.body) {
          return null;
        }

        const overlay = document.createElement("div");
        overlay.className = className;
        const label = document.createElement("span");
        label.className = "streamui-selection-label";
        overlay.appendChild(label);
        document.body.appendChild(overlay);
        return overlay;
      };
      const placeSelectionOverlay = (overlay, element, labelText) => {
        if (!overlay || !(element instanceof Element)) {
          return;
        }

        const rect = element.getBoundingClientRect();
        if (
          rect.width < 1 ||
          rect.height < 1 ||
          rect.bottom < 0 ||
          rect.right < 0 ||
          rect.top > window.innerHeight ||
          rect.left > window.innerWidth
        ) {
          overlay.style.display = "none";
          return;
        }

        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        overlay.style.display = "block";
        overlay.style.left = left + "px";
        overlay.style.top = top + "px";
        overlay.style.width =
          Math.max(1, Math.min(rect.width, window.innerWidth - left)) + "px";
        overlay.style.height =
          Math.max(1, Math.min(rect.height, window.innerHeight - top)) + "px";
        const label = overlay.querySelector(".streamui-selection-label");
        if (label) {
          label.textContent = labelText || getElementLabel(element);
        }
      };
      const hideSelectionHover = () => {
        selectionHoverTarget = null;
        if (hoverOverlay) {
          hoverOverlay.style.display = "none";
        }
      };
      const updateSelectionHover = (element) => {
        if (!selectionModeEnabled || !element) {
          hideSelectionHover();
          return;
        }

        selectionHoverTarget = element;
        if (!hoverOverlay) {
          hoverOverlay = createSelectionOverlay("streamui-selection-hover");
        }
        placeSelectionOverlay(
          hoverOverlay,
          element,
          getElementDisplayLabel(element)
        );
      };
      const renderSelectedSelectionTargets = () => {
        if (!document.body) {
          return;
        }

        if (!selectedOverlayLayer) {
          selectedOverlayLayer = document.createElement("div");
          selectedOverlayLayer.setAttribute("aria-hidden", "true");
          document.body.appendChild(selectedOverlayLayer);
        }

        selectedOverlayLayer.replaceChildren();
        selectedSelectionTargets.forEach((target) => {
          const element = resolveSelectedTarget(target);
          if (!element || isOversizedSelectionTarget(element)) {
            return;
          }

          const overlay = createSelectionOverlay("streamui-selection-selected");
          if (!overlay) {
            return;
          }
          selectedOverlayLayer.appendChild(overlay);
          placeSelectionOverlay(
            overlay,
            element,
            getSelectionTargetLabel(target, element)
          );
        });
      };
      const renderBusySelectionTargets = () => {
        if (!document.body) {
          return;
        }

        if (!busyOverlayLayer) {
          busyOverlayLayer = document.createElement("div");
          busyOverlayLayer.setAttribute("aria-hidden", "true");
          document.body.appendChild(busyOverlayLayer);
        }

        busyOverlayLayer.replaceChildren();
        busySelectionTargets.forEach((target) => {
          const element = resolveSelectedTarget(target);
          if (!element || isOversizedSelectionTarget(element)) {
            return;
          }

          const overlay = createSelectionOverlay("streamui-selection-busy");
          if (!overlay) {
            return;
          }
          busyOverlayLayer.appendChild(overlay);
          placeSelectionOverlay(overlay, element, "Editing");
        });
      };
      const createSelectionPayload = (kind, element, selectedText = "") => {
        if (!(element instanceof Element) || isOversizedSelectionTarget(element)) {
          return null;
        }

        const selector = getElementSelector(element);
        if (!selector) {
          return null;
        }

        const normalizedText = truncateSelectionText(
          selectedText,
          MAX_SELECTION_TEXT_CHARS
        );
        const preview =
          kind === "text"
            ? normalizedText
            : getElementPreview(element);
        const key =
          kind +
          ":" +
          selector +
          (kind === "text" ? ":" + normalizedText.slice(0, 160) : "");
        const payload = {
          kind,
          key,
          selector,
          label:
            kind === "text"
              ? "Text in " + getElementLabel(element)
              : getElementLabel(element),
          preview: preview || getElementLabel(element),
          tagName: element.tagName.toLowerCase(),
          html: String(element.outerHTML || "").slice(0, MAX_SELECTION_HTML_CHARS)
        };

        if (normalizedText) {
          payload.text = normalizedText;
        }

        return payload;
      };
      const postSelectionPayload = (payload) => {
        if (!payload || !areHostActionsEnabled()) {
          return;
        }

        post("selection", "selection", { selection: payload });
      };
      const setSelectionModeEnabled = (enabled) => {
        selectionModeEnabled = Boolean(enabled) && areHostActionsEnabled();
        if (document.body) {
          document.body.dataset.streamuiSelectionMode = selectionModeEnabled
            ? "true"
            : "false";
        }
        if (!selectionModeEnabled) {
          hideSelectionHover();
        }
      };
      const exitSelectionMode = () => {
        setSelectionModeEnabled(false);
        post("selection-mode-change", "selection-mode-change", {
          enabled: false
        });
      };
      const hideTextSelectionToolbar = () => {
        textSelectionRange = null;
        textSelectionPayload = null;
        if (textSelectionToolbar) {
          textSelectionToolbar.style.display = "none";
        }
      };
      const hasActiveTextSelection = () => {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
          return Boolean(truncateSelectionText(selection.toString(), 80));
        }
        return Boolean(
          textSelectionPayload &&
            textSelectionToolbar &&
            textSelectionToolbar.style.display !== "none"
        );
      };
      const ensureTextSelectionToolbar = () => {
        if (textSelectionToolbar) {
          return textSelectionToolbar;
        }
        if (!document.body) {
          return null;
        }

        textSelectionToolbar = document.createElement("div");
        textSelectionToolbar.className = "streamui-text-selection-toolbar";
        textSelectionToolbar.setAttribute("role", "toolbar");
        textSelectionToolbar.setAttribute("aria-label", "Preview selection");
        textSelectionToolbar.innerHTML =
          '<span class="streamui-text-selection-preview"></span>' +
          '<button type="button" data-selection-kind="text">Reference</button>';
        const holdTextSelectionForToolbarClick = () => {
          textSelectionToolbarPointerDown = true;
          window.setTimeout(() => {
            textSelectionToolbarPointerDown = false;
          }, 600);
        };
        textSelectionToolbar.addEventListener("pointerdown", (event) => {
          holdTextSelectionForToolbarClick();
          event.preventDefault();
          event.stopPropagation();
        });
        textSelectionToolbar.addEventListener("mousedown", (event) => {
          holdTextSelectionForToolbarClick();
          event.preventDefault();
          event.stopPropagation();
        });
        textSelectionToolbar.addEventListener("click", (event) => {
          const button = event.target?.closest?.("[data-selection-kind]");
          if (!button) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          const kind = button.getAttribute("data-selection-kind") || "text";
          let payload = null;
          if (textSelectionRange) {
            const commonNode = textSelectionRange.commonAncestorContainer;
            const owner = findSelectableElement(commonNode);
            const selectedText = textSelectionRange.toString();
            if (owner) {
              payload = createSelectionPayload(kind, owner, selectedText);
            }
          }
          if (!payload && kind === "text") {
            payload = textSelectionPayload;
          }
          postSelectionPayload(payload);
          window.getSelection()?.removeAllRanges();
          textSelectionToolbarPointerDown = false;
          hideTextSelectionToolbar();
        });
        document.body.appendChild(textSelectionToolbar);
        return textSelectionToolbar;
      };
      const updateTextSelectionToolbar = () => {
        if (!areHostActionsEnabled()) {
          hideTextSelectionToolbar();
          return;
        }

        const selection = window.getSelection();
        if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
          if (textSelectionToolbarPointerDown && textSelectionPayload) {
            return;
          }
          hideTextSelectionToolbar();
          return;
        }

        const selectedText = truncateSelectionText(
          selection.toString(),
          MAX_SELECTION_TEXT_CHARS
        );
        if (!selectedText) {
          if (textSelectionToolbarPointerDown && textSelectionPayload) {
            return;
          }
          hideTextSelectionToolbar();
          return;
        }

        const range = selection.getRangeAt(0).cloneRange();
        if (!document.body?.contains(range.commonAncestorContainer)) {
          if (textSelectionToolbarPointerDown && textSelectionPayload) {
            return;
          }
          hideTextSelectionToolbar();
          return;
        }
        const owner = findSelectableElement(range.commonAncestorContainer);
        const payload = owner
          ? createSelectionPayload("text", owner, selectedText)
          : null;
        if (!payload) {
          if (textSelectionToolbarPointerDown && textSelectionPayload) {
            return;
          }
          hideTextSelectionToolbar();
          return;
        }

        const rect =
          Array.from(range.getClientRects()).find(
            (item) => item.width > 0 && item.height > 0
          ) || range.getBoundingClientRect();
        if (!rect || (rect.width < 1 && rect.height < 1)) {
          hideTextSelectionToolbar();
          return;
        }

        const toolbar = ensureTextSelectionToolbar();
        if (!toolbar) {
          return;
        }

        textSelectionRange = range;
        textSelectionPayload = payload;
        textSelectionToolbarPointerDown = false;
        const preview = toolbar.querySelector(".streamui-text-selection-preview");
        if (preview) {
          preview.textContent = selectedText;
        }
        toolbar.style.display = "flex";
        const toolbarRect = toolbar.getBoundingClientRect();
        const left = Math.min(
          Math.max(8, rect.right - toolbarRect.width),
          Math.max(8, window.innerWidth - toolbarRect.width - 8)
        );
        const top =
          rect.top - toolbarRect.height - 8 >= 8
            ? rect.top - toolbarRect.height - 8
            : Math.min(rect.bottom + 8, window.innerHeight - toolbarRect.height - 8);
        toolbar.style.left = left + "px";
        toolbar.style.top = Math.max(8, top) + "px";
      };
      window.addEventListener("message", (event) => {
        const data = event.data || {};
        if (data.source === "streamui-host" && data.kind === "selection-mode") {
          setSelectionModeEnabled(Boolean(data.enabled));
          renderSelectedSelectionTargets();
          return;
        }

        if (data.source === "streamui-host" && data.kind === "selection-targets") {
          selectedSelectionTargets = Array.isArray(data.targets)
            ? data.targets
                .filter(
                  (target) =>
                    target &&
                    typeof target.selector === "string" &&
                    (target.kind === "element" || target.kind === "text")
                )
                .slice(0, 16)
            : [];
          renderSelectedSelectionTargets();
          return;
        }

        if (data.source === "streamui-host" && data.kind === "selection-busy-targets") {
          busySelectionTargets = Array.isArray(data.targets)
            ? data.targets
                .filter(
                  (target) =>
                    target &&
                    typeof target.selector === "string" &&
                    (target.kind === "element" || target.kind === "text")
                )
                .slice(0, 16)
            : [];
          renderBusySelectionTargets();
        }
      });
      const findCapabilityAction = (target) => {
        if (!(target instanceof Element)) {
          return null;
        }

        return target.closest(
          "[data-streamui-copy],[data-streamui-copy-target],[data-streamui-download],[data-streamui-download-target],[data-streamui-open-url]"
        );
      };
      const findTargetText = (selector) => {
        if (!selector) {
          return "";
        }

        try {
          const target = document.querySelector(selector);
          if (!target) {
            return "";
          }
          if ("value" in target && typeof target.value === "string") {
            return target.value;
          }
          return target.textContent || "";
        } catch {
          return "";
        }
      };
      const getCapabilityLabel = (element) => {
        return (
          element.getAttribute("data-streamui-label") ||
          element.textContent ||
          ""
        ).trim().slice(0, 200);
      };
      const getCapabilityText = (element, attributeName, targetAttributeName) => {
        const direct = element.getAttribute(attributeName);
        const targetText = findTargetText(element.getAttribute(targetAttributeName));
        return String(targetText || direct || "")
          .slice(0, MAX_CAPABILITY_TEXT_CHARS);
      };
      const postCapabilityAction = (trigger) => {
        const label = getCapabilityLabel(trigger);

        if (
          trigger.hasAttribute("data-streamui-copy") ||
          trigger.hasAttribute("data-streamui-copy-target")
        ) {
          post("action", "copy", {
            actionType: "copy",
            label,
            text: getCapabilityText(
              trigger,
              "data-streamui-copy",
              "data-streamui-copy-target"
            )
          });
          return true;
        }

        if (
          trigger.hasAttribute("data-streamui-download") ||
          trigger.hasAttribute("data-streamui-download-target")
        ) {
          post("action", "download", {
            actionType: "download",
            filename: trigger.getAttribute("data-streamui-filename") || "",
            label,
            mimeType: trigger.getAttribute("data-streamui-mime-type") || "",
            text: getCapabilityText(
              trigger,
              "data-streamui-download",
              "data-streamui-download-target"
            )
          });
          return true;
        }

        if (trigger.hasAttribute("data-streamui-open-url")) {
          post("action", "open-url", {
            actionType: "open-url",
            label,
            url: String(trigger.getAttribute("data-streamui-open-url") || "")
              .trim()
              .slice(0, 2000)
          });
          return true;
        }

        return false;
      };
      const isActionDisabled = (element) => {
        return (
          element.getAttribute("aria-disabled") === "true" ||
          element.getAttribute("disabled") !== null ||
          Boolean(element.disabled)
        );
      };
      const markActionPending = (element) => {
        const pendingText = element.getAttribute("data-streamui-pending");
        element.setAttribute("aria-busy", "true");
        element.setAttribute("aria-disabled", "true");
        if ("disabled" in element) {
          try {
            element.disabled = true;
          } catch {}
        }
        if (pendingText && typeof element.textContent === "string") {
          element.textContent = pendingText;
        }
      };
      document.addEventListener("pointermove", (event) => {
        if (!selectionModeEnabled) {
          return;
        }

        updateSelectionHover(findSelectableElement(event.target));
      }, true);
      document.addEventListener("pointerleave", () => {
        hideSelectionHover();
      }, true);
      document.addEventListener("selectionchange", () => {
        requestAnimationFrame(updateTextSelectionToolbar);
      });
      document.addEventListener("keyup", () => {
        requestAnimationFrame(updateTextSelectionToolbar);
      });
      document.addEventListener("mouseup", () => {
        requestAnimationFrame(updateTextSelectionToolbar);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          hideTextSelectionToolbar();
          if (selectionModeEnabled) {
            exitSelectionMode();
          }
        }
      }, true);
      document.addEventListener("click", (event) => {
        if (!selectionModeEnabled) {
          return;
        }
        if (isInternalSelectionElement(event.target)) {
          return;
        }

        const element = findSelectableElement(event.target);
        if (!element) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          exitSelectionMode();
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const payload = createSelectionPayload("element", element);
        if (!payload) {
          return;
        }

        postSelectionPayload(payload);
        setSelectionModeEnabled(false);
        post("selection-mode-change", "selection-mode-change", {
          enabled: false
        });
      }, true);
      document.addEventListener("click", (event) => {
        const capabilityTrigger = findCapabilityAction(event.target);
        if (capabilityTrigger) {
          if (!areHostActionsEnabled()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          if (isActionDisabled(capabilityTrigger)) {
            return;
          }

          event.preventDefault();
          postCapabilityAction(capabilityTrigger);
          return;
        }

        const trigger = findPromptAction(event.target);
        if (!trigger) {
          return;
        }

        if (!areHostActionsEnabled()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        const label = (
          trigger.getAttribute("data-streamui-label") ||
          trigger.textContent ||
          ""
        ).trim();
        const prompt = (
          trigger.getAttribute("data-streamui-prompt") ||
          label
        ).trim().slice(0, MAX_ACTION_PROMPT_CHARS);

        if (!prompt || isActionDisabled(trigger)) {
          return;
        }

        event.preventDefault();
        markActionPending(trigger);
        post("action", prompt, {
          actionType: "prompt",
          prompt,
          label: label.slice(0, 200)
        });
      }, true);
      window.addEventListener("error", (event) => {
        if (isExtensionNoise(event.message, event.filename)) {
          return;
        }
        const detail =
          event.error && (event.error.stack || event.error.message)
            ? String(event.error.stack || event.error.message)
            : "";
        const message =
          detail && (!event.message || event.message === "Script error.")
            ? detail
            : event.message;
        post("runtime", message, { filename: event.filename || "" });
      });
      window.addEventListener("unhandledrejection", (event) => {
        const reason =
          event.reason && (event.reason.stack || event.reason.message)
            ? event.reason.stack || event.reason.message
            : event.reason;
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
      const refreshSelectionUi = () => {
        if (selectionHoverTarget) {
          updateSelectionHover(selectionHoverTarget);
        }
        renderSelectedSelectionTargets();
        renderBusySelectionTargets();
        updateTextSelectionToolbar();
      };
      const scheduleSelectionUiRefresh = () => {
        requestAnimationFrame(refreshSelectionUi);
      };
      window.addEventListener("load", scheduleMeasure);
      window.addEventListener("resize", scheduleMeasure);
      window.addEventListener("load", scheduleMathTypeset);
      window.addEventListener("load", scheduleSelectionUiRefresh);
      window.addEventListener("resize", scheduleSelectionUiRefresh);
      document.addEventListener("scroll", scheduleSelectionUiRefresh, true);
      document.addEventListener("toggle", scheduleMeasure, true);
      document.addEventListener("transitionend", scheduleMeasure, true);
      document.addEventListener("animationend", scheduleMeasure, true);
      document.addEventListener("transitionend", scheduleSelectionUiRefresh, true);
      document.addEventListener("animationend", scheduleSelectionUiRefresh, true);
      const resizeObserver = new ResizeObserver(scheduleMeasure);
      const observeBody = () => {
        if (document.body) {
          resizeObserver.observe(document.body);
        }
      };
      resizeObserver.observe(document.documentElement);
      observeBody();
      window.addEventListener("load", observeBody);
      new MutationObserver(() => {
        scheduleMathTypeset();
        scheduleMeasure();
      }).observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
      });
      scheduleMathTypeset();
      scheduleMeasure();
    })();
  </script>
</head>
<body data-streamui-actions-enabled="${actionsEnabled ? "true" : "false"}">
${buildIframeBodyHtml(completedHtml)}
</body>
</html>`;
}
