// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProgressLog } from "../../../../src/gui/renderer/src/components/ProgressLog";
import type { LogEvent } from "../../../../src/gui/shared/api";

afterEach(cleanup);

describe("ProgressLog", () => {
  it("renders typed events with presentation labels while retaining payload data", () => {
    const events = [
      {
        time: "not-a-time",
        level: "debug",
        event: "session.start",
        version: "0.1.0",
        concurrency: 2,
        chunkSize: 1024,
        message: "zipkit 0.1.0 (concurrency 2, chunk 1024 bytes)",
      },
      {
        time: "not-a-time",
        level: "warn",
        event: "entry.flagged",
        rule: "name.reserved",
        path: "CON.txt",
        severity: "warning",
        message: "warning: name.reserved at CON.txt",
      },
    ] as LogEvent[];

    render(<ProgressLog events={events} />);
    const log = screen.getByText(/ZipKit 0\.1\.0/).textContent ?? "";
    expect(log).toContain("Debug  ZipKit 0.1.0");
    expect(log).toContain("Warning  Finding name.reserved at CON.txt");
    expect(log).not.toContain("  debug  ");
    expect(log).not.toContain("warning: name.reserved");
    expect(events[0]!.message).toBe("zipkit 0.1.0 (concurrency 2, chunk 1024 bytes)");
    const region = screen.getByRole("region", { name: "Progress log" });
    expect(region.getAttribute("aria-live")).toBe("off");
    expect(screen.queryByRole("log")).toBeNull();
  });
});
