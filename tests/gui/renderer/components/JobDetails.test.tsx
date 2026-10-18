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
import type { Finding, Job, JobEvent, PlanData, PlannedEntry } from "../../../../src/gui/shared/api";
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
  summary: { total: entries.length, included: 0, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false, sourceBytes: 0 },
  writable: true,
} as PlanData);
const entry = (archivePath: string, over: Partial<PlannedEntry> = {}): PlannedEntry => ({
  archivePath, originalPath: archivePath, diskPath: `/in/${archivePath}`, type: "file", method: "deflate", excluded: false, findings: [], ...over,
});
const junk = (path: string, type: "file" | "dir" = "file") =>
  entry(path, { type, excluded: true, findings: [{ rule: "macos.junk", severity: "info", path, message: "junk" }] });
const blocking = (path: string) => entry(path, { findings: [{ rule: "x.test" as Finding["rule"], severity: "error", path, message: "Blocks the archive" }] });
const show = (p: PlanData | null, over: Partial<Job> = {}, events: JobEvent[] = []) =>
  render(<JobDetails job={job(over)} plan={p} verify={null} events={events} rowLimit={5} />);

describe("JobDetails", () => {
  it("lists names only in a card, each once with its count, and only its count past the limit", () => {
    show(plan([junk("a/.DS_Store"), junk("b/.DS_Store"), junk("c/Thumbs.db")]));
    const card = screen.getByRole("heading", { name: /^Junk files excluded\s*3$/ }).closest("section")!;
    expect(within(card).getAllByRole("listitem").map((item) => item.textContent)).toEqual([".DS_Store (2)", "Thumbs.db"]);
    cleanup();
    show(plan(Array.from({ length: 6 }, (_, i) => blocking(`a/${i}.txt`))));
    const six = screen.getByRole("heading", { name: /^x\.test\s*6$/ }).closest("section")!;
    expect(within(six).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows the existing archive by its name with no count, and leaves what to do to Details", () => {
    const exists = plan();
    exists.findings = [{ rule: "output.exists", severity: "error", path: "/Users/me/Desktop/Desktop.zip", message: "exists" }];
    show(exists);
    const card = screen.getByRole("heading", { name: "Existing output archive" }).closest("section")!;
    expect(within(card).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Desktop.zip"]);
    expect(within(card).queryByText(/Overwrite/)).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Existing output archive" }));
    const dialog = screen.getByRole("dialog", { name: "Existing output archive" });
    expect(within(dialog).getByText(/Turn on “Overwrite an existing file”/)).toBeTruthy();
    expect(within(dialog).getByText("/Users/me/Desktop/Desktop.zip")).toBeTruthy();
  });

  it("lists every item by its full path in Details, saying what they share once", () => {
    show(plan([junk("x/.DS_Store"), junk("y/.DS_Store"), junk("w/Thumbs.db")]));
    fireEvent.click(screen.getByRole("button", { name: "Junk files excluded (3)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/^System clutter from macOS, Windows and Linux/)).toBeTruthy();
    expect(within(dialog).getAllByText(/\//).map((path) => path.textContent)).toEqual(["/in/w/Thumbs.db", "/in/x/.DS_Store", "/in/y/.DS_Store"]);
    // Every item was left out for the same reason, so no row repeats it.
    expect(within(dialog).queryByText("Excluded by the junk preset")).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });

  it("says what is left out goes with the originals when they are to be removed, and raises anything but junk", () => {
    show(plan([junk("a/.DS_Store"), entry("sock", { excluded: true, findings: [{ rule: "entry.unsupported", severity: "info", path: "sock", message: "socket" }] })]),
      { intent: { verify: true, originals: "trash" } });
    expect(screen.getAllByText("These go to the Trash with the originals, without being archived.")).toHaveLength(2);
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    // The socket card is now a warning, so it comes before the junk card.
    expect(titles[0]).toMatch(/^Special files left out/);
    expect(titles[1]).toMatch(/^Junk files excluded/);
  });

  it("marks each change of a rename on the full path in Details", () => {
    show(plan([entry("a/x_0.txt", {
      originalPath: "a/x:0.txt",
      diskPath: "/Users/me/a/x:0.txt",
      findings: [{ rule: "name.invalid-char", severity: "info", path: "a/x:0.txt", message: "substituted", fix: { kind: "rename", to: "a/x_0.txt" } }],
    })]));
    fireEvent.click(screen.getByRole("button", { name: /\(1\)$/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("del")!.textContent).toBe(":");
    expect(dialog.querySelector("ins")!.textContent).toBe("_");
    // Where it is on disk, with the name the archive gives it.
    expect(within(dialog).getByText("/Users/me/a/x_0.txt")).toBeTruthy();
    expect(within(dialog).getByText("Renamed from /Users/me/a/x:0.txt")).toBeTruthy();
  });

  it("lists by name what a verification found missing or unexpected, and each way the originals changed", () => {
    render(<JobDetails job={job({ state: "done", originalsChanges: { missing: ["a/gone.txt"], added: ["a/new.txt"], changed: [], unlisted: [] } })} plan={plan()} events={[]} rowLimit={5} verify={{
      ok: true,
      data: { reportOk: false, missing: ["a/one.txt", "b/two.txt"], extra: ["stray.bin"], summary: { total: 2, crcFailed: 0, shaMismatched: 0, manifestMismatched: 0, localMismatched: 0 } } as never,
    }} />);
    expect(screen.getByRole("heading", { name: /^Missing from the archive\s*2$/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Unexpected extra entries\s*1$/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Gone from the originals since archiving\s*1$/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Added to the originals since archiving\s*1$/ })).toBeTruthy();
    for (const name of ["one.txt", "two.txt", "stray.bin", "gone.txt", "new.txt"]) expect(screen.getByText(name)).toBeTruthy();
  });

  it("states the archive once there is one, with how much of the originals' size it takes", () => {
    show(plan(), { state: "done", output: "/out/a.zip", archiveStatus: "verified", archiveBytes: 208_540_997,
      summary: { total: 36, included: 36, excluded: 0, renamed: 0, warnings: 0, errors: 0, zip64: false, sourceBytes: 336_100_000 } });
    const facts = [...document.querySelectorAll("dt")].map((dt) => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`);
    expect(facts).toEqual(["State: Verified", "Location: /out/a.zip", "Size: 208.5 MB, 62% of the originals’ 336.1 MB", "Items: 36", "Manifest: zipkit.json with SHA-256"]);
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

  it("measures a write that reports how far it has got, by bytes, and sweeps a step that does not", () => {
    render(<JobDetails job={job({ state: "running" })} plan={plan()} verify={null} events={[]} rowLimit={5}
      counts={{ stage: "write", entriesDone: 3, entriesTotal: 12, bytesDone: 2_500_000, bytesTotal: 10_000_000 }} />);
    const bar = screen.getByRole("progressbar", { name: "Working" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("Items 3 of 12 · 2.5 MB of 10 MB")).toBeTruthy();
    cleanup();
    render(<JobDetails job={job({ state: "running" })} plan={plan()} verify={null} events={[]} rowLimit={5} counts={null} />);
    expect(screen.getByRole("progressbar", { name: "Working" }).hasAttribute("aria-valuenow")).toBe(false);
    cleanup();
    // Nothing is measured once the job is no longer working.
    render(<JobDetails job={job({ state: "done" })} plan={plan()} verify={null} events={[]} rowLimit={5}
      counts={{ stage: "extract", entriesDone: 1, entriesTotal: 1, bytesDone: 0, bytesTotal: 0 }} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("draws only the rows near the view of a list with thousands of rows", () => {
    show(plan(Array.from({ length: 5000 }, (_, i) => junk(`photos/${i}/.DS_Store`))));
    fireEvent.click(screen.getByRole("button", { name: "Junk files excluded (5,000)" }));
    const drawn = within(screen.getByRole("dialog")).getAllByText(/^\/in\/photos\//).length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(100);
  });

  it("is not rebuilt when its parent re-renders with the same job, plan and verification", () => {
    const cards = vi.mocked(view.detailsCards);
    const shown = job();
    const report = plan([junk("a/.DS_Store")]);
    const tree = (tick: number) => <div data-tick={tick}><JobDetails job={shown} plan={report} verify={null} events={[]} rowLimit={5} /></div>;
    const { rerender } = render(tree(0));
    const first = cards.mock.calls.length;
    rerender(tree(1));
    rerender(tree(2));
    expect(cards.mock.calls.length).toBe(first);
  });
});
