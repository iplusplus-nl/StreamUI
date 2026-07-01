import type { ReactNode } from "react";

type ChatShellProps = {
  children: ReactNode;
};

export function ChatShell({ children }: ChatShellProps) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Local demo</p>
          <h1>StreamUI Runtime</h1>
        </div>
        <div className="status-pill">
          <span className="status-dot" />
          Proxy ready
        </div>
      </header>
      {children}
    </div>
  );
}
