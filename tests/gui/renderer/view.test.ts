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
  findingKind,
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
  mergeJobEvents,
  orderedEntries,
  originalsPresent,
  outputPreview,
  planReport,
  progressLineText,
  progressMessage,
  progressRuns,
  progressHeading,
  reportRowPath,
  reportSummary,
  severityColor,
  stateColor,
  stateLabel,
  verifySummary,
} from "../../../src/gui/renderer/src/view";
import { JOB_EVENT_LIMIT, type ExtractData, type Job, type JobEvent, type LogEvent, type PlanData, type Severity } from "../../../src/gui/shared/api";
import { RULE_ORDER } from "../../../src/sdk/registry";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec";
import { loadCatalogue } from "../../../src/gui/shared/i18n/catalogues";
import { createTranslator, message } from "../../../src/gui/shared/i18n/translate";

await Promise.all((["ru", "de", "ja"] as const).map(loadCatalogue));

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
  it("is cancelable while planning, queued, or running, or while moving originals to Trash", () => {
    expect(ALL_STATES.filter((state) => isCancelable(job({ state })))).toEqual(["planning", "queued", "running"]);
    expect(isCancelable(job({ state: "done", trashing: true }))).toBe(true);
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
  it("asks for review, not a fix, when Create stopped because the files changed", () => {
    expect(
      reportSummary(job({ state: "needs-attention", writable: true, message: message("job.planChanged") }), planOf({ writable: true }), en),
    ).toEqual({
      level: "warning",
      text: "The files changed since this job was checked, so the archive was not created. Review the report, then create the archive again.",
    });
  });
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

type Entry = PlanData["entries"][number];
const entry = (over: Partial<Entry> & { archivePath: string }): Entry => ({
  originalPath: over.archivePath,
  type: "file",
  method: "deflate",
  excluded: false,
  findings: [],
  ...over,
});
const planOf = (entries: Entry[], globals: PlanData["findings"] = []): PlanData =>
  ({ entries, findings: [...entries.flatMap((e) => e.findings), ...globals] }) as unknown as PlanData;

describe("planReport", () => {
  it("gives each file one row with every change, grouped by kind, most severe first", () => {
    const plan = planOf([
      entry({
        archivePath: "a/café.txt",
        originalPath: "a/cafe\u0301.txt",
        findings: [
          { rule: "name.nfd", severity: "info", path: "a/cafe\u0301.txt", message: "name normalized", fix: { kind: "rename", to: "a/café.txt" } },
          { rule: "name.suspicious", severity: "warning", path: "a/cafe\u0301.txt", message: "suspicious" },
        ],
      }),
      entry({ archivePath: "b/X", findings: [{ rule: "collision.case", severity: "error", path: "b/X", message: "case-only collision" }] }),
      entry({ archivePath: "b/CON_.txt", originalPath: "b/CON.txt", findings: [{ rule: "name.reserved", severity: "info", path: "b/CON.txt", message: "suffixed", fix: { kind: "rename", to: "b/CON_.txt" } }] }),
      entry({ archivePath: "a/.DS_Store", excluded: true, excludeReason: "junk: .DS_Store", findings: [{ rule: "macos.junk", severity: "info", path: "a/.DS_Store", message: "excluded by the junk preset" }] }),
      entry({ archivePath: "a/kept.txt" }),
    ]);
    expect(planReport(plan, en)).toEqual([
      { kind: "blocking", rows: [{ path: "b/X", changes: ["The path differs from another only by case, so the two collide on case-insensitive file systems"] }] },
      {
        kind: "warnings",
        rows: [{
          path: "a/café.txt",
          from: "a/cafe\u0301.txt",
          changes: ["Name normalized from NFD to NFC", "Zero-width or bidirectional-override characters present (kept)"],
        }],
      },
      { kind: "renamed", rows: [{ path: "b/CON_.txt", from: "b/CON.txt", changes: ["Reserved device name given a suffix"] }] },
      { kind: "excluded", rows: [{ path: "a/.DS_Store", changes: ["Excluded by the junk preset"] }] },
    ]);
  });
  it("shows a renamed row by its name on disk, then its name in the archive", () => {
    expect(reportRowPath({ path: "b/CON_.txt", from: "b/CON.txt", changes: [] }, en)).toBe("b/CON.txt → b/CON_.txt");
    expect(reportRowPath({ path: "a.txt", changes: [] }, en)).toBe("a.txt");
  });
  it("reads a name finding as repaired only when the SDK gave it a rename target", () => {
    const plan = planOf([entry({ archivePath: "CON", findings: [{ rule: "name.reserved", severity: "error", path: "CON", message: "reserved" }] })]);
    expect(planReport(plan, en)[0]?.rows[0]?.changes).toEqual(["The name is a reserved device name"]);
  });
  it("tells a kept symlink from an ignored one by whether the plan excluded it", () => {
    const plan = planOf([
      entry({ archivePath: "kept", findings: [{ rule: "entry.symlink", severity: "warning", path: "kept", message: "symlink preserved" }] }),
      entry({ archivePath: "dropped", excluded: true, excludeReason: "symlink ignored", findings: [{ rule: "entry.symlink", severity: "warning", path: "dropped", message: "symlink ignored" }] }),
    ]);
    expect(planReport(plan, en)[0]?.rows.map((row) => row.changes)).toEqual([
      ["Symlink kept as a Unix link entry; Windows extracts it as a text file"],
      ["Symlink ignored"],
    ]);
  });
  it("lists a skipped special file as excluded by its finding alone, and an unreadable folder as a warning", () => {
    const plan = planOf([
      entry({
        archivePath: "pipe",
        excluded: true,
        excludeReason: "named pipe (FIFO) left out: a ZIP archive cannot hold it",
        findings: [{ rule: "entry.unsupported", severity: "info", path: "pipe", message: "named pipe (FIFO) left out" }],
      }),
      entry({
        archivePath: "locked",
        type: "dir",
        findings: [{ rule: "entry.unlisted", severity: "warning", path: "locked", message: "folder could not be read" }],
      }),
    ]);
    expect(planReport(plan, en)).toEqual([
      { kind: "warnings", rows: [{ path: "locked", changes: ["This folder could not be read, so its contents are not in the archive"] }] },
      {
        kind: "excluded",
        rows: [{ path: "pipe", changes: ["Left out: a socket, pipe, device, or link that cannot be followed, which ZIP cannot hold"] }],
      },
    ]);
  });
  it("shows a rule the GUI does not know as the SDK wrote it", () => {
    const plan = planOf([entry({ archivePath: "x", findings: [{ rule: "future.rule", severity: "warning", path: "x", message: "something new" }] })]);
    expect(planReport(plan, en)[0]?.rows[0]?.changes).toEqual(["Something new"]);
  });
  it("gives a finding no entry carries a row of its own", () => {
    const plan = planOf([], [{ rule: "output.exists", severity: "error", path: "/out/a.zip", message: "exists" }]);
    expect(planReport(plan, en)).toEqual([
      { kind: "blocking", rows: [{ path: "/out/a.zip", changes: ["The output archive already exists. Turn on “Overwrite an existing file” to replace it."] }] },
    ]);
  });
  it("surfaces an excluded entry that has no finding (custom exclude, pruned empty dir)", () => {
    const plan = planOf([
      entry({ archivePath: "keep.txt" }),
      entry({ archivePath: "build/", type: "dir", excluded: true, excludeReason: "exclude rule: build/" }),
      entry({ archivePath: "empty/", type: "dir", excluded: true, excludeReason: "empty directory pruned" }),
    ]);
    expect(planReport(plan, en)).toEqual([
      {
        kind: "excluded",
        rows: [
          { path: "build/", changes: ["Excluded: exclude rule: build/"] },
          { path: "empty/", changes: ["Empty directory pruned"] },
        ],
      },
    ]);
  });
});

const jobEvent = (
  seq: number,
  event: Partial<LogEvent> & { event: LogEvent["event"] },
  session = "2026-06-14T05:00:00.000Z",
  tag: { action: JobEvent["action"]; run: string } = { action: "plan", run: "1" },
): JobEvent => ({
  jobId: "job",
  session,
  seq,
  ...tag,
  event: { time: "2026-06-14T05:00:00.000Z", level: "info", stage: "plan", message: "", ...event } as LogEvent,
});
const S = "2026-06-14T05:00:00.000Z";

describe("progressRuns", () => {
  it("heads a plan run once, leaves out the SDK's startup line, and folds findings by kind", () => {
    const events = [
      jobEvent(1, { event: "session.start", version: "0.1.0", concurrency: 2, chunkSize: 1 }),
      jobEvent(2, { event: "scan.start", inputs: 1, time: "2026-06-14T05:00:01.000Z" }),
      jobEvent(3, { event: "entry.flagged", rule: "macos.junk", path: "a", severity: "info" }),
      jobEvent(4, { event: "entry.flagged", rule: "name.reserved", path: "b", severity: "warning", level: "warn" }),
      jobEvent(5, { event: "entry.flagged", rule: "macos.junk", path: "c", severity: "info" }),
      jobEvent(6, { event: "plan.done", total: 3, included: 1, excluded: 2, renamed: 0, warnings: 1, errors: 0, writable: true }),
    ];
    const runs = progressRuns(events);
    expect(runs.map((run) => [run.key, run.action, run.time, run.lines.map((line) => progressLineText(line, en))])).toEqual([
      [
        "2026-06-14T05:00:00.000Z:2",
        "plan",
        "2026-06-14T05:00:01.000Z",
        [
          "Scanning 1 input",
          "Junk files excluded: 2 entries",
          "Reserved device names: 1 entry",
          "Plan complete: 1 included, 2 excluded, 0 renamed, 1 warning, 0 errors",
        ],
      ],
    ]);
    expect(runs[0]?.lines[2]?.level).toBe("warn");
  });
  it("keeps a Create's fresh scan, write and verify under one heading, apart from the plan before it", () => {
    const create = { action: "create" as const, run: "2" };
    const runs = progressRuns([
      jobEvent(1, { event: "scan.start", inputs: 1 }),
      jobEvent(2, { event: "scan.start", inputs: 1 }, S, create),
      jobEvent(3, { event: "write.start", entries: 2 }, S, create),
      jobEvent(4, { event: "extract.start", entries: 2, write: false }, S, create),
      jobEvent(
        5,
        { event: "extract.done", total: 2, crcFailed: 0, shaMismatched: 0, manifestMismatched: 0, written: 0, skipped: 2, reportOk: true },
        S,
        create,
      ),
    ]);
    expect(runs.map((run) => [progressHeading(run, en).split(" · ")[0], run.lines.map((line) => progressLineText(line, en))])).toEqual([
      ["Plan", ["Scanning 1 input"]],
      [
        "Create",
        [
          "Scanning 1 input",
          "Writing 2 entries",
          "Verifying 2 entries",
          "Verify complete: 2 entries, 0 CRC failures, 0 SHA mismatches, 0 manifest mismatches",
        ],
      ],
    ]);
  });
  it("heads a Verify run and starts a new run when the run id changes, even for the same action", () => {
    const runs = progressRuns([
      jobEvent(1, { event: "extract.start", entries: 1, write: false }, S, { action: "verify", run: "3" }),
      jobEvent(2, { event: "extract.start", entries: 1, write: false }, S, { action: "verify", run: "4" }),
    ]);
    expect(runs.map((run) => progressHeading(run, en).split(" · ")[0])).toEqual(["Verify", "Verify"]);
  });
  it("heads each run with its action and start time in the locale's format, or the raw value when it cannot be parsed", () => {
    const [run] = progressRuns([jobEvent(1, { event: "scan.start", inputs: 1 })]);
    expect(progressHeading(run!, createTranslator("de"))).toMatch(/^Planung · \d{2}\.\d{2}\.\d{2}, \d{2}:\d{2}:\d{2}$/);
    const [bad] = progressRuns([jobEvent(1, { event: "scan.start", inputs: 1, time: "not-a-time" })]);
    expect(progressHeading(bad!, en)).toBe("Plan · not-a-time");
  });
  it("names a kind of finding by a short label, by whether the run repaired it", () => {
    expect(findingKind("name.nfd", "info", en)).toBe("Names normalized to NFC");
    expect(findingKind("name.nfd", "warning", en)).toBe("Names not in NFC");
    expect(findingKind("path.too-long", "warning", en)).toBe("Paths too long for Windows");
    expect(findingKind("macos.junk", "info", en)).toBe("Junk files excluded");
    expect(findingKind("entry.symlink", "warning", en)).toBe("Symbolic links");
    expect(findingKind("entry.unsupported", "info", en)).toBe("Special files left out");
    expect(findingKind("extract.crc-fail", "error", en)).toBe("CRC-32 mismatches");
    expect(findingKind("extract.manifest-mismatch", "error", en)).toBe("Size or CRC-32 mismatches with the manifest");
    expect(findingKind("future.rule", "info", en)).toBe("future.rule");
  });
  it("gives every rule the SDK registers, and every verify rule, a label in one form", () => {
    const rules = [
      ...RULE_ORDER.flatMap((rule) => (rule.startsWith("name.") ? [`${rule}|info`, `${rule}|warning`] : [`${rule}|warning`])),
      ...["crc-fail", "sha-mismatch", "manifest-mismatch", "unsafe-path", "missing", "extra"].map((r) => `extract.${r}|error`),
    ];
    for (const entry of rules) {
      const [rule, severity] = entry.split("|") as [string, Severity];
      const label = findingKind(rule, severity, en);
      expect(label, entry).not.toBe(rule);
      // A label, not a sentence: no clause and no final period.
      expect(label, entry).not.toMatch(/[.,;:()]$|[,;(]/);
    }
  });
});

describe("mergeJobEvents", () => {
  it("keeps each event once, in the order it happened, across launches", () => {
    const earlier = jobEvent(9, { event: "scan.start", inputs: 1 }, "2026-06-13T00:00:00.000Z");
    const a = jobEvent(1, { event: "scan.start", inputs: 1 });
    const b = jobEvent(2, { event: "plan.done", total: 0, included: 0, excluded: 0, renamed: 0, warnings: 0, errors: 0, writable: true });
    expect(mergeJobEvents([a], [b])).toEqual([a, b]);
    expect(mergeJobEvents([earlier, a, b], [a, b])).toEqual([earlier, a, b]);
    expect(mergeJobEvents([earlier, a], [b])).toEqual([earlier, a, b]);
    expect(mergeJobEvents([b], [earlier, a])).toEqual([earlier, a, b]);
  });
  it("holds only the newest events", () => {
    const many = Array.from({ length: JOB_EVENT_LIMIT + 5 }, (_, i) => jobEvent(i + 1, { event: "scan.start", inputs: 1 }));
    const merged = mergeJobEvents([], many);
    expect(merged).toHaveLength(JOB_EVENT_LIMIT);
    expect(merged[0]?.seq).toBe(6);
  });
});

describe("progress presentation", () => {
  it("paints only the levels worth stopping at, and keeps the rest quiet", () => {
    expect(logLevelColor("error")).toBe("var(--status-error)");
    expect(logLevelColor("warn")).toBe("var(--status-warning)");
    expect(logLevelColor("info")).toBe("var(--text-2)");
    expect(logLevelColor("debug")).toBe("var(--text-2)");
  });

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
    expect(progressMessage(event, en)).toBe("Reserved device names: 1 entry");
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
  it("offers no Move to Trash after a scan that could not list a folder", () => {
    expect(jobCommands(job({ state: "ready", intent: "archive-and-trash", scanIncomplete: true }))).toEqual([]);
    expect(jobCommands(job({ state: "ready", intent: "save", scanIncomplete: true }))).toEqual(["create"]);
    expect(
      jobCommands(job({ state: "done", intent: "save", scanIncomplete: true, entries: [{ path: "/a", kind: "file" }] })),
    ).toEqual(["verify", "reveal", "remove-archive"]);
  });
  it("offers create on a still-writable job stopped for review", () => {
    expect(jobCommands(job({ state: "needs-attention", writable: true }))).toEqual(["create"]);
    expect(jobCommands(job({ state: "needs-attention", writable: false }))).toEqual([]);
  });
  it("offers only cancel while a finished job moves its originals to Trash", () => {
    expect(jobCommands(job({ state: "done", intent: "save", trashing: true }))).toEqual(["cancel"]);
  });
  it("offers trash-originals only when the archive carries the manifest", () => {
    const done = { state: "done" as const, intent: "save" as const, entries: [{ path: "/a", kind: "file" as const }] };
    expect(jobCommands(job({ ...done, options: { ...DEFAULT_OPTIONS, metadata: false } }))).toEqual([
      "verify",
      "reveal",
      "remove-archive",
    ]);
  });
  it("offers no create or retry for a Move-to-Trash job without its manifest", () => {
    const noManifest = { intent: "archive-and-trash" as const, options: { ...DEFAULT_OPTIONS, metadata: false } };
    expect(jobCommands(job({ state: "ready", ...noManifest }))).toEqual([]);
    expect(jobCommands(job({ state: "failed", ...noManifest }))).toEqual([]);
    expect(jobCommands(job({ state: "ready", intent: "save", options: { ...DEFAULT_OPTIONS, metadata: false } }))).toEqual([
      "create",
    ]);
  });
  it("offers cancel while planning, queued, or running", () => {
    expect(jobCommands(job({ state: "planning" }))).toEqual(["cancel"]);
    expect(jobCommands(job({ state: "queued" }))).toEqual(["cancel"]);
    expect(jobCommands(job({ state: "running" }))).toEqual(["cancel"]);
  });
  it("offers only retry on a failure with no output (write failed)", () => {
    expect(jobCommands(job({ state: "failed" }))).toEqual(["retry"]);
  });
  it("offers reveal + remove-archive on a failure whose archive was written", () => {
    expect(jobCommands(job({ state: "failed", output: "/out/x.zip", archiveWritten: true }))).toEqual([
      "retry",
      "reveal",
      "remove-archive",
    ]);
  });
  it("offers only retry on a failed write, though the plan named an output", () => {
    expect(jobCommands(job({ state: "failed", output: "/out/x.zip", archiveWritten: false }))).toEqual(["retry"]);
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
    const data = {
      summary: { total: 10, crcFailed: 1, shaMismatched: 2, manifestMismatched: 1 },
    } as unknown as ExtractData;
    expect(verifySummary(data, en)).toBe("10 entries, 1 CRC failure, 2 SHA mismatches, 1 manifest mismatch");
  });
});
