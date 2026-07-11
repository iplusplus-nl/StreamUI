import { useEffect, useState } from "react";
import {
  Download,
  Menu,
  MoreHorizontal,
  PanelLeftOpen,
  SquarePen,
  Trash2,
  X
} from "lucide-react";

const COMPACT_SIDEBAR_QUERY = "(max-width: 720px), (orientation: portrait)";

function initialCollapsed(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(COMPACT_SIDEBAR_QUERY).matches
  );
}

export type WebDemoSessionItem = { id: string; title: string };

type WebDemoSidebarProps = {
  sessions: WebDemoSessionItem[];
  activeSessionId: string;
  isSending: boolean;
  onNewSession(): void;
  onSelectSession(id: string): void;
  onDeleteSession(id: string): void;
  onDownload(): void;
};

export function WebDemoSidebar({
  sessions,
  activeSessionId,
  isSending,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onDownload
}: WebDemoSidebarProps) {
  const [isCompact, setIsCompact] = useState(initialCollapsed);
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_SIDEBAR_QUERY);
    const update = () => {
      setIsCompact(media.matches);
      if (media.matches) {
        setIsCollapsed(true);
      }
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (isSending) {
      setOpenMenuId(null);
    }
  }, [isSending]);

  const selectSession = (id: string) => {
    setOpenMenuId(null);
    if (isCompact) {
      setIsCollapsed(true);
    }
    onSelectSession(id);
  };

  return (
    <aside
      className={`history-sidebar webdemo-sidebar ${
        isCollapsed ? "is-collapsed" : ""
      }`}
      aria-label="Local chat history"
    >
      {isCollapsed ? (
        <>
          <div className="collapsed-sidebar-top">
            <button
              className="collapsed-sidebar-button"
              type="button"
              aria-label="Expand sidebar"
              onClick={() => setIsCollapsed(false)}
            >
              {isCompact ? (
                <Menu size={24} strokeWidth={2} aria-hidden="true" />
              ) : (
                <PanelLeftOpen size={21} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
            <button
              className="collapsed-sidebar-button"
              type="button"
              disabled={isSending}
              aria-label="New session"
              onClick={onNewSession}
            >
              <SquarePen size={21} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          <div className="collapsed-sidebar-spacer" />
          <div className="collapsed-sidebar-bottom">
            <button
              className="sidebar-sign-in-button is-collapsed"
              type="button"
              aria-label="Download ChatHTML"
              title="Download ChatHTML"
              onClick={onDownload}
            >
              <Download size={18} strokeWidth={2.1} aria-hidden="true" />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-header">
            <div className="sidebar-brand-row">
              <span className="sidebar-brand">ChatHTML</span>
              <button
                className="sidebar-collapse-button"
                type="button"
                aria-label="Collapse sidebar"
                onClick={() => {
                  setOpenMenuId(null);
                  setIsCollapsed(true);
                }}
              >
                <X size={20} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <button
              className="new-session-button"
              type="button"
              disabled={isSending}
              onClick={() => {
                if (isCompact) {
                  setIsCollapsed(true);
                }
                onNewSession();
              }}
            >
              <SquarePen size={17} strokeWidth={2.1} aria-hidden="true" />
              <span>New Session</span>
            </button>
          </div>

          <nav className="session-list" aria-label="Browser chat history">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`session-list-item ${
                  session.id === activeSessionId ? "is-active" : ""
                } ${openMenuId === session.id ? "is-menu-open" : ""}`}
              >
                <button
                  className="session-select-button"
                  type="button"
                  disabled={isSending}
                  aria-current={
                    session.id === activeSessionId ? "page" : undefined
                  }
                  onClick={() => selectSession(session.id)}
                >
                  <span className="session-title">{session.title}</span>
                </button>
                <button
                  className="session-actions-button"
                  type="button"
                  disabled={isSending}
                  aria-label={`Session actions: ${session.title}`}
                  aria-expanded={openMenuId === session.id}
                  onClick={() =>
                    setOpenMenuId((current) =>
                      current === session.id ? null : session.id
                    )
                  }
                >
                  <MoreHorizontal size={17} strokeWidth={2.1} aria-hidden="true" />
                </button>
                {openMenuId === session.id ? (
                  <div className="session-menu-popover" role="menu">
                    <button
                      className="session-menu-item is-danger"
                      type="button"
                      role="menuitem"
                      disabled={isSending}
                      onClick={() => {
                        setOpenMenuId(null);
                        onDeleteSession(session.id);
                      }}
                    >
                      <Trash2 size={16} strokeWidth={2.1} aria-hidden="true" />
                      <span>Delete</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </nav>

          <div className="sidebar-footer webdemo-sidebar-footer">
            <button
              className="sidebar-sign-in-button"
              type="button"
              aria-label="Download ChatHTML"
              onClick={onDownload}
            >
              <Download size={16} strokeWidth={2.1} aria-hidden="true" />
              <span>Download</span>
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
