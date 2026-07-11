import type { IframeThemeTokens } from "./sandboxDocument";

export function buildSandboxStyles(theme: IframeThemeTokens): string {
  return `    :root {
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
    :root[data-page-theme="day"] {
      --streamui-edit-fill: rgba(51, 156, 255, 0.1);
      --streamui-edit-fill-selected: rgba(51, 156, 255, 0.16);
      --streamui-edit-fill-busy: rgba(51, 156, 255, 0.14);
      --streamui-edit-outline: #339CFF;
      --streamui-edit-outline-outer: rgba(24, 24, 27, 0.2);
      --streamui-edit-shadow: rgba(51, 156, 255, 0.2);
      --streamui-edit-sheen: rgba(255, 255, 255, 0.88);
      --streamui-edit-sheen-soft: rgba(51, 156, 255, 0.28);
    }
    :root[data-page-theme="night"] {
      --streamui-edit-fill: rgba(51, 156, 255, 0.14);
      --streamui-edit-fill-selected: rgba(51, 156, 255, 0.2);
      --streamui-edit-fill-busy: rgba(51, 156, 255, 0.18);
      --streamui-edit-outline: #339CFF;
      --streamui-edit-outline-outer: rgba(255, 255, 255, 0.14);
      --streamui-edit-shadow: rgba(51, 156, 255, 0.24);
      --streamui-edit-sheen: rgba(255, 255, 255, 0.8);
      --streamui-edit-sheen-soft: rgba(51, 156, 255, 0.32);
    }
    .streamui-selection-hover,
    .streamui-selection-selected,
    .streamui-selection-busy {
      position: fixed;
      z-index: 2147483645;
      display: none;
      pointer-events: none;
      border-radius: 8px;
      box-shadow:
        inset 0 0 0 2px var(--streamui-edit-outline),
        0 0 0 1px var(--streamui-edit-outline-outer),
        0 8px 24px var(--streamui-edit-shadow);
      background: var(--streamui-edit-fill);
    }
    .streamui-selection-selected {
      z-index: 2147483644;
      background: var(--streamui-edit-fill-selected);
    }
    .streamui-selection-busy {
      z-index: 2147483643;
      isolation: isolate;
      overflow: hidden;
      border-radius: 10px;
      background: var(--streamui-edit-fill-busy);
    }
    .streamui-selection-busy::before {
      content: "";
      position: absolute;
      inset: -80%;
      background: linear-gradient(
        135deg,
        transparent 43%,
        var(--streamui-edit-sheen-soft) 47%,
        var(--streamui-edit-sheen) 50%,
        var(--streamui-edit-sheen-soft) 53%,
        transparent 57%
      );
      transform: translate3d(-34%, -34%, 0);
      will-change: transform;
      animation: streamui-selection-busy-sheen 1800ms ease-in-out infinite;
    }
    @keyframes streamui-selection-busy-sheen {
      0%, 12% {
        transform: translate3d(-34%, -34%, 0);
      }
      82%, 100% {
        transform: translate3d(34%, 34%, 0);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .streamui-selection-busy::before {
        animation: none;
        transform: translate3d(0, 0, 0);
      }
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
    .streamui-image-fallback {
      display: grid;
      width: 100%;
      min-height: 120px;
      place-items: center;
      padding: 20px;
      border: 1px dashed var(--streamui-secondary-border);
      border-radius: 6px;
      color: var(--streamui-muted);
      background: color-mix(in srgb, var(--streamui-page-bg) 92%, var(--streamui-text) 8%);
      font-size: 13px;
      line-height: 1.4;
      text-align: center;
    }
    .streamui-video-launch,
    .streamui-video-active {
      width: 100%;
      height: 100%;
      min-height: 180px;
      aspect-ratio: 16 / 9;
      border: 0;
      border-radius: inherit;
    }
    .streamui-video-player {
      position: relative;
      width: 100%;
      min-height: 180px;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      border-radius: inherit;
      background: #050505;
    }
    .streamui-video-player .streamui-video-active {
      display: block;
    }
    .streamui-video-external {
      position: absolute;
      right: 10px;
      bottom: 10px;
      z-index: 1;
      padding: 7px 10px;
      border-radius: 999px;
      color: #ffffff;
      background: rgba(0, 0, 0, 0.82);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.2;
      text-decoration: none;
      cursor: pointer;
    }
    .streamui-video-launch {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      justify-content: center;
      padding: 24px;
      color: #ffffff;
      background: linear-gradient(135deg, #171717, #050505);
      cursor: pointer;
      text-align: left;
    }
    .streamui-video-launch-icon {
      display: grid;
      width: 48px;
      height: 48px;
      place-items: center;
      border-radius: 999px;
      background: #e11d2e;
      font-size: 20px;
      line-height: 1;
    }
    .streamui-video-launch-label {
      overflow: hidden;
      font-size: 14px;
      font-weight: 700;
      line-height: 1.35;
      text-overflow: ellipsis;
    }
    .streamui-resource figcaption,
    .streamui-sources {
      margin-top: 6px;
      color: var(--streamui-muted);
      font-size: 0.88rem;
      line-height: 1.45;
    }
`;
}
