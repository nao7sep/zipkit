/**
 * The Progress log: the live SDK event stream for the selected job, shown in the
 * Progress pane. The events arrive as the SDK's typed union, so the log paints
 * each part rather than printing one flat string: the stamp quiet, the level in
 * its status colour and bold where it is worth stopping at, the message in the
 * reading colour. Each line is still one line of text, so selecting and copying
 * the log yields exactly what it shows. It follows the tail — when the user is at (or within a small
 * threshold of) the bottom, new lines auto-scroll into view; when the user has
 * scrolled up to read history, it leaves the viewport alone. Mirrors ScriptDock's
 * console.
 *
 * Two robustness rules matter: a log SHORTER than its pane has no real overflow,
 * so it is "at the bottom" by definition and must never be read as scrolled-up;
 * and a zero-height (not-yet-laid-out) measurement is ignored rather than trusted.
 * The threshold is a pixel distance, not a line count, so it is font-independent.
 */

import { useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { LogEvent } from "../../../shared/api";
import { eventLineParts, logLevelColor, logLevelLabel } from "../view";

// "Near the bottom" tolerance, in pixels (ScriptDock uses 24).
const PIN_THRESHOLD_PX = 24;

// The level column is as wide as the longest level word, so the messages start
// at one column and the log reads as a table rather than a ragged edge. Derived
// from the labels themselves: a renamed level cannot leave the column stale.
const LEVEL_WIDTH = Math.max(
  ...(["debug", "info", "warn", "error"] as LogEvent["level"][]).map((level) => logLevelLabel(level).length),
);

export function ProgressLog({ events }: { events: LogEvent[] }) {
  const ref = useRef<HTMLPreElement>(null);
  // Whether the user is currently following the tail. Starts pinned; updated on
  // every manual scroll, read (synchronously, before paint) after each new batch.
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  function onScroll() {
    const el = ref.current;
    if (!el || el.clientHeight === 0) return; // ignore transient/unlaid-out measurements
    // No real overflow -> at the bottom by definition (a short log is never
    // "scrolled up"); otherwise follow only when near the bottom.
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    pinned.current = el.scrollHeight <= el.clientHeight || distanceFromBottom <= PIN_THRESHOLD_PX;
  }

  if (events.length === 0) return <p style={S.empty}>Nothing to show yet.</p>;
  return (
    <pre
      ref={ref}
      role="region"
      aria-label="Progress log"
      aria-live="off"
      tabIndex={0}
      style={S.log}
      onScroll={onScroll}
    >
      {events.map((event, index) => {
        const { time, level, message } = eventLineParts(event);
        const loud = event.level === "warn" || event.level === "error";
        return (
          <span key={index}>
            <span style={S.time}>{time}</span>
            {"  "}
            <span style={{ color: logLevelColor(event.level), fontWeight: loud ? 700 : 400 }}>
              {level.padEnd(LEVEL_WIDTH)}
            </span>
            {"  "}
            {message}
            {index < events.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </pre>
  );
}

const S: Record<string, CSSProperties> = {
  // The <pre> is the sole scroll container (flex-fills its flex-column pane body),
  // so its scrollHeight/scrollTop are unambiguous and the tail-follow works.
  log: {
    margin: 0,
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    fontSize: "0.8rem",
    fontFamily: "var(--font-mono)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  // The stamp is the same on nearly every line, so it stays quiet and the
  // message keeps the reading colour.
  time: { color: "var(--text-2)" },
  empty: { margin: 0, color: "var(--text-2)", fontSize: "0.85rem" },
};
