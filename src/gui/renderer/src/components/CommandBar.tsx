/**
 * The selected job's lifecycle commands — a button row inside the operation
 * (Archive) pane, beside the intent and target, since these are all
 * operation-related. It renders the commands the job's state allows (from the
 * pure `jobCommands` map) and reports the chosen one; the parent performs it.
 * When a job is blocked (`needs-attention`) there are no commands, so it shows
 * why instead.
 */

import { useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { Job } from "../../../shared/api";
import { jobCommands, type JobCommand } from "../view";

const LABEL: Record<JobCommand, string> = {
  create: "Create archive",
  retry: "Try again",
  cancel: "Cancel",
  verify: "Verify",
  reveal: "Reveal in file manager",
  "trash-originals": "Move originals to Trash",
  "remove-archive": "Remove archive",
};

const CLASS: Partial<Record<JobCommand, string>> = {
  create: "accent",
  retry: "accent",
  "trash-originals": "danger",
  "remove-archive": "danger",
};

export function CommandBar({ job, onCommand }: { job: Job; onCommand: (c: JobCommand) => void }) {
  const commands = jobCommands(job);
  // Seat the destructive group at the far-right end (an auto left-margin on the
  // first danger button pushes it and the rest right), away from the everyday
  // buttons, so a Trash/Remove click is deliberate, not a slip.
  const firstDanger = commands.findIndex((c) => CLASS[c] === "danger");

  // Focus follows the workflow (focus/selection policy). When a button the user was
  // on unmounts because the job advanced (Create -> running, Remove archive -> back
  // through planning to ready), the browser drops focus to <body>. We act only when
  // the command SET changes AND focus has fallen to the body — i.e. exactly when a
  // button just unmounted from under focus — and pull it to the bar's new primary
  // (falling back to the bar itself when the job is blocked and shows only a hint).
  // Two properties make this robust where the obvious approaches break:
  //  - It triggers on the set change, not on a prior render, so it works for a
  //    keyboard user who tabbed to a button (no render happened while focused).
  //  - It refocuses ONLY from <body>, so it never yanks focus out of a dialog or
  //    another pane, and it naturally survives the confirm dialog + Radix's
  //    focus-restore (the steal would only happen on the later running transition,
  //    where focus is genuinely on the body). It chains across the intermediate
  //    states one action passes through, each being its own set change.
  // The cmdKey-value compare (not a run counter) keeps it correct under StrictMode's
  // double-invoked effects and skips the initial mount, so selecting a job never
  // grabs focus.
  const barRef = useRef<HTMLDivElement>(null);
  const cmdKey = commands.join("|");
  const prevKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const changed = prevKey.current !== null && prevKey.current !== cmdKey;
    prevKey.current = cmdKey;
    if (!changed) return;
    const bar = barRef.current;
    if (!bar) return;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      (bar.querySelector<HTMLButtonElement>("button") ?? bar).focus();
    }
  }, [cmdKey]);

  return (
    // tabIndex -1 so the bar itself can hold focus as a last resort (a blocked job
    // shows only a hint with no button to land on); it never becomes a tab stop.
    <div ref={barRef} tabIndex={-1} style={S.bar}>
      {commands.length === 0 ? (
        <span style={S.hint}>{job.message ?? "Resolve the blocking issues to create this archive."}</span>
      ) : (
        commands.map((c, i) => (
          <button
            key={c}
            className={CLASS[c]}
            style={i === firstDanger ? S.pushRight : undefined}
            onClick={() => onCommand(c)}
          >
            {LABEL[c]}
          </button>
        ))
      )}
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    flexWrap: "wrap",
    marginTop: "0.85rem",
  },
  hint: { color: "var(--text-2)", fontSize: "0.85rem" },
  pushRight: { marginLeft: "auto" },
};
