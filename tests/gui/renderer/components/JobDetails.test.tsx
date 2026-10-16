// @vitest-environment jsdom
/**
 * The Details pane and its full-list dialog: errors and warnings list their
 * first rows at once, exclusions fold into one line per reason and renames into
 * one line, every count opens the full list by path or by name, and the step a
 * working job is on shows while it works.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { JobDetails } from "../../../../src/gui/renderer/src/components/JobDetails";
import * as view from "../../../../src/gui/renderer/src/view";

// Counted, so a test can tell whether the sections were rebuilt.
vi.mock("../../../../src/gui/renderer/src/view", async (original) => {
  const real = await original<typeof import("../../../../src/gui/renderer/src/view")>();
  return { ...real, planReport: vi.fn(real.planReport) };
});
import type { Job, JobEvent, PlanData, PlannedEntry } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";
import { SAVE } from "../../../helpers/intents.js";

// jsdom lays nothing out, so the dialog's virtualized list would draw no row:
// each line measures 40 px and the view 600 px.
let restoreLayout: () => void = () => {};
beforeEach(() => {
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ top: 0, bottom: 40, height: 40, width: 600, left: 0, right: 600, x: 0, y: 0, toJSON() {} } as DOMRect);
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  restoreLayout = () => { rect.mockRestore(); Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight); };
});
afterEach(() => { restoreLayout(); cleanup(); localStorage.clear(); });

const job = (over: Partial<Job> = {}): Job => ({ id: "job", inputs: ["/in"], options: DEFAULT_OPTIONS, intent: SAVE, state: "ready", ...over });
const plan = (entries: PlannedEntry[] = []): PlanData => ({
  mode: "plan",
  output: "/output.zip",
  log: "/log",
  entries,
  findings: [],
  summary: { total: entries.length, included: 0, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false },
  writable: true,
} as PlanData);
const entry = (archivePath: string, over: Partial<PlannedEntry> = {}): PlannedEntry => ({
  archivePath, originalPath: archivePath, type: "file", method: "deflate", excluded: false, findings: [], ...over,
});
const junk = (path: string, type: "file" | "dir" = "file") =>
  entry(path, { type, excluded: true, findings: [{ rule: "macos.junk", severity: "info", path, message: "junk" }] });
const blocking = (path: string) => entry(path, { findings: [{ rule: "x.test", severity: "error", path, message: "Blocks the archive" }] });
const show = (p: PlanData | null, over: Partial<Job> = {}, events: JobEvent[] = []) =>
  render(<JobDetails job={job(over)} plan={p} verify={null} events={events} />);

describe("JobDetails", () => {
  it("lists a blocking group's first rows, and opens all of them on request", () => {
    show(plan(Array.from({ length: 7 }, (_, i) => blocking(`a/${i}.txt`))));
    expect(screen.getByRole("heading", { name: "Blocking issues 7" })).toBeTruthy();
    expect(screen.getAllByTitle(/^a\/\d\.txt$/)).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Blocking issues (7)" }));
    const dialog = screen.getByRole("dialog", { name: "Blocking issues (7)" });
    expect(within(dialog).getAllByText(/^\d\.txt$/)).toHaveLength(7);
  });

  it("folds exclusions into one line per reason, the largest first, each opening its own list", () => {
    show(plan([
      junk("a/.DS_Store"), junk("b/.DS_Store"),
      entry("empty", { type: "dir", excluded: true, excludeReason: "empty-dir" }),
    ]));
    expect(screen.getByRole("heading", { name: "Excluded 3" })).toBeTruthy();
    const reasons = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(reasons[0]).toMatch(/^Excluded by the junk preset 2List$/);
    expect(reasons).toHaveLength(2);
    expect(screen.queryByText(".DS_Store")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Excluded by the junk preset (2)" }));
    const dialog = screen.getByRole("dialog", { name: "Excluded by the junk preset (2)" });
    expect(within(dialog).getAllByText(".DS_Store")).toHaveLength(2);
    expect(within(dialog).getByText("a")).toBeTruthy();
    expect(within(dialog).queryByText("empty")).toBeNull();
  });

  it("groups the names that repeat, folders first, lists the rest plainly, and remembers the order chosen", () => {
    show(plan([junk("x/.DS_Store"), junk("y/.DS_Store"), junk("z/.Trashes", "dir"), junk("v/.Trashes", "dir"), junk("w/Thumbs.db")]));
    fireEvent.click(screen.getByRole("button", { name: "Excluded (5)" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "By name" }));
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([".Trashes (2)", ".DS_Store (2)"]);
    // A name that occurs once is a plain row: its name, then its folder.
    expect(within(dialog).getByText("Thumbs.db")).toBeTruthy();
    expect(within(dialog).getByText("w")).toBeTruthy();
    expect(localStorage.getItem("zipkit.listOrder")).toBe("name");
    fireEvent.click(within(dialog).getByText("Close", { selector: "button" }));
    fireEvent.click(screen.getByRole("button", { name: "Excluded (5)" }));
    expect(within(screen.getByRole("dialog")).getByRole("radio", { name: "By name" }).getAttribute("aria-checked")).toBe("true");
  });

  it("folds renames into one line, and marks each change in the full list", () => {
    show(plan([entry("a_b.txt", {
      originalPath: "a:b.txt",
      findings: [{ rule: "name.invalid-char", severity: "info", path: "a:b.txt", message: "substituted", fix: { kind: "rename", to: "a_b.txt" } }],
    })]));
    expect(document.querySelector("del")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Renamed for portability (1)" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("del")!.textContent).toBe(":");
    expect(dialog.querySelector("ins")!.textContent).toBe("_");
    expect(within(dialog).getByText("Renamed from a:b.txt")).toBeTruthy();
  });

  it("lists each path a verification found missing or unexpected", () => {
    const missing = ["a/one.txt", "a/two.txt"];
    render(<JobDetails job={job({ state: "done" })} plan={plan()} events={[]} verify={{
      ok: true,
      data: { reportOk: false, missing, extra: ["stray.bin"], summary: { total: 2, crcFailed: 0, shaMismatched: 0, manifestMismatched: 0 } } as never,
    }} />);
    expect(screen.getByRole("heading", { name: "Missing from the archive 2" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Unexpected extra entries 1" })).toBeTruthy();
    for (const path of [...missing, "stray.bin"]) expect(screen.getByTitle(path)).toBeTruthy();
  });

  it("says when nothing needs a look, and shows the step a working job is on", () => {
    show(plan());
    expect(screen.getByText("Nothing here needs a look.")).toBeTruthy();
    cleanup();
    const events: JobEvent[] = [{
      session: "s", seq: 1, action: "create", run: "1", jobId: "job",
      event: { stage: "write", level: "info", event: "write.start", entries: 3, time: "2026-10-16T08:00:00.000Z" } as never,
    } as JobEvent];
    show(plan(), { state: "running" }, events);
    expect(screen.getByRole("progressbar", { name: "Working" })).toBeTruthy();
    expect(screen.getByText(/^Create · /)).toBeTruthy();
    expect(screen.queryByText("Nothing here needs a look.")).toBeNull();
  });

  it("draws only the rows near the view of a list with thousands of rows", () => {
    show(plan(Array.from({ length: 5000 }, (_, i) => junk(`photos/${i}/.DS_Store`))));
    fireEvent.click(screen.getByRole("button", { name: "Excluded (5,000)" }));
    const drawn = within(screen.getByRole("dialog")).getAllByText(/^photos\//).length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(100);
  });

  it("is not rebuilt when its parent re-renders with the same job, plan and verification", () => {
    const reports = vi.mocked(view.planReport);
    const shown = job();
    const report = plan([junk("a/.DS_Store")]);
    const tree = (tick: number) => <div data-tick={tick}><JobDetails job={shown} plan={report} verify={null} events={[]} /></div>;
    const { rerender } = render(tree(0));
    const first = reports.mock.calls.length;
    rerender(tree(1));
    rerender(tree(2));
    expect(reports.mock.calls.length).toBe(first);
  });
});
