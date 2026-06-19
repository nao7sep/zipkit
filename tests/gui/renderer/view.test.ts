/**
 * Tests for the renderer's pure view derivations (no React, no DOM). These pin
 * the behaviors the UI gates on: the per-job label, the exhaustive status/severity
 * color maps, the edit/terminal state predicates (a bug here would let a running
 * job be edited), the archive-and-trash manifest guard, and the formatters.
 */

import { describe, expect, it } from "vitest";
import {
  COLOR,
  containingDir,
  droppedEntries,
  formatEventLine,
  intentLabel,
  isEditable,
  isTerminal,
  jobCommands,
  label,
  manifestRequiredButMissing,
  orderedEntries,
  originalsPresent,
  severityColor,
  severityLabel,
  stateColor,
  stateLabel,
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
  it("shows a lone input's own name with extension", () => {
    expect(label(job({ inputs: ["/x/y/report.pdf"] }))).toBe("report.pdf");
    expect(label(job({ inputs: ["/x/y/photos"] }))).toBe("photos");
  });
  it("counts directories and files for multiple inputs (omitting a zero count)", () => {
    const j = job({
      inputs: ["/d1", "/d2", "/f1"],
      entries: [
        { path: "/d1", kind: "directory" },
        { path: "/d2", kind: "directory" },
        { path: "/f1", kind: "file" },
      ],
    });
    expect(label(j)).toBe("2 directories, 1 file");
    expect(
      label(job({ inputs: ["/f1", "/f2"], entries: [
        { path: "/f1", kind: "file" },
        { path: "/f2", kind: "file" },
      ] })),
    ).toBe("2 files");
  });
  it("falls back to an item count before classification resolves", () => {
    expect(label(job({ inputs: ["/a", "/b", "/c"] }))).toBe("3 items");
  });
  it("falls back when there are no inputs", () => {
    expect(label(job({ inputs: [] }))).toBe("(no input)");
  });
});

describe("orderedEntries", () => {
  it("orders directories first, then files, then missing/other; alpha within a group", () => {
    const entries = [
      { path: "/z/file-b.txt", kind: "file" as const },
      { path: "/a/dir-b", kind: "directory" as const },
      { path: "/gone", kind: "nonexistent" as const },
      { path: "/a/dir-a", kind: "directory" as const },
      { path: "/a/file-a.txt", kind: "file" as const },
    ];
    expect(orderedEntries(entries).map((e) => e.path)).toEqual([
      "/a/dir-a",
      "/a/dir-b",
      "/a/file-a.txt",
      "/z/file-b.txt",
      "/gone",
    ]);
  });
  it("does not mutate its input", () => {
    const entries = [
      { path: "/b", kind: "file" as const },
      { path: "/a", kind: "directory" as const },
    ];
    orderedEntries(entries);
    expect(entries.map((e) => e.path)).toEqual(["/b", "/a"]);
  });
});

describe("originalsPresent", () => {
  it("is true when any input still exists, false when all are gone", () => {
    expect(
      originalsPresent(job({ entries: [{ path: "/a", kind: "nonexistent" }, { path: "/b", kind: "file" }] })),
    ).toBe(true);
    expect(
      originalsPresent(job({ entries: [{ path: "/a", kind: "nonexistent" }] })),
    ).toBe(false);
  });
  it("assumes present when not yet classified", () => {
    expect(originalsPresent(job({ entries: undefined }))).toBe(true);
  });
});

describe("jobCommands", () => {
  it("offers trash-originals on a done save job only while originals remain", () => {
    const present = job({
      state: "done",
      intent: "save",
      entries: [{ path: "/a", kind: "file" }],
    });
    expect(jobCommands(present)).toContain("trash-originals");
    const gone = job({
      state: "done",
      intent: "save",
      entries: [{ path: "/a", kind: "nonexistent" }],
    });
    expect(jobCommands(gone)).not.toContain("trash-originals");
  });
  it("never offers trash-originals for archive-and-trash (it already trashed)", () => {
    expect(jobCommands(job({ state: "done", intent: "archive-and-trash" }))).not.toContain(
      "trash-originals",
    );
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
  it("tags only the noteworthy intent; the default save shows nothing", () => {
    expect(intentLabel("save")).toBe("");
    expect(intentLabel("archive-and-trash")).toBe("→ Trash");
  });
});

describe("stateLabel", () => {
  it("proper-cases every state (exhaustive, none left raw)", () => {
    expect(ALL_STATES.map(stateLabel)).toEqual([
      "Planning",
      "Needs attention",
      "Ready",
      "Running",
      "Done",
      "Failed",
    ]);
  });
});

describe("severityLabel", () => {
  it("proper-cases each severity", () => {
    expect(severityLabel("error")).toBe("Error");
    expect(severityLabel("warning")).toBe("Warning");
    expect(severityLabel("info")).toBe("Info");
  });
});

describe("containingDir", () => {
  it("returns the parent directory, normalizing separators", () => {
    expect(containingDir("/a/b/c.zip")).toBe("/a/b");
    expect(containingDir("C:\\x\\y\\z.zip")).toBe("C:/x/y");
  });
  it("is empty for a bare name, a root-level path, or no path", () => {
    expect(containingDir("c.zip")).toBe("");
    expect(containingDir("/c.zip")).toBe("");
    expect(containingDir(undefined)).toBe("");
  });
});

describe("verdictHeadline", () => {
  const plan = (over: Partial<PlanData["summary"]> & { writable: boolean }): PlanData => {
    const { writable, ...summary } = over;
    return {
      writable,
      summary: { included: 0, excluded: 0, warnings: 0, errors: 0, ...summary },
    } as unknown as PlanData;
  };
  it("is factual and context-aware, never a vague 'safe' claim", () => {
    expect(verdictHeadline(plan({ writable: true }))).toBe("Ready to archive");
    expect(verdictHeadline(plan({ writable: true, warnings: 1 }))).toBe("Ready · 1 warning");
    expect(verdictHeadline(plan({ writable: true, warnings: 3 }))).toBe("Ready · 3 warnings");
    expect(verdictHeadline(plan({ writable: false, errors: 1 }))).toBe("1 blocking issue");
    expect(verdictHeadline(plan({ writable: false, errors: 4 }))).toBe("4 blocking issues");
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
  it("on done, offers remove-archive (and trash-originals last) only for the save intent", () => {
    // With originals still present (entries with a file), a save job offers both;
    // trash-originals is ordered last so the bar can seat it at the far-right end.
    expect(
      jobCommands(job({ state: "done", intent: "save", entries: [{ path: "/a", kind: "file" }] })),
    ).toEqual(["verify", "reveal", "remove-archive", "trash-originals"]);
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
