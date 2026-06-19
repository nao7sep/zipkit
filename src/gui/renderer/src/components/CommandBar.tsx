/**
 * The selected job's lifecycle commands — a button row inside the operation
 * (Archive) pane, beside the intent and target, since these are all
 * operation-related. It renders the commands the job's state allows (from the
 * pure `jobCommands` map) and reports the chosen one; the parent performs it.
 * When a job is blocked (`needs-attention`) there are no commands, so it shows
 * why instead.
 */

import type { CSSProperties } from "react";
import type { Job } from "../../../shared/api";
import { jobCommands, type JobCommand } from "../view";

const LABEL: Record<JobCommand, string> = {
  create: "Create archive",
  retry: "Try again",
  cancel: "Cancel",
  verify: "Verify",
  reveal: "Reveal in folder",
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
  return (
    <div style={S.bar}>
      {commands.length === 0 ? (
        <span style={S.hint}>{job.message ?? "Resolve the blocking issues to create this archive."}</span>
      ) : (
        commands.map((c) => (
          <button key={c} className={CLASS[c]} onClick={() => onCommand(c)}>
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
};
