/**
 * The selected job's lifecycle commands — a button row inside the operation
 * (Archive) pane, beside the intent and target, since these are all
 * operation-related. It renders the commands the job's state allows (from the
 * pure `jobCommands` map) and reports the chosen one; the parent performs it.
 * When a job is blocked (`needs-attention`) there are no commands, and the bar
 * shows nothing: the control panel's digest already says why.
 */

import { useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { Job } from "../../../shared/api";
import { jobCommands, type JobCommand } from "../view";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "../../../shared/i18n/catalogues";

const LABEL: Record<JobCommand, MessageKey> = {
  create: "command.create",
  retry: "command.retry",
  cancel: "command.cancel",
  verify: "command.verify",
  reveal: "command.reveal",
  "trash-originals": "command.trashOriginals",
  "delete-originals": "command.deleteOriginals",
  "remove-archive": "command.removeArchive",
};

const CLASS: Partial<Record<JobCommand, string>> = {
  create: "accent",
  retry: "accent",
  "trash-originals": "danger",
  "delete-originals": "danger",
  "remove-archive": "danger",
};

export function CommandBar({ job, onCommand }: { job: Job; onCommand: (c: JobCommand) => void }) {
  const { t } = useI18n();
  const commands = jobCommands(job);
  // The destructive commands take a row of their own below the everyday ones,
  // from its start, so a Trash or Delete click is deliberate, not a slip, and
  // neither row wraps into the other.
  const everyday = commands.filter((c) => CLASS[c] !== "danger");
  const destructive = commands.filter((c) => CLASS[c] === "danger");

  // Focus follows the workflow (focus/selection policy). When a button the user was
  // on unmounts because the job advanced (Create -> running, Move archive to Trash -> back
  // through planning to ready), the browser drops focus to <body>. We act only when
  // the command SET changes AND focus has fallen to the body — i.e. exactly when a
  // button just unmounted from under focus — and pull it to the bar's new primary
  // (falling back to the bar itself when the job is blocked and offers none).
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
    // offers no button to land on); it never becomes a tab stop.
    // It draws no ring when it does: the focus is a place to stand, not a control,
    // and the key that led here would light one around the whole bar.
    <div ref={barRef} tabIndex={-1} style={{ ...(commands.length > 0 ? S.bar : null), outline: "none" }}>
      {[everyday, destructive].filter((row) => row.length > 0).map((row, i) => (
        <div key={i} style={S.row}>
          {row.map((c) => (
            <button key={c} className={CLASS[c]} onClick={() => onCommand(c)}>
              {t(LABEL[c])}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  bar: { display: "grid", gap: "0.5rem", marginTop: "0.85rem" },
  row: { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" },
};
