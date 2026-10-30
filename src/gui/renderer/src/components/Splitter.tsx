/**
 * A vertical drag handle between two columns. It owns only the pointer gesture:
 * on mouse-down it reports the start, streams the horizontal delta while dragging
 * (so the parent recomputes the adjacent column's width and clamps it), and
 * reports the end (so the parent persists). It is also a focusable ARIA separator:
 * arrows move it by 16px and Home/End move to its bounds through the same parent
 * width authority. Arrow presses step it one after another, so the keyboard's
 * moves are committed a short delay after the last one, each move pushing the
 * commit back (unsaved-edits conventions, Saving while the user works); a drag
 * starting meanwhile commits them first, so cancelling the drag cannot take
 * them with it. A move made just before the window closes can lose that last
 * commit, which is optional layout at close.
 */

import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

/** How far one arrow press moves a splitter. */
export const SPLITTER_KEY_STEP = 16;
/** How long after the last keyboard move a splitter commits its position. */
export const SPLITTER_KEY_COMMIT_DELAY_MS = 500;

export function Splitter({
  onDragStart,
  onDragDelta,
  onDragEnd,
  onDragCancel,
  onKeyboardDelta,
  onKeyboardCommit,
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
  /** The keyboard's moves since the last commit are done: persist them. Called
   *  `SPLITTER_KEY_COMMIT_DELAY_MS` after the last move, or as a drag starts. */
  onKeyboardCommit: () => void;
  value: number;
  min: number;
  max: number;
  label: string;
  /** How physical rightward movement changes the represented pane width. */
  direction?: 1 | -1;
}) {
  const clearGestureRef = useRef<((commit: boolean, notify: boolean) => void) | null>(null);
  const keyCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest callback, for a timer set during an earlier render.
  const commitRef = useRef(onKeyboardCommit);
  commitRef.current = onKeyboardCommit;

  useEffect(
    () => () => {
      clearGestureRef.current?.(false, false);
      if (keyCommit.current !== null) clearTimeout(keyCommit.current);
    },
    [],
  );

  function scheduleKeyboardCommit() {
    if (keyCommit.current !== null) clearTimeout(keyCommit.current);
    keyCommit.current = setTimeout(() => {
      keyCommit.current = null;
      commitRef.current();
    }, SPLITTER_KEY_COMMIT_DELAY_MS);
  }

  function flushKeyboardCommit() {
    if (keyCommit.current === null) return;
    clearTimeout(keyCommit.current);
    keyCommit.current = null;
    onKeyboardCommit();
  }

  function onMouseDown(e: ReactMouseEvent) {
    e.preventDefault();
    clearGestureRef.current?.(false, true);
    flushKeyboardCommit();
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
    if (e.key === "ArrowLeft") delta = -SPLITTER_KEY_STEP;
    else if (e.key === "ArrowRight") delta = SPLITTER_KEY_STEP;
    else if (e.key === "Home") delta = ((direction === 1 ? min : max) - value) / direction;
    else if (e.key === "End") delta = ((direction === 1 ? max : min) - value) / direction;
    if (delta === null) return;
    e.preventDefault();
    onKeyboardDelta(delta);
    scheduleKeyboardCommit();
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
  grip: { width: 2, height: "2.5rem", maxHeight: "50%", borderRadius: 2, background: "var(--splitter)" },
};
