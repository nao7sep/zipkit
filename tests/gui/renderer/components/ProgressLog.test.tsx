// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProgressLog } from "../../../../src/gui/renderer/src/components/ProgressLog";
import type { JobEvent, LogEvent } from "../../../../src/gui/shared/api";

afterEach(cleanup);

const recorded = (seq: number, event: Record<string, unknown>): JobEvent => ({
  jobId: "job",
  session: "2026-06-14T05:00:00.000Z",
  seq,
  event: { time: "not-a-time", stage: "plan", level: "info", message: "", ...event } as LogEvent,
});

describe("ProgressLog", () => {
  it("shows each run's time once, a level only where it is worth stopping at, and findings by kind", () => {
    const events = [
      recorded(1, { event: "session.start", version: "0.1.0", concurrency: 2, chunkSize: 1024 }),
      recorded(2, { event: "scan.start", inputs: 1 }),
      recorded(3, { event: "entry.flagged", level: "warn", rule: "name.reserved", path: "CON.txt", severity: "warning", message: "warning: name.reserved at CON.txt" }),
      recorded(4, { event: "entry.flagged", level: "warn", rule: "name.reserved", path: "PRN.txt", severity: "warning" }),
      recorded(5, { event: "write.start", entries: 2 }),
    ];

    render(<ProgressLog events={events} />);
    const region = screen.getByRole("region", { name: "Progress log" });
    const lines = [...region.querySelectorAll("section > div")].map((line) => line.textContent);
    expect(lines).toEqual([
      "not-a-time",
      "Scanning 1 input",
      "WarningReserved device names: 2 entries",
      "not-a-time",
      "Writing 2 entries",
    ]);
    // The SDK's own startup line belongs to no job.
    expect(region.textContent).not.toContain("ZipKit 0.1.0");
    const warning = screen.getByText("Warning");
    expect(warning.style.color).toBe("var(--status-warning)");
    expect(warning.style.fontWeight).toBe("700");
    expect(screen.queryByText("Info")).toBeNull();
    expect(region.getAttribute("aria-live")).toBe("off");
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("says there is nothing to show before the first run", () => {
    render(<ProgressLog events={[recorded(1, { event: "session.start", version: "0.1.0", concurrency: 2, chunkSize: 1024 })]} />);
    expect(screen.getByText("Nothing to show yet.")).toBeTruthy();
  });
});
