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
  eventLineParts,
  humanSentence,
  intentLabel,
  isCancelable,
  isTerminal,
  jobCommands,
  label,
  logLevelColor,
  logLevelLabel,
  jobAdvisories,
  manifestRequiredButMissing,
  orderedEntries,
  originalsPresent,
  outputPreview,
  planReport,
  progressMessage,
  reportSummary,
  severityColor,
  stateColor,
  stateLabel,
  verifySummary,
} from "../../../src/gui/renderer/src/view";
import type { ExtractData, Job, LogEvent, PlanData } from "../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec";
import { createTranslator, message } from "../../../src/gui/shared/i18n/translate";

const en = createTranslator("en");

const job = (over: Partial<Job> = {}): Job => ({
  id: "j",
  inputs: ["/a/b/c"],
  options: DEFAULT_OPTIONS,
  intent: "save",
  state: "ready",
  ...over,
});

const ALL_STATES: Job["state"][] = [
  "planning",
  "needs-attention",
  "ready",
  "queued",
  "running",
  "done",
  "failed",
];

describe("label", () => {
  it("shows a lone input's own name with extension", () => {
    expect(label(job({ inputs: ["/x/y/report.pdf"] }), en)).toBe("report.pdf");
    expect(label(job({ inputs: ["/x/y/photos"] }), en)).toBe("photos");
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
    expect(label(j, en)).toBe("2 directories, 1 file");
    expect(
      label(job({ inputs: ["/f1", "/f2"], entries: [
        { path: "/f1", kind: "file" },
        { path: "/f2", kind: "file" },
      ] }), en),
    ).toBe("2 files");
  });
  it("falls back to an item count before classification resolves", () => {
    expect(label(job({ inputs: ["/a", "/b", "/c"] }), en)).toBe("3 items");
  });
  it("falls back when there are no inputs", () => {
    expect(label(job({ inputs: [] }), en)).toBe("(no input)");
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

describe("outputPreview", () => {
  it("prefers the resolved output (split into dir + name)", () => {
    const j = job({ state: "ready", output: "/out/dir/report.zip" });
    expect(outputPreview(j, DEFAULT_OPTIONS, en)).toEqual({ dir: "/out/dir", name: "report.zip" });
  });
  it("falls back to the user's typed values when not yet resolved", () => {
    const j = job({ state: "needs-attention", inputs: ["/a/b/c"] });
    expect(outputPreview(j, { ...DEFAULT_OPTIONS, outputDir: "/picked", fileName: "mine" }, en)).toEqual({
      dir: "/picked",
      name: "mine",
    });
  });
  it("says 'resolving…' for the name only while planning, never claims planning when blocked", () => {
    const planning = job({ state: "planning", inputs: ["/a/b/c"] });
    expect(outputPreview(planning, DEFAULT_OPTIONS, en).name).toBe("Resolving…");
    const blocked = job({ state: "needs-attention", inputs: ["/a/x", "/b/y"] });
    expect(outputPreview(blocked, DEFAULT_OPTIONS, en).name).toBe("(set a file name)");
  });
  it("defaults the directory to the first input's parent, else a clear placeholder", () => {
    expect(outputPreview(job({ state: "ready", inputs: ["/a/b/c"] }), DEFAULT_OPTIONS, en).dir).toBe("/a/b");
    expect(outputPreview(job({ state: "ready", inputs: ["bare"] }), DEFAULT_OPTIONS, en).dir).toBe(
      "(beside the input)",
    );
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
    // Theme tokens (index.css), so each state follows the light or dark theme.
    expect(colors.every((c) => c.startsWith("var(--status-"))).toBe(true);
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

describe("isTerminal / isCancelable", () => {
  it("is terminal only when done or failed", () => {
    expect(ALL_STATES.filter(isTerminal)).toEqual(["done", "failed"]);
  });
  it("is cancelable while planning, queued, or running", () => {
    expect(ALL_STATES.filter(isCancelable)).toEqual(["planning", "queued", "running"]);
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
    expect(intentLabel("save", en)).toBe("");
    expect(intentLabel("archive-and-trash", en)).toBe("→ Trash");
  });
});

describe("stateLabel", () => {
  it("proper-cases every state (exhaustive, none left raw)", () => {
    expect(ALL_STATES.map((state) => en.t(stateLabel(state)))).toEqual([
      "Planning",
      "Needs attention",
      "Ready",
      "Queued",
      "Running",
      "Done",
      "Failed",
    ]);
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

describe("reportSummary", () => {
  const planOf = (over: Partial<PlanData["summary"]> & { writable: boolean }): PlanData => {
    const { writable, ...summary } = over;
    return {
      writable,
      summary: { included: 0, excluded: 0, renamed: 0, warnings: 0, errors: 0, ...summary },
    } as unknown as PlanData;
  };
  it("speaks to the job's actual state, never a vague 'safe' claim", () => {
    expect(reportSummary(job({ state: "failed", message: message("job.writeFailed") }), null, en)?.text).toBe(
      "The archive could not be written. Check the output location and available storage, then try again.",
    );
    expect(reportSummary(job({ state: "done" }), planOf({ writable: true, included: 3 }), en)).toEqual({
      level: "info",
      text: "Archived 3 items.",
    });
    expect(
      reportSummary(job({ state: "needs-attention" }), planOf({ writable: false, errors: 2 }), en)?.text,
    ).toBe("2 blocking issues must be resolved before this can be archived.");
    expect(reportSummary(job({ state: "ready" }), planOf({ writable: true, included: 1 }), en)).toEqual({
      level: "info",
      text: "1 item ready to archive.",
    });
    expect(
      reportSummary(
        job({ state: "ready" }),
        planOf({ writable: true, included: 5, renamed: 2, excluded: 1, warnings: 1 }),
        en,
      ),
    ).toEqual({
      level: "warning",
      text: "5 items ready to archive (2 renamed for portability, 1 excluded, 1 warning).",
    });
  });
  it("surfaces a blocked job's message even when the plan threw (no structured plan)", () => {
    // Regression: a plan that throws (e.g. inputs in different folders) leaves
    // plan === null; the captured error must still reach the user, never be swallowed.
    expect(
      reportSummary(job({ state: "needs-attention", message: message("job.prepareFailed") }), null, en),
    ).toEqual({
      level: "error",
      text: "This job could not be prepared. Check that its inputs are still available, then try again.",
    });
  });
  it("prefers friendly guidance keyed on the SDK error code over the raw message", () => {
    const line = reportSummary(
      job({
        state: "needs-attention",
        errorCode: "output.ambiguous",
        message: message("job.prepareFailed"),
      }),
      null,
      en,
    );
    expect(line?.level).toBe("error");
    expect(line?.text).toContain("different folders");
    expect(line?.text).toContain("Set a file name");
  });
  it("falls back to the job's own message for an unmapped error code", () => {
    expect(
      reportSummary(job({ state: "needs-attention", errorCode: "write.failed", message: message("job.prepareFailed") }), null, en)
        ?.text,
    ).toContain("could not be prepared");
  });
  it("returns null only while planning (nothing to report yet)", () => {
    expect(reportSummary(job({ state: "planning" }), null, en)).toBeNull();
  });
  it("speaks the reader's language, with each count in its own plural form", () => {
    const ru = createTranslator("ru");
    const plan = planOf({ writable: true, included: 5, renamed: 2, warnings: 1 });
    const text = reportSummary(job({ state: "ready" }), plan, ru)!.text;
    expect(text).not.toMatch(/[A-Za-z]{3,}/);
    expect(text).not.toContain("{");
  });
});

describe("jobAdvisories", () => {
  it("warns when the lone input is already a .zip file", () => {
    const j = job({ inputs: ["/x/foo.zip"], entries: [{ path: "/x/foo.zip", kind: "file" }] });
    const lines = jobAdvisories(j, en);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("warning");
    expect(lines[0]!.text).toContain("already a .zip");
  });
  it("does not warn for a directory, a non-zip file, or multiple inputs", () => {
    expect(jobAdvisories(job({ inputs: ["/x/foo.zip"], entries: [{ path: "/x/foo.zip", kind: "directory" }] }), en)).toEqual([]);
    expect(jobAdvisories(job({ inputs: ["/x/notes.txt"], entries: [{ path: "/x/notes.txt", kind: "file" }] }), en)).toEqual([]);
    expect(
      jobAdvisories(
        job({
          inputs: ["/x/a.zip", "/x/b.zip"],
          entries: [
            { path: "/x/a.zip", kind: "file" },
            { path: "/x/b.zip", kind: "file" },
          ],
        }),
        en,
      ),
    ).toEqual([]);
  });
});

describe("planReport", () => {
  it("renders findings as severity-tagged lines, most-severe first, with renames showing the new name", () => {
    const plan = {
      findings: [
        { rule: "name.nfd", severity: "info", path: "a/café", message: "name normalized from NFD to NFC", fix: { kind: "rename", to: "café" } },
        { rule: "collision.case", severity: "error", path: "b/X", message: "case-only collision" },
        { rule: "macos.junk", severity: "info", path: "a/.DS_Store", message: "excluded by the junk preset" },
      ],
      entries: [],
    } as unknown as PlanData;
    const lines = planReport(plan, en);
    expect(lines[0]).toEqual({
      level: "error",
      text: "The path differs from another only by case, so the two collide on case-insensitive file systems",
      path: "b/X",
    });
    expect(lines[1]).toEqual({
      level: "info",
      text: "Name normalized from NFD to NFC → café",
      path: "a/café",
    });
    expect(lines[2]?.text).toBe("Excluded by the junk preset");
  });
  it("reads a name finding as repaired only when the SDK gave it a rename target", () => {
    const plan = {
      findings: [{ rule: "name.reserved", severity: "error", path: "CON", message: "name is a reserved device name" }],
      entries: [],
    } as unknown as PlanData;
    expect(planReport(plan, en)[0]?.text).toBe("The name is a reserved device name");
  });
  it("tells a kept symlink from an ignored one by whether the plan excluded it", () => {
    const plan = {
      findings: [
        { rule: "entry.symlink", severity: "warning", path: "kept", message: "symlink preserved" },
        { rule: "entry.symlink", severity: "warning", path: "dropped", message: "symlink ignored" },
      ],
      entries: [
        { archivePath: "kept", excluded: false },
        { archivePath: "dropped", excluded: true, excludeReason: "symlink ignored" },
      ],
    } as unknown as PlanData;
    expect(planReport(plan, en).map((line) => line.text)).toEqual([
      "Symlink kept as a Unix link entry; Windows extracts it as a text file",
      "Symlink ignored",
    ]);
  });
  it("shows a rule the GUI does not know as the SDK wrote it", () => {
    const plan = {
      findings: [{ rule: "future.rule", severity: "warning", path: "x", message: "something new" }],
      entries: [],
    } as unknown as PlanData;
    expect(planReport(plan, en)[0]?.text).toBe("Something new");
  });
  it("surfaces an excluded entry that has no finding (custom exclude, pruned empty dir)", () => {
    const plan = {
      findings: [],
      entries: [
        { archivePath: "keep.txt", excluded: false },
        { archivePath: "build/", excluded: true, excludeReason: "exclude rule: build/" },
        { archivePath: "empty/", excluded: true, excludeReason: "empty directory pruned" },
      ],
    } as unknown as PlanData;
    expect(planReport(plan, en)).toEqual([
      { level: "info", text: "Excluded: exclude rule: build/", path: "build/" },
      { level: "info", text: "Empty directory pruned", path: "empty/" },
    ]);
  });
});

describe("eventLineParts", () => {
  it("renders the local time in the locale's format, then a human level and message", () => {
    // The time is rendered in the viewer's local zone, so assert the shape
    // (a short date, then the time to the second) rather than an exact value.
    const e = { time: "2026-06-14T05:00:00.000Z", level: "info", event: "scan.dir", path: "/x", message: "scanning /x" } as unknown as LogEvent;
    expect(eventLineParts(e, createTranslator("en", "en-US"))).toEqual({
      time: expect.stringMatching(/^\d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2}:\d{2}\s?[AP]M$/),
      level: "Info",
      message: "Scanning /x",
    });
    expect(eventLineParts(e, createTranslator("de")).time).toMatch(/^\d{2}\.\d{2}\.\d{2}, \d{2}:\d{2}:\d{2}$/);
  });
  it("falls back to the raw value when the time cannot be parsed", () => {
    const e = { time: "not-a-time", level: "warn", event: "scan.dir", path: "x", message: "scanning x" } as unknown as LogEvent;
    expect(eventLineParts(e, en)).toEqual({ time: "not-a-time", level: "Warning", message: "Scanning x" });
  });
  it("paints only the levels worth stopping at, and keeps the rest quiet", () => {
    expect(logLevelColor("error")).toBe("var(--status-error)");
    expect(logLevelColor("warn")).toBe("var(--status-warning)");
    expect(logLevelColor("info")).toBe("var(--text-2)");
    expect(logLevelColor("debug")).toBe("var(--text-2)");
  });
});

describe("progress presentation", () => {
  it("labels every machine log level without leaking raw values", () => {
    expect((["debug", "info", "warn", "error"] as LogEvent["level"][]).map((level) => en.t(logLevelLabel(level)))).toEqual([
      "Debug",
      "Info",
      "Warning",
      "Error",
    ]);
  });

  it("renders from the typed fields, proper-casing ZipKit and ZIP64, without mutating the event message", () => {
    const start = {
      time: "2026-06-14T05:00:00.000Z",
      level: "info",
      event: "session.start",
      version: "0.1.0",
      concurrency: 2,
      chunkSize: 1024,
      message: "zipkit 0.1.0 (concurrency 2, chunk 1024 bytes)",
    } as LogEvent;
    const written = {
      time: start.time,
      level: "info",
      event: "write.done",
      bytes: 12,
      zip64: true,
      message: "archive written: 12 bytes (zip64)",
    } as LogEvent;

    expect(progressMessage(start, en)).toBe("ZipKit 0.1.0 (concurrency 2, chunk 1,024 bytes)");
    expect(progressMessage(written, en)).toBe("Archive written: 12 bytes (ZIP64)");
    expect(start.message).toBe("zipkit 0.1.0 (concurrency 2, chunk 1024 bytes)");
    expect(written.message).toBe("archive written: 12 bytes (zip64)");
  });

  it("uses the typed finding fields instead of exposing a raw severity prefix", () => {
    const event = {
      time: "2026-06-14T05:00:00.000Z",
      level: "warn",
      event: "entry.flagged",
      rule: "name.reserved",
      path: "CON.txt",
      severity: "warning",
      message: "warning: name.reserved at CON.txt",
    } as LogEvent;
    expect(progressMessage(event, en)).toBe("Finding name.reserved at CON.txt");
    expect(event.message).toBe("warning: name.reserved at CON.txt");
  });

  it("keeps a fault's code and diagnostic detail as the SDK wrote them", () => {
    const event = {
      time: "2026-06-14T05:00:00.000Z",
      level: "error",
      event: "fault",
      code: "scan.stat-failed",
      detail: "cannot stat: /x",
      cause: "EACCES",
      message: "scan.stat-failed: cannot stat: /x: EACCES",
    } as LogEvent;
    expect(progressMessage(event, createTranslator("ja"))).toBe("scan.stat-failed: cannot stat: /x: EACCES");
  });

  it("lists a stage's counts the way the language lists things", () => {
    const event = {
      time: "2026-06-14T05:00:00.000Z",
      level: "info",
      event: "plan.done",
      included: 3,
      excluded: 1,
      renamed: 0,
      warnings: 1,
      errors: 2,
      message: "plan complete",
    } as LogEvent;
    expect(progressMessage(event, en)).toBe(
      "Plan complete: 3 included, 1 excluded, 0 renamed, 1 warning, 2 errors",
    );
  });
});

describe("humanSentence", () => {
  it("sentence-cases prose while preserving technical ids, paths, and fragments", () => {
    expect(humanSentence("saved and verified")).toBe("Saved and verified");
    expect(humanSentence("output.exists: destination already exists")).toBe(
      "output.exists: Destination already exists",
    );
    expect(humanSentence("/tmp/lowercase-name.zip")).toBe("/tmp/lowercase-name.zip");
    expect(humanSentence("(automatic)")).toBe("(automatic)");
  });
});

describe("jobCommands", () => {
  it("offers create only when ready, and nothing when blocked", () => {
    expect(jobCommands(job({ state: "ready" }))).toEqual(["create"]);
    expect(jobCommands(job({ state: "needs-attention" }))).toEqual([]);
  });
  it("offers cancel while planning, queued, or running", () => {
    expect(jobCommands(job({ state: "planning" }))).toEqual(["cancel"]);
    expect(jobCommands(job({ state: "queued" }))).toEqual(["cancel"]);
    expect(jobCommands(job({ state: "running" }))).toEqual(["cancel"]);
  });
  it("offers only retry on a failure with no output (write failed)", () => {
    expect(jobCommands(job({ state: "failed" }))).toEqual(["retry"]);
  });
  it("offers reveal + remove-archive on a failure whose output exists", () => {
    expect(jobCommands(job({ state: "failed", output: "/out/x.zip" }))).toEqual([
      "retry",
      "reveal",
      "remove-archive",
    ]);
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
    expect(verifySummary(data, en)).toBe("10 entries, 1 CRC failure, 2 SHA mismatches");
  });
});
