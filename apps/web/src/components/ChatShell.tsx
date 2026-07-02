import type { ReactNode } from "react";

type ChatShellProps = {
  children: ReactNode;
};

export function ChatShell({ children }: ChatShellProps) {
  return <main className="app-shell">{children}</main>;
}
