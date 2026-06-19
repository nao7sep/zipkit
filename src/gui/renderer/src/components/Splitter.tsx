/**
 * A vertical drag handle between two columns. It owns only the pointer gesture:
 * on mouse-down it reports the start, streams the horizontal delta while dragging
 * (so the parent recomputes the adjacent column's width and clamps it), and
 * reports the end (so the parent persists). The parent owns the widths; this owns
 * the drag. Keyboard resize is not offered — the widths persist, so this is a
 * one-time setup gesture, not a frequent interaction.
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

export function Splitter({
  onDragStart,
  onDragDelta,
  onDragEnd,
}: {
  onDragStart: () => void;
  onDragDelta: (dx: number) => void;
  onDragEnd: () => void;
}) {
  function onMouseDown(e: ReactMouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    onDragStart();
    const move = (ev: MouseEvent) => onDragDelta(ev.clientX - startX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onDragEnd();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    // While dragging, keep the resize cursor and stop text selection everywhere.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <div role="separator" aria-orientation="vertical" onMouseDown={onMouseDown} style={S.splitter}>
      <div style={S.grip} />
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  splitter: {
    cursor: "col-resize",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
  },
  grip: { width: 2, height: "2.5rem", maxHeight: "50%", borderRadius: 2, background: "var(--border)" },
};
