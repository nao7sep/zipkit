/**
 * The activity log: the live SDK event stream, always visible (not folded). It
 * follows the tail — when the user is already at (or within a small threshold of)
 * the bottom, new lines auto-scroll into view; when the user has scrolled up to
 * read history, it leaves the viewport alone and stops following. This mirrors
 * ScriptDock's console behavior; the threshold is a pixel distance, not a line
 * count, so it is independent of font metrics.
 */

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { LogEvent } from "../../../shared/api";
import { formatEventLine } from "../view";

// "Near the bottom" tolerance, in pixels (ScriptDock uses 24). Within this of the
// bottom, the log keeps following; scroll up past it and it stops.
const PIN_THRESHOLD_PX = 24;

export function ActivityLog({ events }: { events: LogEvent[] }) {
  const ref = useRef<HTMLPreElement>(null);
  // Whether the user is currently following the tail. Starts pinned; updated on
  // every manual scroll, read after each new batch of lines.
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop <= PIN_THRESHOLD_PX;
  }

  if (events.length === 0) return <p style={S.empty}>No activity yet.</p>;
  return (
    <pre ref={ref} style={S.log} onScroll={onScroll}>
      {events.map(formatEventLine).join("\n")}
    </pre>
  );
}

const S: Record<string, CSSProperties> = {
  log: {
    margin: 0,
    height: "100%",
    overflow: "auto",
    fontSize: "0.8rem",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  empty: { margin: 0, color: "var(--text-2)", fontSize: "0.85rem" },
};
