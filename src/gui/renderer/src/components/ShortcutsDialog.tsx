/**
 * Shortcuts dialog (modal-dialog conventions): the app's keyboard model, grouped,
 * description on the left and keys on the right with every key spelled out. It
 * renders the one shortcut catalog (`shortcuts.ts`), so it can never list a
 * binding the app does not actually have. Rows are separated by a zebra fill
 * inside a rounded group card — no per-row rules.
 */

import type { CSSProperties } from "react";
import { ModalShell } from "./ModalShell";
import { SHORTCUTS } from "../shortcuts";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={<button onClick={onClose}>Close</button>}
    >
      <div style={S.groups}>
        {SHORTCUTS.map((group) => (
          <section key={group.title}>
            <div style={S.groupTitle}>{group.title}</div>
            <div style={S.card}>
              {group.items.map((item, i) => (
                <div key={item.keys} style={{ ...S.row, ...(i % 2 ? S.rowAlt : null) }}>
                  <span>{item.description}</span>
                  <kbd style={S.keys}>{item.keys}</kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ModalShell>
  );
}

const S: Record<string, CSSProperties> = {
  groups: { display: "grid", gap: "1.25rem" },
  groupTitle: {
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-2)",
    marginBottom: "0.4rem",
  },
  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    overflow: "hidden",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "1rem",
    padding: "0.4rem 0.7rem",
  },
  rowAlt: { background: "var(--surface-2)" },
  keys: {
    flexShrink: 0,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    padding: "0.1rem 0.45rem",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.8rem",
  },
};
