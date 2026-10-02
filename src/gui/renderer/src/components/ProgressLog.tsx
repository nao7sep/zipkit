/**
 * The Progress log: the selected job's SDK events, recorded and live, shown in the
 * Progress pane. Each SDK run (a plan, a write, a verify) shows its start time
 * once and its lines below, and a run's findings fold into one line per kind
 * (`progressRuns` in view), so nothing repeats on every line of the narrow pane.
 * Only a line worth stopping at carries its level, in its status colour and bold.
 * It follows the tail — when the user is at (or within a small threshold of) the
 * bottom, new lines auto-scroll into view; when the user has scrolled up to read
 * history, it leaves the viewport alone. Mirrors ScriptDock's console.
 *
 * Two robustness rules matter: a log SHORTER than its pane has no real overflow,
 * so it is "at the bottom" by definition and must never be read as scrolled-up;
 * and a zero-height (not-yet-laid-out) measurement is ignored rather than trusted.
 * The threshold is a pixel distance, not a line count, so it is font-independent.
 */

import { useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { JobEvent } from "../../../shared/api";
import { logLevelColor, logLevelLabel, progressLineText, progressRuns, progressTime } from "../view";
import { useI18n } from "../i18n/I18nContext";

// "Near the bottom" tolerance, in pixels (ScriptDock uses 24).
const PIN_THRESHOLD_PX = 24;

export function ProgressLog({ events }: { events: JobEvent[] }) {
  const t = useI18n();
  const ref = useRef<HTMLDivElement>(null);
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

  const runs = progressRuns(events);
  if (runs.length === 0) return <p style={S.empty}>{t.t("progress.empty")}</p>;
  return (
    <div
      ref={ref}
      role="region"
      aria-label={t.t("progress.region")}
      aria-live="off"
      tabIndex={0}
      style={S.log}
      onScroll={onScroll}
    >
      {runs.map((run) => (
        <section key={run.key} style={S.run}>
          <div style={S.time}>{progressTime(run, t)}</div>
          {run.lines.map((line, index) => {
            const loud = line.level === "warn" || line.level === "error";
            return (
              <div key={index} style={S.line}>
                {loud && (
                  <span style={{ ...S.level, color: logLevelColor(line.level) }}>{t.t(logLevelLabel(line.level))}</span>
                )}
                {progressLineText(line, t)}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  // The log is the sole scroll container (flex-fills its flex-column pane body),
  // so its scrollHeight/scrollTop are unambiguous and the tail-follow works.
  log: {
    margin: 0,
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    fontSize: "0.8rem",
    fontFamily: "var(--font-mono)",
  },
  run: { margin: "0 0 0.6rem" },
  // The run's start time heads it once, quiet, so the lines keep the reading colour.
  time: { color: "var(--text-2)", marginBottom: "0.15rem" },
  line: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
  level: { fontWeight: 700, marginInlineEnd: "0.6em" },
  empty: { margin: 0, color: "var(--text-2)", fontSize: "0.85rem" },
};
