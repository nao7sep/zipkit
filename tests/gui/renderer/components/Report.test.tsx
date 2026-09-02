// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Report } from "../../../../src/gui/renderer/src/components/Report";
import type { Job, PlanData } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";

afterEach(cleanup);

const job = (over: Partial<Job> = {}): Job => ({
  id: "job",
  inputs: ["/input"],
  options: DEFAULT_OPTIONS,
  intent: "save",
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

    rerender(<Report job={job({ state: "failed", message: "disk full" })} plan={null} verify={null} />);

    expect(live.textContent).toBe("Disk full");
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
    expect(screen.getByText("Review this name").closest("li")?.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(live.textContent).toContain("ready to archive");
  });

  it("announces a follow-up job action failure at the selected job report", () => {
    const base = job({ state: "done", message: "saved (12 bytes)" });
    const { rerender } = render(
      <Report job={base} plan={plan()} verify={null} />,
    );
    const live = document.querySelector<HTMLElement>("[aria-live='assertive']")!;

    rerender(
      <Report
        job={{
          ...base,
          actionResult: { severity: "error", message: "Could not move the originals to Trash." },
        }}
        plan={plan()}
        verify={null}
      />,
    );

    expect(live.textContent).toContain("Could not move the originals");
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
          error: { type: "IoError", code: "verify.failed", message: "archive unreadable" },
        }}
      />,
    );

    expect(live.textContent).toContain("Verification could not be completed");
    expect(live.textContent).toContain("archive unreadable");
  });
});
