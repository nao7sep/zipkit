// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Report } from "../../../../src/gui/renderer/src/components/Report";
import * as view from "../../../../src/gui/renderer/src/view";

// Counted, so a test can tell whether the report rendered again.
vi.mock("../../../../src/gui/renderer/src/view", async (original) => {
  const real = await original<typeof import("../../../../src/gui/renderer/src/view")>();
  return { ...real, reportSummary: vi.fn(real.reportSummary) };
});
import type { Job, PlanData } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";
import { message } from "../../../../src/gui/shared/i18n/translate";
import { SAVE } from "../../../helpers/intents.js";

afterEach(cleanup);

const job = (over: Partial<Job> = {}): Job => ({
  id: "job",
  inputs: ["/input"],
  options: DEFAULT_OPTIONS,
  intent: SAVE,
  state: "ready",
  ...over,
});

const plan = (warnings = 0): PlanData => ({
  mode: "plan",
  output: "/output.zip",
  log: "/log",
  entries: [],
  findings: [],
  summary: {
    total: 1,
    included: 1,
    excluded: 0,
    renamed: 0,
    warnings,
    errors: 0,
    zip64: false,
  },
  writable: true,
} as PlanData);

describe("Report result announcements", () => {
  it("announces an actionable job failure assertively as one atomic headline", () => {
    const { rerender } = render(
      <Report job={job({ state: "planning" })} plan={null} verify={null} />,
    );
    const live = document.querySelector<HTMLElement>("[aria-live='assertive']")!;
    expect(live.textContent).toBe("");

    rerender(<Report job={job({ state: "failed", message: message("job.writeFailed") })} plan={null} verify={null} />);

    expect(live.textContent).toBe(
      "The archive could not be written. Check the output location and available storage, then try again.",
    );
    expect(live.getAttribute("aria-atomic")).toBe("true");
  });

  it("announces a ready or warning headline politely without making every report row live", () => {
    const withFinding = {
      ...plan(1),
      findings: [{ rule: "name.test", severity: "warning", path: "a", message: "Review this name" }],
    } as PlanData;
    const { rerender } = render(
      <Report job={job({ state: "planning" })} plan={null} verify={null} />,
    );
    const live = document.querySelector<HTMLElement>("[aria-live='polite']")!;
    expect(live.textContent).toBe("");

    rerender(<Report job={job()} plan={withFinding} verify={null} />);

    expect(screen.getAllByText(/ready to archive/)).toHaveLength(2);
    expect(screen.getByText("Review this name").closest("[aria-live], [role='alert'], [role='status']")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(live.textContent).toContain("ready to archive");
  });

  it("announces a follow-up job action failure at the selected job report", () => {
    const base = job({ state: "done", message: message("job.saved", { count: 12 }) });
    const { rerender } = render(
      <Report job={base} plan={plan()} verify={null} />,
    );
    const live = document.querySelector<HTMLElement>("[aria-live='assertive']")!;

    rerender(
      <Report
        job={{
          ...base,
          actionResult: { severity: "error", message: message("action.originalsTrashFailed") },
        }}
        plan={plan()}
        verify={null}
      />,
    );

    expect(live.textContent).toContain("The originals could not be moved to Trash");
  });

  it("announces an IPC verification fault without turning the detail rows into live regions", () => {
    const done = job({ state: "done" });
    const currentPlan = plan();
    const { rerender } = render(
      <Report job={done} plan={currentPlan} verify={null} />,
    );
    const live = document.querySelector<HTMLElement>("[aria-live='assertive']")!;

    rerender(
      <Report
        job={done}
        plan={currentPlan}
        verify={{
          ok: false,
          error: {
            type: "IoError",
            code: "verify.failed",
            presentation: message("error.readFailed"),
          },
        }}
      />,
    );

    expect(live.textContent).toContain("The archive could not be read");
    expect(live.textContent).not.toContain("archive unreadable");
  });
});

describe("Report renamed rows", () => {
  const renamedPlan = (from: string, to: string): PlanData =>
    ({
      ...plan(),
      entries: [
        {
          archivePath: to,
          originalPath: from,
          type: "file",
          method: "deflate",
          excluded: false,
          findings: [{ rule: "name.invalid-char", severity: "info", path: from, message: "substituted", fix: { kind: "rename", to } }],
        },
      ],
    }) as PlanData;

  it("marks the change visually and gives a screen reader the path and its old name", () => {
    render(<Report job={job()} plan={renamedPlan("a:b.txt", "a_b.txt")} verify={null} />);
    const removed = document.querySelector("del")!;
    const added = document.querySelector("ins")!;
    expect(removed.textContent).toBe(":");
    expect(added.textContent).toBe("_");
    expect(removed.closest("[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByText("Renamed from a:b.txt")).toBeTruthy();
    expect(screen.getByText("a_b.txt", { exact: false, selector: "span" })).toBeTruthy();
  });

  it("shows an NFD-only rename as the one path, with no marks", () => {
    const nfd = "cafe\u0301.txt";
    const nfc = nfd.normalize("NFC");
    const p = renamedPlan(nfd, nfc);
    p.entries[0]!.findings = [{ rule: "name.nfd", severity: "info", path: nfd, message: "normalized", fix: { kind: "rename", to: nfc } }];
    render(<Report job={job()} plan={p} verify={null} />);
    expect(document.querySelector("del")).toBeNull();
    expect(screen.getByText(nfc)).toBeTruthy();
    expect(screen.getByText("Name normalized from NFD to NFC")).toBeTruthy();
  });
});

describe("Report verification paths", () => {
  it("lists each missing and unexpected path on its own row under a counted heading", () => {
    const missing = ["a/one.txt", "a/two.txt", "a/three.txt", "a/four.txt"];
    render(
      <Report
        job={job({ state: "done" })}
        plan={plan()}
        verify={{
          ok: true,
          data: {
            reportOk: false,
            missing,
            extra: ["stray.bin"],
            summary: { total: 4, crcFailed: 0, shaMismatched: 0, manifestMismatched: 0 },
          } as never,
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Missing from the archive (4)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Unexpected extra entries (1)" })).toBeTruthy();
    for (const path of [...missing, "stray.bin"]) expect(screen.getByText(path).tagName).toBe("SPAN");
  });
});

describe("Report at volume", () => {
  const many = (count: number) => ({
    ...plan(),
    entries: Array.from({ length: count }, (_, i) => ({
      archivePath: `photos/IMG_${i}.HEIC`, originalPath: `photos/IMG_${i}.heic`,
      type: "file" as const, method: "deflate" as const, excluded: false, findings: [],
    })),
  }) as PlanData;

  it("draws only the rows near the pane's view of a report with thousands of rows", () => {
    // jsdom lays nothing out: each line measures 40 px and the pane 600 px.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 0, bottom: 40, height: 40, width: 600, left: 0, right: 600, x: 0, y: 0, toJSON() {} } as DOMRect);
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
    try {
      render(<div style={{ overflowY: "auto", height: 600 }}><Report job={job()} plan={many(5000)} verify={null} /></div>);
      expect(screen.getByRole("heading", { name: "Renamed for portability (5,000)" })).toBeTruthy();
      const drawn = screen.getAllByText(/^photos\/IMG_/).length;
      expect(drawn).toBeGreaterThan(0);
      expect(drawn).toBeLessThan(100);
    } finally { rect.mockRestore(); Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight); }
  });

  it("is not rebuilt when its parent re-renders with the same job, plan and verification", () => {
    const summaries = vi.mocked(view.reportSummary);
    const shown = job();
    const report = many(3);
    const view_ = (tick: number) => <div data-tick={tick}><Report job={shown} plan={report} verify={null} /></div>;
    const { rerender } = render(view_(0));
    const first = summaries.mock.calls.length;
    rerender(view_(1));
    rerender(view_(2));
    expect(summaries.mock.calls.length).toBe(first);
  });

});
