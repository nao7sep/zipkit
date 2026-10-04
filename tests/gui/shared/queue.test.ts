/**
 * The editability rule the engine and the renderer both read. It sits in `shared`
 * because a second spelling of it is what let a finished job keep taking writes:
 * the pane disabled its controls while the engine still accepted the edit.
 */

import { describe, expect, it } from "vitest";
import { isEditable, type JobState } from "../../../src/gui/shared/queue.js";

const ALL_STATES: JobState[] = [
  "planning",
  "needs-attention",
  "ready",
  "queued",
  "running",
  "done",
  "failed",
];

describe("isEditable", () => {
  it("locks a job that is committed to run or already finished", () => {
    // queued is locked (committed to run); cancelling it returns it to editable.
    // failed stays editable — a fresh attempt is the whole point of the state —
    // unless its archive was written (below).
    expect(ALL_STATES.filter((state) => isEditable({ state }))).toEqual(["planning", "needs-attention", "ready", "failed"]);
  });

  it("locks a failed job whose archive was written, like a done one", () => {
    expect(isEditable({ state: "failed", archiveWritten: true })).toBe(false);
    expect(isEditable({ state: "failed", archiveWritten: false })).toBe(true);
  });
});
