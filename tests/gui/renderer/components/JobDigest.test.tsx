// @vitest-environment jsdom
/**
 * The control panel's digest and history: the history lists what happened in
 * order, and a new line or a changed digest is announced once, an error
 * assertively and anything else politely, while what was already there when
 * the job was selected stays quiet.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { JobDigest } from "../../../../src/gui/renderer/src/components/JobDigest";
import type { Job } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";
import { message } from "../../../../src/gui/shared/i18n/translate";
import { SAVE } from "../../../helpers/intents.js";

afterEach(cleanup);

const job = (over: Partial<Job> = {}): Job => ({ id: "job", inputs: ["/input"], options: DEFAULT_OPTIONS, intent: SAVE, state: "done", ...over });
const live = (kind: "assertive" | "polite") => document.querySelector<HTMLElement>(`[aria-live='${kind}']`)!;
const saved = { at: 1, severity: "info" as const, message: message("job.saved", { count: 12 }) };

describe("JobDigest", () => {
  it("lists the history in order and keeps what was there on selection quiet", () => {
    render(<JobDigest job={job({ history: [saved, { at: 2, severity: "warning", message: message("report.archiveChanged") }] })} digest={null} />);
    const items = within(screen.getByRole("list", { name: "History" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Saved (12 bytes).",
      "The archive has changed since ZipKit last checked it. Verify it again.",
    ]);
    expect(live("assertive").textContent).toBe("");
    expect(live("polite").textContent).toBe("");
  });

  it("announces a failure added to the history assertively, as one atomic line", () => {
    const { rerender } = render(<JobDigest job={job({ history: [saved] })} digest={null} />);
    rerender(<JobDigest job={job({ history: [saved, { at: 2, severity: "error", message: message("action.originalsTrashFailed") }] })} digest={null} />);
    expect(live("assertive").textContent).toContain("The originals could not be moved to Trash");
    expect(live("assertive").getAttribute("aria-atomic")).toBe("true");
    expect(live("polite").textContent).toBe("");
  });

  it("announces a changed digest politely without making the history live", () => {
    const { rerender } = render(<JobDigest job={job({ state: "planning" })} digest={null} />);
    rerender(<JobDigest job={job({ state: "ready" })} digest={{ level: "info", text: "1 item is ready to archive." }} />);
    expect(live("polite").textContent).toBe("1 item is ready to archive.");
    expect(screen.getByText("1 item is ready to archive.", { selector: "p" }).closest("[aria-live]")).toBeNull();
  });
});
