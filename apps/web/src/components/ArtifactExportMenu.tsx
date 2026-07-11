import {
  Bug,
  Check,
  Code2,
  Copy,
  Ellipsis,
  FileDown,
  FileText,
  ImageDown,
  Share2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../api/appUrl";
import {
  copySnapshotSourceCode,
  copySnapshotVisibleText,
  createArtifactFilename,
  downloadSnapshotAsHtml,
  downloadSnapshotAsPng,
  downloadSnapshotAsSvg,
  downloadSnapshotDiagnostics,
  getSnapshotHtmlDocument
} from "../core/artifactExport";
import type { PageThemeMode, RenderSnapshot } from "../core/types";

type ArtifactExportAction =
  | "copy-code"
  | "copy-text"
  | "create-share-link"
  | "download-html"
  | "download-png"
  | "download-svg"
  | "download-diagnostics";

type ArtifactExportMenuProps = {
  filenameBase: string;
  getExportWidth(): number;
  snapshot: RenderSnapshot;
  themeMode: PageThemeMode;
};

type ExportStatus = {
  action: ArtifactExportAction;
  kind: "success" | "error";
  message: string;
  url?: string;
};

type MenuAction = {
  action: ArtifactExportAction;
  icon: typeof Code2;
  label: string;
};

const MENU_ACTIONS: MenuAction[] = [
  { action: "copy-code", icon: Code2, label: "Copy Code" },
  { action: "copy-text", icon: Copy, label: "Copy Text" },
  {
    action: "create-share-link",
    icon: Share2,
    label: "Share Link"
  },
  { action: "download-html", icon: FileText, label: "Download HTML" },
  { action: "download-png", icon: ImageDown, label: "Download PNG" },
  { action: "download-svg", icon: FileDown, label: "Download SVG" },
  { action: "download-diagnostics", icon: Bug, label: "Diagnostics" }
];

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Export failed.";
}

function formatPngStatus(result: { scale: number }): string {
  if (result.scale >= 0.99) {
    return "PNG downloaded";
  }

  return `PNG downloaded (${Math.round(result.scale * 100)}% scale)`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function createArtifactShareLink({
  filenameBase,
  snapshot,
  themeMode
}: {
  filenameBase: string;
  snapshot: RenderSnapshot;
  themeMode: PageThemeMode;
}): Promise<{ copied: boolean; url: string }> {
  const response = await fetch(apiUrl("/html-shares"), {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      html: getSnapshotHtmlDocument(snapshot, themeMode),
      sourceMessageId: filenameBase,
      themeMode,
      title: filenameBase
    })
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    url?: unknown;
  };

  if (!response.ok || typeof payload.url !== "string") {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Share link failed with HTTP ${response.status}.`
    );
  }

  return {
    copied: await copyTextToClipboard(payload.url),
    url: payload.url
  };
}

export function ArtifactExportMenu({
  filenameBase,
  getExportWidth,
  snapshot,
  themeMode
}: ArtifactExportMenuProps) {
  const [activeAction, setActiveAction] = useState<ArtifactExportAction | null>(
    null
  );
  const [isPinned, setIsPinned] = useState(false);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const filenames = useMemo(
    () => ({
      diagnostics: createArtifactFilename(`${filenameBase}-diagnostics`, "txt"),
      html: createArtifactFilename(filenameBase, "html"),
      png: createArtifactFilename(filenameBase, "png"),
      svg: createArtifactFilename(filenameBase, "svg")
    }),
    [filenameBase]
  );
  const isOpen = isPinned;

  useEffect(() => {
    if (!status || status.kind === "error") {
      return undefined;
    }

    const timeout = window.setTimeout(() => setStatus(null), 2_000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  useEffect(() => {
    if (!isPinned) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsPinned(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPinned]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const closeMenu = () => {
      setIsPinned(false);
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }

      closeMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("blur", closeMenu);
    };
  }, [isOpen]);

  const runAction = async (action: ArtifactExportAction) => {
    if (activeAction) {
      return;
    }

    setActiveAction(action);
    setStatus(null);

    try {
      const width = getExportWidth();

      if (action === "copy-code") {
        await copySnapshotSourceCode(snapshot);
        setStatus({ action, kind: "success", message: "Code copied" });
        return;
      }

      if (action === "copy-text") {
        await copySnapshotVisibleText(snapshot);
        setStatus({ action, kind: "success", message: "Text copied" });
        return;
      }

      if (action === "create-share-link") {
        const result = await createArtifactShareLink({
          filenameBase,
          snapshot,
          themeMode
        });
        setStatus({
          action,
          kind: "success",
          message: result.copied ? "Share link copied" : "Open share link",
          url: result.copied ? undefined : result.url
        });
        return;
      }

      if (action === "download-html") {
        downloadSnapshotAsHtml(snapshot, {
          filename: filenames.html,
          themeMode
        });
        setStatus({ action, kind: "success", message: "HTML downloaded" });
        return;
      }

      if (action === "download-png") {
        const result = await downloadSnapshotAsPng(snapshot, {
          filename: filenames.png,
          themeMode,
          width
        });
        setStatus({
          action,
          kind: "success",
          message: formatPngStatus(result)
        });
        return;
      }

      if (action === "download-svg") {
        await downloadSnapshotAsSvg(snapshot, {
          filename: filenames.svg,
          themeMode,
          width
        });
        setStatus({ action, kind: "success", message: "SVG downloaded" });
        return;
      }

      downloadSnapshotDiagnostics(snapshot, {
        exportWidth: width,
        filename: filenames.diagnostics,
        themeMode
      });
      setStatus({
        action,
        kind: "success",
        message: "Diagnostics downloaded"
      });
    } catch (error) {
      setStatus({
        action,
        kind: "error",
        message: getErrorMessage(error)
      });
    } finally {
      setActiveAction(null);
    }
  };

  const isBusy = activeAction !== null;
  const isInteractive = isOpen;

  return (
    <div
      ref={rootRef}
      className={`artifact-export-menu ${isOpen ? "is-open" : ""} ${
        isPinned ? "is-pinned" : ""
      }`}
    >
      <div
        className="artifact-export-popover"
        role="menu"
        aria-hidden={!isInteractive}
      >
        {MENU_ACTIONS.map(({ action, icon: Icon, label }) => (
          <button
            className="artifact-export-menu-item"
            type="button"
            role="menuitem"
            disabled={isBusy}
            key={action}
            tabIndex={isInteractive ? 0 : -1}
            onClick={() => {
              void runAction(action);
            }}
          >
            <Icon size={14} strokeWidth={2} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
        {status ? (
          <span
            className={`artifact-export-status is-${status.kind}`}
            role={status.kind === "error" ? "alert" : "status"}
          >
            {status.kind === "success" ? (
              <Check size={12} strokeWidth={2.2} aria-hidden="true" />
            ) : null}
            {status.url ? (
              <a
                className="artifact-export-status-link"
                href={status.url}
                target="_blank"
                rel="noreferrer"
              >
                {status.message}
              </a>
            ) : (
              <span>{status.message}</span>
            )}
          </span>
        ) : null}
      </div>
      <button
        className="artifact-export-trigger"
        type="button"
        aria-expanded={isOpen}
        aria-label="Artifact actions"
        title="Artifact actions"
        onClick={() => setIsPinned((current) => !current)}
      >
        <Ellipsis size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}
