import { useEffect, useRef, useState } from "react";
import {
  Bug,
  Laptop,
  LogIn,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  PanelLeftOpen,
  SquarePen,
  Trash2,
  X
} from "lucide-react";
import type { AccountMode } from "../core/accountMode";
import type { ApiSettings } from "../core/apiSettings";
import type { AuthUser } from "../core/cloudAuth";
import type { DisplaySettings } from "../core/displaySettings";
import type { ProfileSettings } from "../core/profileSettings";
import type { RuntimeSettingsSummary } from "../core/runtimeSettings";
import type { SearchSettings } from "../core/searchSettings";
import { requestSessionDeletion } from "../features/sessions/sessionDeletionModel";
import type { SettingsSection } from "../features/settings/settingsDialogModel";
import { isEscapeDismissKey, isTargetOutside } from "./dismissalModel";
import { ProfileAvatar } from "./ProfileAvatar";
import { SettingsDialog } from "./SettingsDialog";

export type ThemeMode = "day" | "night";

export type SessionListItem = {
  id: string;
  title: string;
  local?: boolean;
};

const COMPACT_SIDEBAR_QUERY = "(max-width: 720px), (orientation: portrait)";

function getInitialSidebarCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia(COMPACT_SIDEBAR_QUERY).matches;
}

type SessionSidebarProps = {
  sessions: SessionListItem[];
  activeSessionId: string;
  activeSessionLocal?: boolean;
  isSending: boolean;
  isSessionSelectionBlocked: boolean;
  themeMode: ThemeMode;
  apiSettings: ApiSettings;
  searchSettings: SearchSettings;
  displaySettings: DisplaySettings;
  profileSettings: ProfileSettings;
  runtimeSettings: RuntimeSettingsSummary | null;
  cloudEnabled?: boolean;
  accountMode?: AccountMode;
  authUser?: AuthUser | null;
  onNewSession(): void;
  onSelectSession(id: string, local: boolean): void;
  onDeleteSession(id: string, local: boolean): void;
  onApiSettingsChange(settings: ApiSettings): void;
  onSearchSettingsChange(settings: SearchSettings): void;
  onDisplaySettingsChange(settings: DisplaySettings): void;
  onProfileSettingsChange(settings: ProfileSettings): void;
  onLoginRequest?(): void;
  onLogout?(): void;
  onExportAccount?(): void;
  onDeleteAccount?(): void;
  onGenerateRecoveryCode?(): Promise<string>;
  onBugReportOpen(): void;
  isBugReportCapturing?: boolean;
  confirmDeleteSession?(message: string): boolean;
  providerSettingsRequestVersion?: number;
};

export function SessionSidebar({
  sessions,
  activeSessionId,
  activeSessionLocal = false,
  isSending,
  isSessionSelectionBlocked,
  themeMode,
  apiSettings,
  searchSettings,
  displaySettings,
  profileSettings,
  runtimeSettings,
  cloudEnabled = false,
  accountMode = "unselected",
  authUser,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onApiSettingsChange,
  onSearchSettingsChange,
  onDisplaySettingsChange,
  onProfileSettingsChange,
  onLoginRequest,
  onLogout,
  onExportAccount,
  onDeleteAccount,
  onGenerateRecoveryCode,
  onBugReportOpen,
  isBugReportCapturing = false,
  confirmDeleteSession = (message) => window.confirm(message),
  providerSettingsRequestVersion = 0
}: SessionSidebarProps) {
  const [isCompactSidebar, setIsCompactSidebar] = useState(
    getInitialSidebarCollapsed
  );
  const [isCollapsed, setIsCollapsed] = useState(getInitialSidebarCollapsed);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("profile");
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const openSessionMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const openSessionMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const compactOpenButtonRef = useRef<HTMLButtonElement | null>(null);
  const compactCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const shouldShowSignIn =
    cloudEnabled && !authUser && Boolean(onLoginRequest);
  const shouldShowPersonalSettings =
    !shouldShowSignIn || accountMode === "local";

  const openSettingsSection = (section: SettingsSection) => {
    setOpenSessionMenuId(null);
    if (isCompactSidebar) {
      setIsCollapsed(true);
    }
    setSettingsSection(section);
    setIsSettingsOpen(true);
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_SIDEBAR_QUERY);
    const updateCompactSidebarState = () => {
      setIsCompactSidebar(mediaQuery.matches);
      if (mediaQuery.matches) {
        setIsCollapsed(true);
      }
    };

    updateCompactSidebarState();
    mediaQuery.addEventListener("change", updateCompactSidebarState);

    return () => {
      mediaQuery.removeEventListener("change", updateCompactSidebarState);
    };
  }, []);

  useEffect(() => {
    if (isSending) {
      setOpenSessionMenuId(null);
    }
  }, [isSending]);

  useEffect(() => {
    if (!openSessionMenuId) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        isTargetOutside(openSessionMenuButtonRef.current, target) &&
        isTargetOutside(openSessionMenuPopoverRef.current, target)
      ) {
        setOpenSessionMenuId(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isEscapeDismissKey(event.key)) {
        return;
      }
      event.preventDefault();
      setOpenSessionMenuId(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openSessionMenuId]);

  const isCompactDrawerOpen = isCompactSidebar && !isCollapsed;

  useEffect(() => {
    if (!isCompactDrawerOpen) {
      return undefined;
    }

    const workspace = document.querySelector<HTMLElement>(".chat-workspace");
    const workspaceWasInert = workspace?.hasAttribute("inert") ?? false;
    workspace?.setAttribute("inert", "");
    compactCloseButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isEscapeDismissKey(event.key) || event.defaultPrevented) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[aria-modal="true"]') !== sidebarRef.current
      ) {
        return;
      }

      event.preventDefault();
      setOpenSessionMenuId(null);
      setIsCollapsed(true);
      window.setTimeout(() => compactOpenButtonRef.current?.focus());
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (workspace && !workspaceWasInert) {
        workspace.removeAttribute("inert");
      }
    };
  }, [isCompactDrawerOpen]);

  useEffect(() => {
    if (providerSettingsRequestVersion <= 0) {
      return;
    }
    openSettingsSection("api");
  }, [providerSettingsRequestVersion]);

  return (
    <>
      {isCompactDrawerOpen ? (
        <button
          className="session-drawer-backdrop"
          type="button"
          tabIndex={-1}
          aria-label="Close session drawer"
          onClick={() => {
            setOpenSessionMenuId(null);
            setIsCollapsed(true);
            window.setTimeout(() => compactOpenButtonRef.current?.focus());
          }}
        />
      ) : null}
    <aside
      ref={sidebarRef}
      className={`history-sidebar ${isCollapsed ? "is-collapsed" : ""}`}
      aria-label="Session history"
      role={isCompactDrawerOpen ? "dialog" : undefined}
      aria-modal={isCompactDrawerOpen ? "true" : undefined}
    >
      {isCollapsed ? (
        <>
          <div className="collapsed-sidebar-top">
            <button
              ref={isCompactSidebar ? compactOpenButtonRef : undefined}
              className="collapsed-sidebar-button"
              type="button"
              aria-label="Expand sidebar"
              onClick={() => setIsCollapsed(false)}
            >
              {isCompactSidebar ? (
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
              onClick={() => {
                if (isCompactSidebar) {
                  setIsCollapsed(true);
                }
                onNewSession();
              }}
            >
              <SquarePen size={21} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          <div className="collapsed-sidebar-spacer" />
          <div className="collapsed-sidebar-bottom">
            {shouldShowSignIn ? (
              <button
                className="sidebar-sign-in-button is-collapsed"
                type="button"
                aria-label="Sign in to ChatHTML"
                title="Sign in"
                onClick={onLoginRequest}
              >
                <LogIn size={18} strokeWidth={2.1} aria-hidden="true" />
              </button>
            ) : null}
            {shouldShowPersonalSettings ? (
              <button
                className="sidebar-profile-button is-collapsed"
                type="button"
                aria-label="Open personal settings"
                title="Personal settings"
                onClick={() => openSettingsSection("profile")}
              >
                <ProfileAvatar avatarDataUrl={profileSettings.avatarDataUrl} />
              </button>
            ) : null}
            <button
              className="collapsed-sidebar-button"
              type="button"
              aria-label="Bug Report"
              title={
                isBugReportCapturing ? "Capturing screenshot…" : "Bug Report"
              }
              disabled={isBugReportCapturing}
              onClick={onBugReportOpen}
            >
              {isBugReportCapturing ? (
                <LoaderCircle
                  className="bug-report-spinner"
                  size={21}
                  aria-hidden="true"
                />
              ) : (
                <Bug size={21} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-header">
            <div className="sidebar-brand-row">
              <span className="sidebar-brand">ChatHTML</span>
              <button
                ref={isCompactSidebar ? compactCloseButtonRef : undefined}
                className="sidebar-collapse-button"
                type="button"
                aria-label="Collapse sidebar"
                onClick={() => {
                  setOpenSessionMenuId(null);
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
                if (isCompactSidebar) {
                  setIsCollapsed(true);
                }
                onNewSession();
              }}
            >
              <SquarePen size={17} strokeWidth={2.1} aria-hidden="true" />
              <span>New Session</span>
            </button>
          </div>

          <nav className="session-list" aria-label="Saved sessions">
            {sessions.map((session) => {
              const isLocal = Boolean(session.local && authUser);
              const isActive =
                session.id === activeSessionId && isLocal === activeSessionLocal;
              const menuId = `${isLocal ? "local" : "account"}:${session.id}`;
              const canManage = isLocal === activeSessionLocal;
              return (
              <div
                key={menuId}
                className={`session-list-item ${isActive ? "is-active" : ""} ${
                  openSessionMenuId === menuId ? "is-menu-open" : ""
                }`}
              >
                <button
                  className="session-select-button"
                  type="button"
                  disabled={isSessionSelectionBlocked}
                  aria-current={
                    isActive ? "page" : undefined
                  }
                  onClick={() => {
                    setOpenSessionMenuId(null);
                    if (isCompactSidebar) {
                      setIsCollapsed(true);
                    }
                    onSelectSession(session.id, isLocal);
                  }}
                >
                  <span className="session-title-row">
                    {isLocal ? (
                      <Laptop
                        className="session-location-icon"
                        size={14}
                        strokeWidth={2}
                        aria-label="Stored on this device"
                      />
                    ) : null}
                    <span className="session-title">{session.title}</span>
                  </span>
                </button>
                {canManage ? (
                  <button
                    ref={
                      openSessionMenuId === menuId
                        ? openSessionMenuButtonRef
                        : undefined
                    }
                    className="session-actions-button"
                    type="button"
                    disabled={isSending}
                    aria-label={`Session actions: ${session.title}`}
                    aria-expanded={openSessionMenuId === menuId}
                    onClick={() =>
                      setOpenSessionMenuId((current) =>
                        current === menuId ? null : menuId
                      )
                    }
                  >
                    <MoreHorizontal
                      size={17}
                      strokeWidth={2.1}
                      aria-hidden="true"
                    />
                  </button>
                ) : null}
                {canManage && openSessionMenuId === menuId ? (
                  <div
                    ref={openSessionMenuPopoverRef}
                    className="session-menu-popover"
                    role="menu"
                  >
                    <button
                      className="session-menu-item is-danger"
                      type="button"
                      role="menuitem"
                      disabled={isSending}
                      onClick={() => {
                        setOpenSessionMenuId(null);
                        requestSessionDeletion(
                          session,
                          confirmDeleteSession,
                          (sessionId) => onDeleteSession(sessionId, isLocal)
                        );
                      }}
                    >
                      <Trash2 size={16} strokeWidth={2.1} aria-hidden="true" />
                      <span>Delete</span>
                    </button>
                  </div>
                ) : null}
              </div>
              );
            })}
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-account-entry">
              {shouldShowSignIn ? (
                <button
                  className="sidebar-sign-in-button"
                  type="button"
                  aria-label="Sign in to ChatHTML"
                  onClick={onLoginRequest}
                >
                  <LogIn size={16} strokeWidth={2.1} aria-hidden="true" />
                  <span>Sign in</span>
                </button>
              ) : null}
              {shouldShowPersonalSettings ? (
                <button
                  className="sidebar-profile-button"
                  type="button"
                  aria-label="Open personal settings"
                  title={authUser?.email || "Personal settings"}
                  onClick={() => openSettingsSection("profile")}
                >
                  <ProfileAvatar avatarDataUrl={profileSettings.avatarDataUrl} />
                </button>
              ) : null}
              {cloudEnabled && authUser ? (
                <button
                  className="sidebar-account-label"
                  type="button"
                  title={authUser.email}
                  aria-label={`Open account settings for ${authUser.email}`}
                  onClick={() => openSettingsSection("profile")}
                >
                  {authUser.email}
                </button>
              ) : null}
            </div>
            <button
              className="sidebar-icon-button"
              type="button"
              aria-label="Bug Report"
              title={
                isBugReportCapturing ? "Capturing screenshot…" : "Bug Report"
              }
              disabled={isBugReportCapturing}
              onClick={onBugReportOpen}
            >
              {isBugReportCapturing ? (
                <LoaderCircle
                  className="bug-report-spinner"
                  size={17}
                  aria-hidden="true"
                />
              ) : (
                <Bug size={17} strokeWidth={2.1} aria-hidden="true" />
              )}
            </button>
          </div>
        </>
      )}

      {isSettingsOpen ? (
        <SettingsDialog
          section={settingsSection}
          themeMode={themeMode}
          apiSettings={apiSettings}
          searchSettings={searchSettings}
          displaySettings={displaySettings}
          profileSettings={profileSettings}
          runtimeSettings={runtimeSettings}
          cloudEnabled={cloudEnabled}
          accountMode={accountMode}
          authUser={authUser}
          onClose={() => setIsSettingsOpen(false)}
          onSectionChange={setSettingsSection}
          onApiSettingsChange={onApiSettingsChange}
          onSearchSettingsChange={onSearchSettingsChange}
          onDisplaySettingsChange={onDisplaySettingsChange}
          onProfileSettingsChange={onProfileSettingsChange}
          onLogout={
            onLogout
              ? () => {
                  setIsSettingsOpen(false);
                  onLogout();
                }
              : undefined
          }
          onExportAccount={onExportAccount}
          onDeleteAccount={onDeleteAccount}
          onGenerateRecoveryCode={onGenerateRecoveryCode}
        />
      ) : null}
    </aside>
    </>
  );
}
