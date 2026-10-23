// @vitest-environment jsdom

/** Verification cards describe one observed archive, even while the selected
 * job keeps the same terminal state and archive status. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../src/gui/renderer/src/App";
import { DialogHost } from "../../../src/gui/renderer/src/components/DialogHost";
import type { Job, VerifyResult, ZipKitGuiApi } from "../../../src/gui/shared/api";
import { DEFAULT_LAYOUT } from "../../../src/gui/shared/layout";
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS } from "../../../src/gui/shared/spec";
import { SAVE } from "../../helpers/intents.js";

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

const finished: Job = {
  id: "job-1",
  inputs: ["/tmp/source.txt"],
  entries: [{ path: "/tmp/source.txt", kind: "file" }],
  options: DEFAULT_OPTIONS,
  intent: SAVE,
  state: "done",
  output: "/tmp/source.zip",
  archiveWritten: true,
  archiveStatus: "changed",
  archiveRevision: 1,
};

const differences: VerifyResult = {
  ok: true,
  data: {
    ok: false,
    summary: { total: 3, crc32Failed: 0, unreadable: 0, localMismatched: 0, sha256Mismatched: 0, manifestMismatched: 0 },
    missing: ["first-missing.txt", "second-missing.txt"],
    extra: ["unexpected.txt"],
  },
};

beforeEach(() => { vi.stubGlobal("ResizeObserver", ResizeObserverStub); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function selectedJob() {
  let publish!: (jobs: Job[]) => void;
  const verify = vi.fn<ZipKitGuiApi["verify"]>().mockResolvedValue(differences);
  const getJobEvents = vi.fn(async () => []);
  Object.defineProperty(window, "zipkit", {
    configurable: true,
    value: {
      onQueue: (listener: (jobs: Job[]) => void) => { publish = listener; return () => {}; },
      onQueueSaved: () => () => {},
      getQueue: async () => [finished],
      onSettingsChanged: () => () => {},
      getSettingsSubmission: async () => null,
      onSettingsSubmissionChanged: () => () => {},
      onOpenAbout: () => () => {},
      getSettings: async () => DEFAULT_SETTINGS,
      getLayout: async () => DEFAULT_LAYOUT,
      getPlan: async () => null,
      refreshJob: async () => {},
      getJobEvents,
      onEvents: () => () => {},
      onProgress: () => () => {},
      verify,
      reportError: vi.fn(),
    },
  });
  render(<DialogHost><App /></DialogHost>);
  const row = await screen.findByRole("option");
  fireEvent.click(row);
  await screen.findByRole("button", { name: "Verify" });
  return { verify, getJobEvents, row, publish: (revision: number) => publish([{ ...finished, archiveRevision: revision }]) };
}

function expectNoDifferences(): void {
  expect(screen.queryByText("Missing from the archive")).toBeNull();
  expect(screen.queryByText("Unexpected extra entries")).toBeNull();
}

async function expectDifferences(): Promise<void> {
  const missing = await screen.findByText("Missing from the archive");
  expect(missing.closest("h3")?.textContent).toBe("Missing from the archive 2");
  expect(screen.getByText("Unexpected extra entries").closest("h3")?.textContent).toBe("Unexpected extra entries 1");
}

describe("manual verification archive revision", () => {
  it("clears real missing/extra cards on repeated archive changes while the same done job stays selected", async () => {
    const app = await selectedJob();
    for (const revision of [2, 3]) {
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
      await expectDifferences();
      await act(async () => app.publish(revision));
      expectNoDifferences();
      expect(screen.getByRole("option")).toBe(app.row);
      expect(app.row.getAttribute("aria-selected")).toBe("true");
    }
    expect(app.verify).toHaveBeenNthCalledWith(1, "job-1");
    expect(app.verify).toHaveBeenNthCalledWith(2, "job-1");
    expect(app.getJobEvents).toHaveBeenCalledTimes(1);
  });

  it("ignores a deferred verification response for an earlier archive revision", async () => {
    const app = await selectedJob();
    let resolve!: (result: VerifyResult) => void;
    app.verify.mockImplementationOnce(() => new Promise<VerifyResult>((settle) => { resolve = settle; }));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(app.verify).toHaveBeenCalledWith("job-1");
    await act(async () => app.publish(2));
    await act(async () => resolve(differences));
    expectNoDifferences();
    expect(app.row.getAttribute("aria-selected")).toBe("true");
    expect(app.getJobEvents).toHaveBeenCalledTimes(1);
    // A new verification of the current archive still publishes its report.
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await expectDifferences();
  });
});
