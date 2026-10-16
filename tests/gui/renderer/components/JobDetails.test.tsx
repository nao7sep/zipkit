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
  return { ...real, detailsCards: vi.fn(real.detailsCards) };
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
  it("shows a blocking card's first rows, unfolds the rest in place, and opens all of them in the list", () => {
    show(plan(Array.from({ length: 7 }, (_, i) => blocking(`a/${i}.txt`))));
    const fold = screen.getByRole("button", { name: /^x\.test\s*7$/ });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTitle(/^a\/\d\.txt$/)).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getAllByTitle(/^a\/\d\.txt$/)).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getAllByTitle(/^a\/\d\.txt$/)).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "x.test (7)" }));
    const dialog = screen.getByRole("dialog", { name: "x.test (7)" });
    expect(within(dialog).getAllByText(/^\d\.txt$/)).toHaveLength(7);
  });

  it("shows a short informational card's rows without a click, and folds a long one to its count", () => {
    show(plan([
      junk("a/.DS_Store"), junk("b/.DS_Store"),
      ...Array.from({ length: 6 }, (_, i) => entry(`empty${i}`, { type: "dir", excluded: true, excludeReason: "empty directory pruned" })),
    ]));
    const junkCard = screen.getByRole("button", { name: /^Junk files excluded\s*2$/ });
    expect(junkCard.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTitle(/\.DS_Store$/)).toHaveLength(2);
    const pruned = screen.getByRole("button", { name: /^Empty directory pruned\s*6$/ });
    expect(pruned.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTitle("empty0")).toBeNull();
    fireEvent.click(pruned);
    expect(screen.getAllByTitle(/^empty\d$/)).toHaveLength(5);
  });

  it("says what is left out goes with the originals when they are to be removed, and raises anything but junk", () => {
    show(plan([junk("a/.DS_Store"), entry("sock", { excluded: true, findings: [{ rule: "entry.unsupported", severity: "info", path: "sock", message: "socket" }] })]),
      { intent: { verify: true, originals: "trash" } });
    expect(screen.getAllByText("These go to the Trash with the originals, without being archived.")).toHaveLength(2);
    const cards = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent);
    // The socket card is now a warning, so it comes before the junk card.
    expect(cards[0]).toMatch(/^Special files left out/);
    expect(cards[1]).toMatch(/^Junk files excluded/);
  });

  it("groups the names that repeat, folders first, lists the rest plainly, and remembers the order chosen", () => {
    show(plan([junk("x/.DS_Store"), junk("y/.DS_Store"), junk("z/.Trashes", "dir"), junk("v/.Trashes", "dir"), junk("w/Thumbs.db"), junk("u/desktop.ini")]));
    fireEvent.click(screen.getByRole("button", { name: "Junk files excluded (6)" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "By name" }));
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([".Trashes (2)", ".DS_Store (2)"]);
    // A name that occurs once is a plain row: its name, then its folder.
    expect(within(dialog).getByText("Thumbs.db")).toBeTruthy();
    expect(within(dialog).getByText("w")).toBeTruthy();
    expect(localStorage.getItem("zipkit.listOrder")).toBe("name");
    fireEvent.click(within(dialog).getByText("Close", { selector: "button" }));
    fireEvent.click(screen.getByRole("button", { name: "Junk files excluded (6)" }));
    expect(within(screen.getByRole("dialog")).getByRole("radio", { name: "By name" }).getAttribute("aria-checked")).toBe("true");
  });

  it("marks each change of a rename in the full list", () => {
    const renames = Array.from({ length: 6 }, (_, i) => entry(`a_${i}.txt`, {
      originalPath: `a:${i}.txt`,
      findings: [{ rule: "name.invalid-char", severity: "info", path: `a:${i}.txt`, message: "substituted", fix: { kind: "rename", to: `a_${i}.txt` } }],
    }));
    show(plan(renames));
    fireEvent.click(screen.getByRole("button", { name: /\(6\)$/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("del")!.textContent).toBe(":");
    expect(dialog.querySelector("ins")!.textContent).toBe("_");
    expect(within(dialog).getByText("Renamed from a:0.txt")).toBeTruthy();
  });

  it("lists each path a verification found missing or unexpected, and how the originals changed", () => {
    const missing = ["a/one.txt", "a/two.txt"];
    render(<JobDetails job={job({ state: "done", originalsChanges: { missing: ["gone.txt"], added: [], changed: [], unlisted: [] } })} plan={plan()} events={[]} verify={{
      ok: true,
      data: { reportOk: false, missing, extra: ["stray.bin"], summary: { total: 2, crcFailed: 0, shaMismatched: 0, manifestMismatched: 0 } } as never,
    }} />);
    expect(screen.getByRole("button", { name: /^Missing from the archive\s*2$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Unexpected extra entries\s*1$/ })).toBeTruthy();
    for (const path of [...missing, "stray.bin", "gone.txt"]) expect(screen.getByTitle(path)).toBeTruthy();
    expect(screen.getByText("No longer there")).toBeTruthy();
  });

  it("states the archive once there is one", () => {
    show(plan(), { state: "done", output: "/out/a.zip", archiveStatus: "verified", archiveBytes: 208_540_997,
      summary: { total: 36, included: 36, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false } });
    const facts = [...document.querySelectorAll("dt")].map((dt) => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`);
    expect(facts).toEqual(["State: Verified", "Location: /out/a.zip", "Size: 208.5 MB", "Items: 36", "Manifest: zipkit.json with SHA-256"]);
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
    fireEvent.click(screen.getByRole("button", { name: "Junk files excluded (5,000)" }));
    const drawn = within(screen.getByRole("dialog")).getAllByText(/^photos\//).length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(100);
  });

  it("is not rebuilt when its parent re-renders with the same job, plan and verification", () => {
    const cards = vi.mocked(view.detailsCards);
    const shown = job();
    const report = plan([junk("a/.DS_Store")]);
    const tree = (tick: number) => <div data-tick={tick}><JobDetails job={shown} plan={report} verify={null} events={[]} /></div>;
    const { rerender } = render(tree(0));
    const first = cards.mock.calls.length;
    rerender(tree(1));
    rerender(tree(2));
    expect(cards.mock.calls.length).toBe(first);
  });
});
