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
  detailsCards,
  namesOf,
  rowsByPath,
  jobCommands,
  jobCounts,
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
  renameDisplay,
  reportSummary,
  severityColor,
  stateColor,
  stateLabel,
} from "../../../src/gui/renderer/src/view";
import { JOB_EVENT_LIMIT, type Finding, type Job, type JobEvent, type LogEvent, type PlanData, type Severity } from "../../../src/gui/shared/api";
import { RULE_REGISTRY } from "zipkitsdk";

const RULE_ORDER = Object.keys(RULE_REGISTRY);
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec";
import { loadCatalogue } from "../../../src/gui/shared/i18n/catalogues";
import { createTranslator, message } from "../../../src/gui/shared/i18n/translate";
import { DELETE, SAVE, TRASH } from "../../helpers/intents.js";

await Promise.all((["ru", "de", "ja"] as const).map(loadCatalogue));

const en = createTranslator("en");

const job = (over: Partial<Job> = {}): Job => ({
  id: "j",
  inputs: ["/a/b/c"],
  options: DEFAULT_OPTIONS,
  intent: SAVE,
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
  it("names the first input the Inputs list shows, however many there are", () => {
    const j = job({
      inputs: ["/f1.txt", "/b/photos", "/a/docs"],
      entries: [
        { path: "/f1.txt", kind: "file" },
        { path: "/b/photos", kind: "directory" },
        { path: "/a/docs", kind: "directory" },
      ],
    });
    // Folders come first in the Inputs list, by path: /a/docs.
    expect(label(j, en)).toBe("docs");
    expect(label(job({ inputs: ["/x/report.pdf", "/x/gone.txt"], entries: [
      { path: "/x/report.pdf", kind: "file" },
      { path: "/x/gone.txt", kind: "missing" },
    ] }), en)).toBe("report.pdf");
  });
  it("uses the order the inputs were added before they are classified", () => {
    expect(label(job({ inputs: ["/z/last", "/a/first", "/c"] }), en)).toBe("last");
  });
  it("falls back when there are no inputs", () => {
    expect(label(job({ inputs: [] }), en)).toBe("(no input)");
  });
});

describe("jobCounts", () => {
  const summary = { total: 0, included: 0, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false, sourceBytes: 0 };
  const texts = (j: Job, t = en) => jobCounts(j, t).map((count) => count.text);

  it("counts the inputs by kind, only the kinds present, in the Inputs list's order", () => {
    expect(texts(job({ inputs: ["/a.txt"], entries: [{ path: "/a.txt", kind: "file" }] }))).toEqual(["1 file"]);
    expect(texts(job({
      inputs: ["/f", "/d", "/e", "/g", "/s"],
      entries: [
        { path: "/f", kind: "file" },
        { path: "/s", kind: "other" },
        { path: "/d", kind: "directory" },
        { path: "/g", kind: "missing" },
        { path: "/e", kind: "directory" },
      ],
    }))).toEqual(["2 folders", "1 file", "1 missing", "1 other"]);
  });

  it("counts unclassified inputs as items, and nothing when there are none", () => {
    expect(texts(job({ inputs: ["/a", "/b"] }))).toEqual(["2 items"]);
    expect(jobCounts(job({ inputs: [] }), en)).toEqual([]);
  });

  it("leads with the plan's errors, warnings and exclusions, only when there are any, colouring the first two", () => {
    const entries = [{ path: "/d", kind: "directory" as const }];
    expect(jobCounts(job({ inputs: ["/d"], entries, summary }), en)).toEqual([{ text: "1 folder" }]);
    expect(jobCounts(job({ inputs: ["/d"], entries, summary: { ...summary, excluded: 4, warnings: 1, errors: 1240 } }), en)).toEqual([
      { text: "1,240 errors", severity: "error" },
      { text: "1 warning", severity: "warning" },
      { text: "4 excluded" },
      { text: "1 folder" },
    ]);
  });

  it("reads in the interface language", () => {
    const ja = createTranslator("ja");
    const entries = [{ path: "/d", kind: "directory" as const }, { path: "/f", kind: "file" as const }, { path: "/g", kind: "file" as const }];
    expect(texts(job({ inputs: ["/d", "/f", "/g"], entries, summary: { ...summary, excluded: 4, errors: 1 } }), ja))
      .toEqual(["エラー 1", "除外 4", "フォルダ 1", "ファイル 2"]);
    expect(texts(job({ inputs: ["/f", "/g"], entries: entries.slice(1) }), createTranslator("ru"))).toEqual(["2 файла"]);
  });
});

describe("orderedEntries", () => {
  it("orders directories first, then files, then missing/other; alpha within a group", () => {
    const entries = [
      { path: "/z/file-b.txt", kind: "file" as const },
      { path: "/a/dir-b", kind: "directory" as const },
      { path: "/gone", kind: "missing" as const },
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
  it("leaves the name empty only while planning, never claims planning when blocked", () => {
    const planning = job({ state: "planning", inputs: ["/a/b/c"] });
    expect(outputPreview(planning, DEFAULT_OPTIONS, en).name).toBe("");
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
      originalsPresent(job({ entries: [{ path: "/a", kind: "missing" }, { path: "/b", kind: "file" }] })),
    ).toBe(true);
    expect(
      originalsPresent(job({ entries: [{ path: "/a", kind: "missing" }] })),
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
      intent: SAVE,
      entries: [{ path: "/a", kind: "file" }],
    });
    expect(jobCommands(present)).toContain("trash-originals");
    const gone = job({
      state: "done",
      intent: SAVE,
      entries: [{ path: "/a", kind: "missing" }],
    });
    expect(jobCommands(gone)).not.toContain("trash-originals");
  });
  it("offers no trash-originals for archive-and-trash until its originals are found back", () => {
    expect(jobCommands(job({ state: "done", intent: TRASH }))).not.toContain(
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
    expect(manifestRequiredButMissing(TRASH, false)).toBe(true);
    expect(manifestRequiredButMissing(TRASH, true)).toBe(false);
    expect(manifestRequiredButMissing(SAVE, false)).toBe(false);
  });
});

describe("intentLabel", () => {
  it("tags only the noteworthy intent; the default save shows nothing", () => {
    expect(intentLabel(SAVE, en)).toBe("");
    expect(intentLabel(TRASH, en)).toBe("→ Trash");
  });
});

describe("stateLabel", () => {
  it("proper-cases every state (exhaustive, none left raw)", () => {
    expect(ALL_STATES.map((state) => en.t(stateLabel(state)))).toEqual([
      "Planning…",
      "Needs attention",
      "Ready",
      "Queued",
      "Running…",
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
  // `renamed` here is the number of entries renamed in their own right, each
  // given the rename finding the SDK reports on it.
  const planOf = (over: Partial<PlanData["summary"]> & { writable: boolean }): PlanData => {
    const { writable, ...summary } = over;
    const entries = Array.from({ length: summary.renamed ?? 0 }, (_, i) => ({
      archivePath: `f${i}_.txt`,
      originalPath: `f${i}:.txt`,
      type: "file",
      method: "deflate",
      excluded: false,
      nameFixes: [{ rule: "name.invalid-char", before: `f${i}:.txt`, after: `f${i}_.txt` }],
      findings: [{ id: `name.invalid-char:f${i}:.txt`, rule: "name.invalid-char", severity: "info", path: `f${i}:.txt`, message: "invalid characters substituted", fix: { kind: "rename", to: `f${i}_.txt` } }],
    }));
    return {
      writable,
      entries,
      findings: entries.flatMap((e) => e.findings),
      summary: { included: 0, excluded: 0, renamed: 0, warnings: 0, errors: 0, ...summary },
    } as unknown as PlanData;
  };
  it("counts a renamed folder once, as the Report lists it, not once per file inside it", () => {
    const folder = { kind: "rename" as const, to: "Report.pages" };
    const plan = {
      writable: true,
      summary: { included: 3, excluded: 0, renamed: 3, warnings: 0, errors: 0 },
      entries: [
        { archivePath: "Report.pages", originalPath: "Report.pages ", type: "dir", method: "store", excluded: false, nameFixes: [{ rule: "name.trailing-dot-space", before: "Report.pages ", after: "Report.pages" }], findings: [{ id: "name.trailing-dot-space:Report.pages ", rule: "name.trailing-dot-space", severity: "info", path: "Report.pages ", message: "trimmed", fix: folder }] },
        { archivePath: "Report.pages/index.xml", originalPath: "Report.pages /index.xml", type: "file", method: "deflate", excluded: false, nameFixes: [], findings: [] },
        { archivePath: "Report.pages/Data/a.png", originalPath: "Report.pages /Data/a.png", type: "file", method: "store", excluded: false, nameFixes: [], findings: [] },
      ],
      findings: [],
    } as unknown as PlanData;
    expect(reportSummary(job({ state: "ready" }), plan, en)?.text).toBe("3 items ready to archive (1 renamed for portability).");
  });
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
  it("says before a run that an input went or is out of reach, and leaves a finished job to its history", () => {
    const entries = [
      { path: "/a", kind: "missing" as const },
      { path: "/b", kind: "unavailable" as const },
      { path: "/c", kind: "file" as const },
    ];
    expect(jobAdvisories(job({ inputs: ["/a", "/b", "/c"], entries }), en).map((line) => line.text)).toEqual([
      "1 input is missing. Remove it from the job, or put it back.",
      "1 input is out of reach. Its drive is not connected, or it cannot be read.",
    ]);
    expect(jobAdvisories(job({ state: "done", inputs: ["/a", "/b", "/c"], entries }), en)).toEqual([]);
  });
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
  diskPath: `/in/${over.archivePath}`,
  type: "file",
  method: "deflate",
  excluded: false,
  nameFixes: [],
  findings: [],
  ...over,
});
const planOf = (entries: Entry[], globals: PlanData["findings"] = []): PlanData =>
  ({ entries, findings: [...entries.flatMap((e) => e.findings), ...globals] }) as unknown as PlanData;

describe("planReport", () => {
  it("uses each link's owning entry without scanning the complete entry list", () => {
    const entries = Array.from({ length: 1000 }, (_, i) => entry({
      archivePath: `link-${i}`, type: "file", excluded: i % 2 === 0,
      findings: [i % 2 === 0
        ? { id: `entry.symlink-ignored:link-${i}`, rule: "entry.symlink-ignored", severity: "warning", path: `link-${i}`, message: "link" }
        : { id: `entry.symlink-preserved:link-${i}`, rule: "entry.symlink-preserved", severity: "warning", path: `link-${i}`, message: "link" }],
    }));
    const plan = planOf(entries);
    let inspections = 0;
    const find = entries.find.bind(entries);
    entries.find = ((predicate: (value: Entry, index: number, array: Entry[]) => unknown, thisArg?: unknown) => find((value, index, array) => {
      inspections++;
      return predicate.call(thisArg, value, index, array);
    })) as typeof entries.find;
    const groups = planReport(plan, en);
    expect(groups[0]?.rows).toHaveLength(1000);
    expect(inspections).toBe(0);
    expect(groups[0]?.rows[0]?.changes).not.toEqual(groups[0]?.rows[1]?.changes);
  });

  it("gives each file one row with every change, grouped by kind, most severe first", () => {
    const plan = planOf([
      entry({
        archivePath: "a/café.txt",
        originalPath: "a/cafe\u0301.txt",
        findings: [
          { id: `name.nfd:${"a/cafe\u0301.txt"}`, rule: "name.nfd", severity: "info", path: "a/cafe\u0301.txt", message: "name normalized", fix: { kind: "rename", to: "a/café.txt" } },
          { id: `name.suspicious:${"a/cafe\u0301.txt"}`, rule: "name.suspicious", severity: "warning", path: "a/cafe\u0301.txt", message: "suspicious" },
        ],
      }),
      entry({ archivePath: "b/X", findings: [{ id: "collision.case:b/X", rule: "collision.case", severity: "error", path: "b/X", message: "case-only collision" }] }),
      entry({ archivePath: "b/CON_.txt", originalPath: "b/CON.txt", findings: [{ id: "name.reserved:b/CON.txt", rule: "name.reserved", severity: "info", path: "b/CON.txt", message: "suffixed", fix: { kind: "rename", to: "b/CON_.txt" } }] }),
      entry({ archivePath: "a/.DS_Store", excluded: true, nameFixes: [], excludeReason: "junk: .DS_Store", findings: [{ id: "exclude.pattern:a/.DS_Store", rule: "exclude.pattern", severity: "info", path: "a/.DS_Store", message: "excluded by the junk preset" }] }),
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
      { kind: "excluded", rows: [{ path: "a/.DS_Store", changes: ["Left out by an exclusion pattern"] }] },
    ]);
  });
  it("gives a renamed folder one row, and a file inside it a row only for its own change", () => {
    const fix = (to: string) => ({ kind: "rename" as const, to });
    const plan = planOf([
      entry({
        archivePath: "Docs",
        originalPath: "Docs.",
        type: "dir",
        findings: [{ id: "name.trailing-dot-space:Docs.", rule: "name.trailing-dot-space", severity: "info", path: "Docs.", message: "trimmed", fix: fix("Docs") }],
      }),
      entry({ archivePath: "Docs/plain.txt", originalPath: "Docs./plain.txt" }),
      entry({ archivePath: "Docs/X.pages", originalPath: "Docs./X.pages", type: "dir" }),
      entry({ archivePath: "Docs/X.pages/index.xml", originalPath: "Docs./X.pages/index.xml" }),
      entry({ archivePath: "Docs/X.pages/Data/p.png", originalPath: "Docs./X.pages/Data/p.png" }),
      entry({
        archivePath: "Docs/a_b.txt",
        originalPath: "Docs./a:b.txt",
        findings: [{ id: "name.invalid-char:Docs./a:b.txt", rule: "name.invalid-char", severity: "info", path: "Docs./a:b.txt", message: "substituted", fix: fix("Docs/a_b.txt") }],
      }),
    ]);
    expect(planReport(plan, en)).toEqual([
      {
        kind: "renamed",
        rows: [
          { path: "Docs", from: "Docs.", changes: ["Trailing dots or spaces trimmed"], dir: true },
          { path: "Docs/a_b.txt", from: "Docs./a:b.txt", changes: ["Invalid characters substituted"] },
        ],
      },
    ]);
  });
  it("keeps the row of an entry the SDK reported a parent rename on (no folder entry of its own)", () => {
    const plan = planOf([
      entry({
        archivePath: "as_dir/file.txt",
        originalPath: "as:dir/file.txt",
        findings: [{ id: "name.invalid-char:as:dir/file.txt", rule: "name.invalid-char", severity: "info", path: "as:dir/file.txt", message: "substituted", fix: { kind: "rename", to: "as_dir/file.txt" } }],
      }),
    ]);
    expect(planReport(plan, en)).toEqual([
      { kind: "renamed", rows: [{ path: "as_dir/file.txt", from: "as:dir/file.txt", changes: ["Invalid characters substituted"] }] },
    ]);
  });
  it("shows an NFD-only rename once: the decomposed Japanese name and its NFC form look the same", () => {
    // が and パ written as base kana plus combining (semi-)voiced marks.
    const nfd = "\u304b\u3099\u30cf\u309a.txt";
    expect(renameDisplay(nfd, nfd.normalize("NFC"))).toEqual({ kind: "same" });
  });
  it("marks only the real substitution in a decomposed name that also had an invalid character", () => {
    const nfd = "\u304b\u3099:\u30cf\u309a.txt";
    const fixed = "\u304c_\u30d1.txt";
    expect(renameDisplay(nfd, fixed)).toEqual({
      kind: "changed",
      parts: [
        { text: "\u304c", change: "kept" },
        { text: ":", change: "removed" },
        { text: "_", change: "added" },
        { text: "\u30d1.txt", change: "kept" },
      ],
    });
  });
  it("marks a plain substitution", () => {
    expect(renameDisplay("b/CON.txt", "b/CON_.txt")).toEqual({
      kind: "changed",
      parts: [
        { text: "b/CON", change: "kept" },
        { text: "_", change: "added" },
        { text: ".txt", change: "kept" },
      ],
    });
  });
  it("reads a name finding as repaired only when the SDK gave it a rename target", () => {
    const plan = planOf([entry({ archivePath: "CON", findings: [{ id: "name.reserved:CON", rule: "name.reserved", severity: "error", path: "CON", message: "reserved" }] })]);
    expect(planReport(plan, en)[0]?.rows[0]?.changes).toEqual(["The name is a reserved device name"]);
  });
  it("tells a kept symlink from an ignored one by the SDK's rule", () => {
    const plan = planOf([
      entry({ archivePath: "kept", findings: [{ id: "entry.symlink-preserved:kept", rule: "entry.symlink-preserved", severity: "warning", path: "kept", message: "symlink preserved" }] }),
      entry({ archivePath: "dropped", excluded: true, nameFixes: [], excludeReason: "symlink ignored", findings: [{ id: "entry.symlink-ignored:dropped", rule: "entry.symlink-ignored", severity: "warning", path: "dropped", message: "symlink ignored" }] }),
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
        findings: [{ id: "entry.unsupported:pipe", rule: "entry.unsupported", severity: "info", path: "pipe", message: "named pipe (FIFO) left out" }],
      }),
      entry({
        archivePath: "locked",
        type: "dir",
        findings: [{ id: "entry.unlisted:locked", rule: "entry.unlisted", severity: "warning", path: "locked", message: "folder could not be read" }],
      }),
    ]);
    expect(planReport(plan, en)).toEqual([
      { kind: "warnings", rows: [{ path: "locked", dir: true, changes: ["This folder could not be read, so its contents are not in the archive"] }] },
      {
        kind: "excluded",
        rows: [{ path: "pipe", changes: ["Left out: a socket, pipe, device, or link that cannot be followed, which ZIP cannot hold"] }],
      },
    ]);
  });
  it("says which kind of special file was left out when the plan names it", () => {
    const kinds = [["socket", "Left out: a socket, which ZIP cannot hold"], ["broken-link", "Left out: a link whose target does not exist"],
      ["external-link", "Left out: a link that leads outside the inputs"]] as const;
    const plan = planOf(kinds.map(([kind]) => entry({
      archivePath: kind, excluded: true, excludeCode: "unsupported", unsupportedKind: kind, excludeReason: "left out",
      findings: [{ id: `entry.unsupported:${kind}`, rule: "entry.unsupported", severity: "info", path: kind, message: "left out" }],
    })));
    expect(planReport(plan, en)[0]?.rows.map((row) => row.changes[0])).toEqual(kinds.map(([, text]) => text));
  });
  it("shows a rule the GUI does not know as the SDK wrote it", () => {
    const plan = planOf([entry({ archivePath: "x", findings: [{ id: "future.rule:x", rule: "future.rule" as Finding["rule"], severity: "warning", path: "x", message: "something new" }] })]);
    expect(planReport(plan, en)[0]?.rows[0]?.changes).toEqual(["Something new"]);
  });
  it("gives a finding no entry carries a row of its own", () => {
    const plan = planOf([], [{ id: "output.exists:/out/a.zip", rule: "output.exists", severity: "error", path: "/out/a.zip", message: "exists" }]);
    expect(planReport(plan, en)).toEqual([
      { kind: "blocking", rows: [{ path: "/out/a.zip", changes: ["The output archive already exists. Turn on “Overwrite an existing file” to replace it."] }] },
    ]);
  });
  it("surfaces an excluded entry that has no finding by its exclusion code, never the SDK's English reason", () => {
    const plan = planOf([
      entry({ archivePath: "keep.txt" }),
      entry({ archivePath: "build/", type: "dir", excluded: true, nameFixes: [], excludeCode: "pattern", excludeReason: "pattern build/" }),
      entry({ archivePath: "empty/", type: "dir", excluded: true, nameFixes: [], excludeCode: "empty-dir", excludeReason: "empty directory pruned" }),
    ]);
    expect(planReport(plan, en)).toEqual([
      {
        kind: "excluded",
        rows: [
          { path: "build/", changes: ["Excluded by a filter"], dir: true },
          { path: "empty/", changes: ["Empty directory pruned"], dir: true },
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
      jobEvent(3, { event: "entry.flagged", rule: "exclude.pattern", path: "a", severity: "info" }),
      jobEvent(4, { event: "entry.flagged", rule: "name.reserved", path: "b", severity: "warning", level: "warn" }),
      jobEvent(5, { event: "entry.flagged", rule: "exclude.pattern", path: "c", severity: "info" }),
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
          "Left out by exclusion patterns: 2 entries",
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
      jobEvent(4, { event: "verify.start", entries: 2 }, S, create),
      jobEvent(
        5,
        { event: "verify.done", total: 2, crc32Failed: 0, unreadable: 0, localMismatched: 0, sha256Mismatched: 0, manifestMismatched: 0, ok: true },
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
          "Verify complete: 2 entries, 0 CRC failures, 0 unreadable entries, 0 SHA mismatches, 0 manifest mismatches",
        ],
      ],
    ]);
  });
  it("heads a Verify run and starts a new run when the run id changes, even for the same action", () => {
    const runs = progressRuns([
      jobEvent(1, { event: "verify.start", entries: 1 }, S, { action: "verify", run: "3" }),
      jobEvent(2, { event: "verify.start", entries: 1 }, S, { action: "verify", run: "4" }),
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
    expect(findingKind("exclude.pattern", "info", en)).toBe("Left out by exclusion patterns");
    expect(findingKind("entry.symlink-ignored", "warning", en)).toBe("Symbolic links");
    expect(findingKind("entry.symlink-preserved", "warning", en)).toBe("Symbolic links");
    expect(findingKind("entry.unsupported", "info", en)).toBe("Special files left out");
    expect(findingKind("verify.crc32-mismatch", "error", en)).toBe("CRC-32 mismatches");
    expect(findingKind("verify.manifest-mismatch", "error", en)).toBe("Mismatches with the manifest");
    expect(findingKind("future.rule", "info", en)).toBe("future.rule");
  });
  it("gives every rule the SDK registers, and every verify rule, a label in one form", () => {
    const rules = [
      ...RULE_ORDER.flatMap((rule) => (rule.startsWith("name.") ? [`${rule}|info`, `${rule}|warning`] : [`${rule}|warning`])),
      ...["crc32-mismatch", "unreadable", "local-mismatch", "sha256-mismatch", "manifest-mismatch", "missing", "extra"].map((r) => `verify.${r}|error`),
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

  it("keeps a fault's code and diagnostic message as the SDK wrote them", () => {
    const event = {
      time: "2026-06-14T05:00:00.000Z",
      stage: "scan",
      level: "error",
      event: "fault",
      error: { name: "ZipKitError", code: "path.denied", kind: "unavailable", effect: "none", message: "cannot stat: /x" },
      cause: "EACCES",
      message: "path.denied: cannot stat: /x: EACCES",
    } as LogEvent;
    expect(progressMessage(event, createTranslator("ja"))).toBe("path.denied: cannot stat: /x: EACCES");
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
  it("offers Verify until the archive verifies, again once it changes, and nothing once it is gone with the originals", () => {
    const done = (archiveStatus: Job["archiveStatus"], intent = SAVE) =>
      jobCommands(job({ state: "done", intent, archiveStatus, entries: [{ path: "/a", kind: "file" }] }));
    expect(done("written")).toContain("verify");
    expect(done("verified")).not.toContain("verify");
    expect(done("verified")).toContain("reveal");
    expect(done("changed")).toContain("verify");
    const trashed = (archiveStatus: Job["archiveStatus"]) =>
      jobCommands(job({ state: "done", intent: TRASH, archiveStatus, entries: [{ path: "/a", kind: "missing" }] }));
    expect(trashed("verified")).toEqual(["reveal"]);
    expect(trashed("missing")).toEqual([]);
    expect(trashed("unavailable")).toEqual([]);
    // Put back from the Trash: the archive is redundant again, and the
    // originals can be removed again.
    expect(done("verified", TRASH)).toEqual(["reveal", "remove-archive", "trash-originals", "delete-originals"]);
  });
  it("offers create only when ready, and nothing when blocked", () => {
    expect(jobCommands(job({ state: "ready" }))).toEqual(["create"]);
    expect(jobCommands(job({ state: "needs-attention" }))).toEqual([]);
  });
  it("offers no Move to Trash after a scan that could not list a folder", () => {
    expect(jobCommands(job({ state: "ready", intent: TRASH, scanIncomplete: true }))).toEqual([]);
    expect(jobCommands(job({ state: "ready", intent: SAVE, scanIncomplete: true }))).toEqual(["create"]);
    expect(
      jobCommands(job({ state: "done", intent: SAVE, scanIncomplete: true, entries: [{ path: "/a", kind: "file" }] })),
    ).toEqual(["verify", "reveal", "remove-archive"]);
  });
  it("offers create on a still-writable job stopped for review", () => {
    expect(jobCommands(job({ state: "needs-attention", writable: true }))).toEqual(["create"]);
    expect(jobCommands(job({ state: "needs-attention", writable: false }))).toEqual([]);
  });
  it("offers only cancel while a job moves its archive or originals to Trash", () => {
    expect(jobCommands(job({ state: "done", intent: SAVE, trashing: true }))).toEqual(["cancel"]);
    expect(jobCommands(job({ state: "failed", intent: TRASH, archiveWritten: true, trashing: true }))).toEqual(["cancel"]);
  });
  it("offers trash-originals only when the archive carries the manifest", () => {
    const done = { state: "done" as const, intent: SAVE, entries: [{ path: "/a", kind: "file" as const }] };
    expect(jobCommands(job({ ...done, options: { ...DEFAULT_OPTIONS, manifest: false } }))).toEqual([
      "verify",
      "reveal",
      "remove-archive",
    ]);
  });
  it("offers no create or retry for a Move-to-Trash job without its manifest", () => {
    const noManifest = { intent: TRASH, options: { ...DEFAULT_OPTIONS, manifest: false } };
    expect(jobCommands(job({ state: "ready", ...noManifest }))).toEqual([]);
    expect(jobCommands(job({ state: "failed", ...noManifest }))).toEqual([]);
    expect(jobCommands(job({ state: "ready", intent: SAVE, options: { ...DEFAULT_OPTIONS, manifest: false } }))).toEqual([
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
  it("on done, offers moving the archive to Trash and removing the originals only while a kept job's originals remain", () => {
    // The removal commands come last so the bar can seat them at the far-right end.
    expect(
      jobCommands(job({ state: "done", intent: SAVE, entries: [{ path: "/a", kind: "file" }] })),
    ).toEqual(["verify", "reveal", "remove-archive", "trash-originals", "delete-originals"]);
    // Once an original is gone the archive is no longer redundant, so it is not offered to Trash.
    expect(
      jobCommands(job({ state: "done", intent: SAVE, entries: [{ path: "/a", kind: "file" }, { path: "/b", kind: "missing" }] })),
    ).toEqual(["verify", "reveal", "trash-originals", "delete-originals"]);
    expect(jobCommands(job({ state: "done", intent: SAVE, entries: [{ path: "/a", kind: "missing" }] }))).toEqual(["verify", "reveal"]);
    expect(jobCommands(job({ state: "done", intent: TRASH }))).toEqual(["verify", "reveal"]);
    expect(jobCommands(job({ state: "done", intent: DELETE }))).toEqual(["verify", "reveal"]);
  });

  it("on a failed run with its archive written, keeps the archive when the run deleted some originals", () => {
    const failed = { state: "failed" as const, archiveWritten: true };
    expect(jobCommands(job({ ...failed, intent: TRASH, entries: [{ path: "/a", kind: "missing" }] }))).toEqual(["retry", "reveal", "remove-archive"]);
    expect(jobCommands(job({ ...failed, intent: DELETE, entries: [{ path: "/a", kind: "missing" }] }))).toEqual(["retry", "reveal"]);
    expect(jobCommands(job({ ...failed, intent: DELETE, entries: [{ path: "/a", kind: "file" }] }))).toEqual(["retry", "reveal", "remove-archive"]);
  });
});


describe("Details pane sections and orders", () => {
  const row = (path: string, changes: string[] = [], dir = false) => ({ path, changes, ...(dir ? { dir: true } : {}) });

  it("makes one card per kind, the ones that block first, and the archive first among the rest", () => {
    const entry = (archivePath: string, rule: string, severity: Severity, excluded = false) => ({
      archivePath, originalPath: archivePath, diskPath: `/in/${archivePath}`, type: "file" as const, method: "deflate" as const, excluded,
      findings: [{ rule, severity, path: archivePath, message: rule }],
    });
    const plan = { writable: false, summary: { total: 3, included: 2, excluded: 1, renamed: 0, warnings: 1, errors: 1, zip64: false, sourceBytes: 0 }, findings: [],
      entries: [entry("a/.DS_Store", "exclude.pattern", "info", true), entry("long", "path.too-long", "warning"), entry("A", "collision.case", "error")] };
    const done = job({ state: "done", output: "/out/a.zip", archiveStatus: "written", summary: plan.summary });
    const cards = detailsCards(done, plan as never, { missing: ["m"], extra: [] }, en, 5);
    expect(cards.map((card) => [card.key, card.level, card.open])).toEqual([
      ["rule:collision.case", "error", true],
      ["verify:missing", "error", true],
      ["rule:path.too-long", "warning", true],
      ["archive", "info", true],
      ["rule:exclude.pattern", "info", true],
    ]);
    // A card with more rows than the limit folds to its count, whatever its level.
    const many = { ...plan, entries: Array.from({ length: 6 }, (_, i) => entry(`d${i}`, "collision.case", "error")) };
    expect(detailsCards(job(), many as never, null, en, 5)[0]!.open).toBe(false);
    expect(detailsCards(job(), many as never, null, en, 6)[0]!.open).toBe(true);
  });

  it("lists each item where it is on disk, a rename with only what it changed, and notes no duplicate as lost", () => {
    const planned = (archivePath: string, over: Record<string, unknown>) => ({
      archivePath, originalPath: archivePath, diskPath: `/in/${archivePath}`, type: "file" as const, method: "deflate" as const,
      excluded: false, nameFixes: [], findings: [], ...over,
    });
    const rename = (from: string, to: string) => [{ id: `name.invalid-char:${from}`, rule: "name.invalid-char", severity: "info" as const, path: from, message: "", fix: { kind: "rename" as const, to } }];
    const plan = { writable: true, summary: { total: 4, included: 2, excluded: 2, renamed: 2, warnings: 0, errors: 0, zip64: false, sourceBytes: 0 }, findings: [], entries: [
      // The folder was renamed too, but this row's rule renamed the file; both show.
      planned("a_b/c_d.txt", { originalPath: "a:b/c:d.txt", diskPath: "C:\\Users\\me\\proj\\a:b\\c:d.txt", findings: rename("a:b/c:d.txt", "a_b/c_d.txt") }),
      planned("dup.txt", { excluded: true, excludeCode: "duplicate", excludeReason: "duplicate", findings: [{ id: "entry.duplicate:dup.txt", rule: "entry.duplicate", severity: "info", path: "dup.txt", message: "" }] }),
      planned("skip.tmp", { excluded: true, excludeCode: "filter", excludeReason: "excluded by *.tmp" }),
    ] };
    const cards = detailsCards(job({ intent: TRASH }), plan as never, null, en, 5);
    const rows = Object.fromEntries(cards.map((card) => [card.key, card.rows]));
    expect(rows["rule:name.invalid-char"]).toEqual([expect.objectContaining({ path: "C:\\Users\\me\\proj\\a_b\\c_d.txt", from: "C:\\Users\\me\\proj\\a:b\\c:d.txt" })]);
    const filtered = cards.find((card) => card.key.startsWith("excluded:"))!;
    expect(filtered.rows[0]?.path).toBe("/in/skip.tmp");
    const notes = Object.fromEntries(cards.map((card) => [card.key, card.note]));
    expect(filtered.note).toBe("These go to the Trash with the originals, without being archived.");
    expect(notes["rule:entry.duplicate"]).toBeUndefined();
  });

  it("lists a card's names once each, with how many rows carry them, and orders paths as the locale does", () => {
    const rows = [row("z/.DS_Store"), row("a/.DS_Store"), row("m/Thumbs.db"), row("q/.Trashes/"), row("b/file 10.txt"), row("b/file 9.txt")];
    expect(namesOf(rows, "en")).toEqual([
      { name: ".DS_Store", count: 2 },
      { name: ".Trashes", count: 1 },
      { name: "file 9.txt", count: 1 },
      { name: "file 10.txt", count: 1 },
      { name: "Thumbs.db", count: 1 },
    ]);
    expect(namesOf([row("/Users/me/Desktop/Desktop.zip")], "en")).toEqual([{ name: "Desktop.zip", count: 1 }]);
    // A renamed item goes by its name on disk.
    expect(namesOf([{ path: "a/How are you.url", from: "a/How are you???.url", changes: [] }], "en")).toEqual([{ name: "How are you???.url", count: 1 }]);
    expect(rowsByPath(rows, "en").map((r) => r.path)).toEqual(["a/.DS_Store", "b/file 9.txt", "b/file 10.txt", "m/Thumbs.db", "q/.Trashes/", "z/.DS_Store"]);
  });

});
