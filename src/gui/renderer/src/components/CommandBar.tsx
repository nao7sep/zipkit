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

  // Focus follows the workflow (focus/selection policy). When the user activates a
  // command whose button then unmounts because the job advanced (Create -> the
  // job is running, Remove archive -> back to ready), the browser would drop focus
  // to <body>. Instead, pull it to the bar's new primary action so keyboard focus
  // is never stranded. Commands that leave the set unchanged (Verify, Reveal) keep
  // focus on the same button. The activation is remembered in a ref so it survives
  // the confirm dialog that some commands raise (focus enters/leaves the dialog in
  // between). A no-op activation (e.g. a cancelled confirm) is cleared once focus
  // settles back in the bar, so it can never steal focus later.
  const barRef = useRef<HTMLDivElement>(null);
  const activated = useRef<JobCommand | null>(null);
  useLayoutEffect(() => {
    const c = activated.current;
    if (!c) return;
    const bar = barRef.current;
    if (!bar) return;
    if (commands.includes(c)) {
      // The activated button still exists; if focus has settled back onto it (or
      // anywhere in the bar) the action resolved with focus intact — done.
      if (bar.contains(document.activeElement)) activated.current = null;
      return;
    }
    // The activated button is gone: move focus to the new primary action.
    activated.current = null;
    bar.querySelector<HTMLButtonElement>("button")?.focus();
  });

  function activate(c: JobCommand) {
    activated.current = c;
    onCommand(c);
  }

  return (
    <div ref={barRef} style={S.bar}>
      {commands.length === 0 ? (
        <span style={S.hint}>{job.message ?? "Resolve the blocking issues to create this archive."}</span>
      ) : (
        commands.map((c, i) => (
          <button
            key={c}
            className={CLASS[c]}
            style={i === firstDanger ? S.pushRight : undefined}
            onClick={() => activate(c)}
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
