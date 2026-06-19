/**
 * The bottom status bar (fleet design): a top-bordered bar across the foot of the
 * window. Its content is intentionally not decided yet — what to surface here is
 * a separate task — so this is the placeholder shell that fixes the layout slot.
 */

import type { CSSProperties } from "react";

export function StatusBar() {
  return <footer style={S.bar} aria-label="Status bar" />;
}

const S: Record<string, CSSProperties> = {
  bar: {
    flexShrink: 0,
    minHeight: "1.75rem",
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.25rem 1rem",
    background: "var(--surface)",
    borderTop: "1px solid var(--border)",
    color: "var(--text-2)",
    fontSize: "0.8rem",
  },
};
