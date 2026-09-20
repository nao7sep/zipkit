/**
 * Shortcuts dialog (modal-dialog conventions): the app's keyboard model, grouped,
 * description on the left and keys on the right with every key spelled out. It
 * renders the one shortcut catalog (`shortcuts.ts`), so it can never list a
 * binding the app does not actually have. A reference list is read, not
 * navigated, so the rows carry no chrome of their own: the group heading and
 * the space between rows do the separating, and the only mark on the surface is
 * the key itself.
 */

import type { CSSProperties } from "react";
import { ModalShell } from "./ModalShell";
import { buildShortcuts, modifierWord } from "../shortcuts";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  // The running platform's single modifier word ("Cmd" on macOS, "Ctrl" else),
  // so the displayed accelerators match the host OS rather than "Cmd/Ctrl".
  const groups = buildShortcuts(modifierWord(window.zipkit.platform));
  return (
    <ModalShell
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={<button onClick={onClose}>Close</button>}
    >
      <div style={S.groups}>
        {groups.map((group) => (
          <section key={group.title}>
            <div style={S.groupTitle}>{group.title}</div>
            <div style={S.list}>
              {group.items.map((item) => (
                <div key={item.keys} style={S.row}>
                  <span style={S.description}>{item.description}</span>
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
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-2)",
    marginBottom: "0.4rem",
  },
  list: { display: "grid", gap: "2px" },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "1rem",
    padding: "0.35rem 0",
  },
  description: { minWidth: 0, fontSize: "0.9rem" },
  // The key reads as the accent's own mark rather than a drawn keycap: a soft
  // tint carries it without adding a border to every row.
  keys: {
    flexShrink: 0,
    background: "color-mix(in srgb, var(--accent-strong) 15%, transparent)",
    color: "var(--accent-strong)",
    borderRadius: 4,
    padding: "0.1rem 0.45rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.8rem",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
};
