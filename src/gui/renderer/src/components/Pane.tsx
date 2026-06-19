/**
 * A rounded surface pane (fleet design): a titled card with a bold header row
 * (optional right-aligned actions) and a scrollable body. Layout-only chrome —
 * callers supply the title, actions, and content. The host grid sizes it; the
 * pane fills its cell and scrolls its own body.
 */

import type { CSSProperties, ReactNode } from "react";

export function Pane({
  title,
  actions,
  children,
  bodyStyle,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyStyle?: CSSProperties;
}) {
  return (
    <section style={S.pane}>
      <header style={S.header}>
        <h2 style={S.title}>{title}</h2>
        {actions && <div style={S.actions}>{actions}</div>}
      </header>
      <div style={{ ...S.body, ...bodyStyle }}>{children}</div>
    </section>
  );
}

const S: Record<string, CSSProperties> = {
  pane: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.6rem 0.85rem",
    borderBottom: "1px solid var(--border)",
  },
  title: { margin: 0, fontSize: "0.9rem", fontWeight: 700 },
  actions: { marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center" },
  body: { flex: 1, minHeight: 0, overflow: "auto", padding: "0.85rem" },
};
