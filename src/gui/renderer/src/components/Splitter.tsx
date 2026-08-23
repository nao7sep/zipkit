/**
 * A vertical drag handle between two columns. It owns only the pointer gesture:
 * on mouse-down it reports the start, streams the horizontal delta while dragging
 * (so the parent recomputes the adjacent column's width and clamps it), and
 * reports the end (so the parent persists). It is also a focusable ARIA separator:
 * arrows move it by 10px and Home/End move to its bounds through the same parent
 * width authority.
 */

import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

export function Splitter({
  onDragStart,
  onDragDelta,
  onDragEnd,
  onDragCancel,
  onKeyboardDelta,
  value,
  min,
  max,
  label,
  direction = 1,
}: {
  onDragStart: () => void;
  onDragDelta: (dx: number) => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
  onKeyboardDelta: (dx: number) => void;
  value: number;
  min: number;
  max: number;
  label: string;
  /** How physical rightward movement changes the represented pane width. */
  direction?: 1 | -1;
}) {
  const clearGestureRef = useRef<((commit: boolean, notify: boolean) => void) | null>(null);

  useEffect(
    () => () => {
      clearGestureRef.current?.(false, false);
    },
    [],
  );

  function onMouseDown(e: ReactMouseEvent) {
    e.preventDefault();
    clearGestureRef.current?.(false, true);
    const startX = e.clientX;
    onDragStart();
    const move = (ev: MouseEvent) => onDragDelta(ev.clientX - startX);
    const finish = (commit: boolean, notify = true) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("visibilitychange", visibility);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      clearGestureRef.current = null;
      if (notify) (commit ? onDragEnd : onDragCancel)();
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    clearGestureRef.current = finish;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", keydown);
    document.addEventListener("visibilitychange", visibility);
    // While dragging, keep the resize cursor and stop text selection everywhere.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let delta: number | null = null;
    if (e.key === "ArrowLeft") delta = -10;
    else if (e.key === "ArrowRight") delta = 10;
    else if (e.key === "Home") delta = ((direction === 1 ? min : max) - value) / direction;
    else if (e.key === "End") delta = ((direction === 1 ? max : min) - value) / direction;
    if (delta === null) return;
    e.preventDefault();
    onKeyboardDelta(delta);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      style={S.splitter}
    >
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
