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
  rootStyle,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyStyle?: CSSProperties;
  rootStyle?: CSSProperties;
}) {
  return (
    <section style={{ ...S.pane, ...rootStyle }}>
      <header style={S.header}>
        <h2 style={S.title} title={title}>
          {title}
        </h2>
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
  // A fixed header height so every pane's header lines up regardless of whether
  // its actions hold a button (Jobs), a badge (Archive), or nothing (Progress).
  header: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    minHeight: "3rem",
    padding: "0.4rem 0.85rem",
    borderBottom: "1px solid var(--border)",
  },
  // Truncates so a long job-inventory title never pushes the state pill off the
  // header; the full text is available via the hover tooltip.
  title: {
    margin: 0,
    minWidth: 0,
    fontSize: "0.9rem",
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // marginLeft:auto right-aligns it; flexShrink:0 keeps the pill at full size.
  actions: { marginLeft: "auto", flexShrink: 0, display: "flex", gap: "0.5rem", alignItems: "center" },
  body: { flex: 1, minHeight: 0, overflow: "auto", padding: "0.85rem" },
};
