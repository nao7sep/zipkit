/**
 * The selected job's lifecycle command bar — a slim, always-visible strip between
 * the Archive (parameters) pane and the job's output below. It renders the
 * commands the job's state allows (from the pure `jobCommands` map) and reports
 * the chosen one; the parent performs it. When a job is blocked
 * (`needs-attention`) there are no commands, so the bar shows why instead.
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
  "remove-archive": "Remove archive",
};

const CLASS: Partial<Record<JobCommand, string>> = {
  create: "accent",
  retry: "accent",
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
    flexShrink: 0,
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    flexWrap: "wrap",
    padding: "0.5rem 0.75rem",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
  },
  hint: { color: "var(--text-2)", fontSize: "0.85rem" },
};
