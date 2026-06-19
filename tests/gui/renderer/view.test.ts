/**
 * Tests for the renderer's pure view derivations (no React, no DOM). These pin
 * the behaviors the UI gates on: the per-job label, the exhaustive status/severity
 * color maps, the edit/terminal state predicates (a bug here would let a running
 * job be edited), the archive-and-trash manifest guard, and the formatters.
 */

import { describe, expect, it } from "vitest";
import {
  COLOR,
  droppedEntries,
  formatEventLine,
  intentLabel,
  isEditable,
  isTerminal,
  jobCommands,
  label,
  manifestRequiredButMissing,
  severityColor,
  stateColor,
  verdictHeadline,
  verifySummary,
} from "../../../src/gui/renderer/src/view";
import type { ExtractData, Job, LogEvent, PlanData } from "../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec";

const job = (over: Partial<Job> = {}): Job => ({
  id: "j",
  inputs: ["/a/b/c"],
  options: DEFAULT_OPTIONS,
  intent: "save",
  state: "ready",
  ...over,
});

const ALL_STATES: Job["state"][] = ["planning", "needs-attention", "ready", "running", "done", "failed"];

describe("label", () => {
  it("uses the first input's basename", () => {
    expect(label(job({ inputs: ["/x/y/photos"] }))).toBe("photos");
  });
  it("appends +N for extra inputs", () => {
    expect(label(job({ inputs: ["/x/a", "/x/b", "/x/c"] }))).toBe("a +2");
  });
  it("falls back when there are no inputs", () => {
    expect(label(job({ inputs: [] }))).toBe("(no input)");
  });
});

describe("stateColor", () => {
  it("maps every job state to a distinct palette color", () => {
    const colors = ALL_STATES.map(stateColor);
    expect(colors.every((c) => c.startsWith("#"))).toBe(true);
    expect(new Set(colors).size).toBe(ALL_STATES.length);
  });
});

describe("severityColor", () => {
  it("maps each severity tier", () => {
    expect(severityColor("error")).toBe(COLOR.bad);
    expect(severityColor("warning")).toBe(COLOR.warn);
    expect(severityColor("info")).toBe(COLOR.info);
  });
});

describe("isEditable / isTerminal", () => {
  it("is editable until the job runs or completes", () => {
    expect(ALL_STATES.filter(isEditable)).toEqual(["planning", "needs-attention", "ready", "failed"]);
  });
  it("is terminal only when done or failed", () => {
    expect(ALL_STATES.filter(isTerminal)).toEqual(["done", "failed"]);
  });
});

describe("manifestRequiredButMissing", () => {
  it("warns only for archive-and-trash without the manifest", () => {
    expect(manifestRequiredButMissing("archive-and-trash", false)).toBe(true);
    expect(manifestRequiredButMissing("archive-and-trash", true)).toBe(false);
    expect(manifestRequiredButMissing("save", false)).toBe(false);
  });
});

describe("intentLabel", () => {
  it("labels the two intents", () => {
    expect(intentLabel("save")).toBe("save");
    expect(intentLabel("archive-and-trash")).toBe("→ Trash");
  });
});

describe("verdictHeadline", () => {
  it("reads the writable gate", () => {
    expect(verdictHeadline({ writable: true } as unknown as PlanData)).toContain("Windows-safe");
    expect(verdictHeadline({ writable: false } as unknown as PlanData)).toBe("Blocking issues");
  });
});

describe("droppedEntries", () => {
  it("keeps only the excluded entries", () => {
    const plan = {
      entries: [
        { archivePath: "a", excluded: false },
        { archivePath: "b", excluded: true },
      ],
    } as unknown as PlanData;
    expect(droppedEntries(plan).map((e) => e.archivePath)).toEqual(["b"]);
  });
});

describe("formatEventLine", () => {
  it("renders a local ISO-ish time, then level and message", () => {
    // The time is rendered in the viewer's local zone, so assert the shape
    // (yyyy-mm-dd hh:mm:ss) rather than an exact value that would vary by zone.
    const e = { time: "2026-06-14T05:00:00.000Z", level: "info", message: "hi" } as unknown as LogEvent;
    expect(formatEventLine(e)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  info  hi$/);
  });
  it("falls back to the raw value when the time cannot be parsed", () => {
    const e = { time: "not-a-time", level: "warn", message: "x" } as unknown as LogEvent;
    expect(formatEventLine(e)).toBe("not-a-time  warn  x");
  });
});

describe("jobCommands", () => {
  it("offers create only when ready, and nothing when blocked", () => {
    expect(jobCommands(job({ state: "ready" }))).toEqual(["create"]);
    expect(jobCommands(job({ state: "needs-attention" }))).toEqual([]);
  });
  it("offers cancel while planning or running", () => {
    expect(jobCommands(job({ state: "planning" }))).toEqual(["cancel"]);
    expect(jobCommands(job({ state: "running" }))).toEqual(["cancel"]);
  });
  it("offers retry on failure", () => {
    expect(jobCommands(job({ state: "failed" }))).toEqual(["retry"]);
  });
  it("on done, offers remove-archive only for the save intent", () => {
    expect(jobCommands(job({ state: "done", intent: "save" }))).toEqual([
      "verify",
      "reveal",
      "remove-archive",
    ]);
    expect(jobCommands(job({ state: "done", intent: "archive-and-trash" }))).toEqual([
      "verify",
      "reveal",
    ]);
  });
});

describe("verifySummary", () => {
  it("summarizes the verify counts", () => {
    const data = { summary: { total: 10, crcFailed: 1, shaMismatched: 2 } } as unknown as ExtractData;
    expect(verifySummary(data)).toBe("10 entries, 1 CRC failure(s), 2 SHA mismatch(es)");
  });
});
