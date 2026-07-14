import type { ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

type ChatShellProps = {
  children: ReactNode;
  sidebar?: ReactNode;
  workspaceStatus?: ReactNode;
  themeMode?: "day" | "night";
  onThemeModeChange?(mode: "day" | "night"): void;
};

export function ChatShell({
  children,
  sidebar,
  workspaceStatus,
  themeMode = "night",
  onThemeModeChange
}: ChatShellProps) {
  const nextThemeMode = themeMode === "day" ? "night" : "day";

  return (
    <main className="app-shell" data-theme={themeMode}>
      <div className="app-body">
        {sidebar}
        <section className="chat-workspace">
          {workspaceStatus || onThemeModeChange ? (
            <div className="workspace-toolbar">
              {workspaceStatus}
              {onThemeModeChange ? (
                <button
                  className="app-theme-button"
                  type="button"
                  data-mode={themeMode}
                  aria-label={`Use ${nextThemeMode} theme`}
                  title={`Use ${nextThemeMode} theme`}
                  onClick={() => onThemeModeChange(nextThemeMode)}
                >
                  <Sun className="app-theme-icon is-sun" size={18} aria-hidden="true" />
                  <Moon className="app-theme-icon is-moon" size={18} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
          {children}
        </section>
      </div>
    </main>
  );
}
