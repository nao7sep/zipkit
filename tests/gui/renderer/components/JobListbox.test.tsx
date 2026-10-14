// @vitest-environment jsdom
/**
 * DOM-behavior tests for the queue listbox: the roving single-tab-stop, arrow
 * navigation moving real DOM focus, deterministic recovery (and recovery focus)
 * on Delete, Esc-to-cancel, and the row action buttons being kept out of the tab
 * order. The pure index math is covered separately in listbox-nav.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JobListbox } from "../../../../src/gui/renderer/src/components/JobListbox";
import type { Job } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";
import { message } from "../../../../src/gui/shared/i18n/translate";

afterEach(cleanup);

const job = (id: string, state: Job["state"] = "ready"): Job => ({
  id,
  inputs: [`/${id}`],
  options: DEFAULT_OPTIONS,
  intent: "save",
  state,
});

const rows = () => screen.getAllByRole("option");

const noop = () => {};

// One render helper so the required props all have defaults in a single place;
// each test overrides only what it exercises.
type Props = Parameters<typeof JobListbox>[0];
const renderListbox = (props: Partial<Props> & Pick<Props, "jobs" | "selectedId">) =>
  render(
    <JobListbox
      pullFocusId={null}
      onFocusPulled={noop}
      onSelect={noop}
      onRemove={noop}
      onCancel={noop}
      {...props}
    />,
  );

describe("JobListbox", () => {
  it("identifies a job on two one-line rows: its name and a summary of its status", () => {
    const failed: Job = { ...job("a", "failed"), inputs: ["/a/very-long-folder-name-that-would-not-fit-the-jobs-pane"],
      message: message("error.readFailed") };
    renderListbox({ jobs: [failed], selectedId: "a" });
    const name = screen.getByText("very-long-folder-name-that-would-not-fit-the-jobs-pane");
    expect(name.className).toBe("text-line");
    expect(screen.getByText(/could not be read/).className).toBe("text-line");
  });

  it("is one tab stop: only the selected option is tabbable", () => {
    renderListbox({ jobs: [job("a"), job("b"), job("c")], selectedId: "b" });
    const [a, b, c] = rows();
    expect(a!.tabIndex).toBe(-1);
    expect(b!.tabIndex).toBe(0);
    expect(c!.tabIndex).toBe(-1);
    expect(b!.getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown moves selection and DOM focus to the next option", () => {
    const onSelect = vi.fn();
    renderListbox({ jobs: [job("a"), job("b"), job("c")], selectedId: "a", onSelect });
    rows()[0]!.focus();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("keeps selection and keyboard actions on their target through hover, and selects the clicked job", () => {
    const onRemove = vi.fn();
    function List() {
      const [selectedId, onSelect] = useState<string | null>("a");
      return <JobListbox jobs={[job("a"), job("b", "failed"), job("c", "done")]}
        selectedId={selectedId} onSelect={onSelect} onRemove={onRemove}
        onCancel={noop} pullFocusId={null} onFocusPulled={noop} />;
    }
    render(<List />);
    const [a, b, c] = rows();
    a!.focus();
    fireEvent.keyDown(a!, { key: "ArrowDown" });
    const tint = b!.style.getPropertyValue("--job-tint");
    const selectedBorder = b!.style.borderColor;
    expect(tint).not.toBe("");
    expect(selectedBorder).not.toBe("");
    for (const hovered of [a!, b!]) {
      fireEvent.pointerMove(hovered, { pointerType: "mouse" });
      fireEvent.pointerLeave(hovered, { pointerType: "mouse" });
      expect(document.activeElement).toBe(b);
      expect(b!.getAttribute("aria-selected")).toBe("true");
      expect(b!.style.getPropertyValue("--job-tint")).toBe(tint);
      expect(b!.style.borderColor).toBe(selectedBorder);
    }
    fireEvent.keyDown(b!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: "Delete" });
    expect(onRemove).toHaveBeenCalledWith("c");
    fireEvent.click(a!);
    expect(document.activeElement).toBe(a);
    expect(a!.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the keyboard target on the same job through live updates and reordering", () => {
    const onRemove = vi.fn();
    const props = { onSelect: noop, onRemove, onCancel: noop, pullFocusId: null, onFocusPulled: noop };
    const { rerender } = render(<JobListbox jobs={[job("a"), job("b"), job("c")]} selectedId="b" {...props} />);
    const b = rows()[1]!;
    b.focus();
    rerender(<JobListbox jobs={[job("new"), job("c", "done"), job("b", "failed"), job("a")]} selectedId="b" {...props} />);
    expect(document.activeElement).toBe(b);
    expect(b.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(b, { key: "Delete" });
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("Delete on the active row recovers to the neighbor (selection + focus) and removes it", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    renderListbox({ jobs: [job("a"), job("b"), job("c")], selectedId: "a", onSelect, onRemove });
    rows()[0]!.focus();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Delete" });
    expect(onSelect).toHaveBeenCalledWith("b"); // next slides into place
    expect(document.activeElement).toBe(rows()[1]); // focus moved before unmount
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("Backspace uses the same removal binding as Delete", () => {
    const onRemove = vi.fn();
    renderListbox({ jobs: [job("a")], selectedId: "a", onRemove });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Backspace" });
    expect(onRemove).toHaveBeenCalled();
  });

  it("Esc cancels a running active row; Delete is ignored on it", () => {
    const onCancel = vi.fn();
    const onRemove = vi.fn();
    renderListbox({ jobs: [job("a", "running")], selectedId: "a", onRemove, onCancel });
    const list = screen.getByRole("listbox");
    rows()[0]!.focus();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledWith("a");
    fireEvent.keyDown(list, { key: "Delete" });
    expect(onRemove).not.toHaveBeenCalled(); // a running job is not removable
  });

  it("a job moving files to Trash offers Cancel but no ✕, and ignores Delete", () => {
    const onCancel = vi.fn();
    const onRemove = vi.fn();
    renderListbox({ jobs: [{ ...job("a", "done"), trashing: true }], selectedId: "a", onRemove, onCancel });
    const list = screen.getByRole("listbox");
    rows()[0]!.focus();
    expect(screen.queryByTitle("Remove (Delete)")).toBeNull();
    fireEvent.keyDown(list, { key: "Delete" });
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledWith("a");
  });

  it("Esc cancels a queued active row, and a queued job is still removable", () => {
    const onCancel = vi.fn();
    const onRemove = vi.fn();
    renderListbox({ jobs: [job("a", "queued")], selectedId: "a", onRemove, onCancel });
    const list = screen.getByRole("listbox");
    rows()[0]!.focus();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledWith("a"); // cancel = pull it back out of the queue
    fireEvent.keyDown(list, { key: "Delete" });
    expect(onRemove).toHaveBeenCalledWith("a"); // unlike running, a queued job can be removed
  });

  it("pullFocusId focuses that row even when focus is outside the list, then clears it", () => {
    const onFocusPulled = vi.fn();
    renderListbox({ jobs: [job("a"), job("b")], selectedId: "a", pullFocusId: "b", onFocusPulled });
    expect(document.activeElement).toBe(rows()[1]); // focus pulled to b from outside
    expect(onFocusPulled).toHaveBeenCalledTimes(1); // one-shot
  });

  it("keeps the row action buttons out of the tab order", () => {
    renderListbox({ jobs: [job("a", "planning")], selectedId: "a" });
    expect(screen.getByTitle("Cancel (Escape)").tabIndex).toBe(-1);
    expect(screen.getByTitle("Remove (Delete)").tabIndex).toBe(-1);
  });

  it("shows a job result in the interface language without changing the stored message", () => {
    const saved = { ...job("a", "done"), message: message("job.saved", { count: 2048 }) };
    renderListbox({ jobs: [saved], selectedId: "a" });
    expect(screen.getByText("Saved (2,048 bytes).")).toBeTruthy();
    expect(saved.message).toEqual({ key: "job.saved", values: { count: 2048 } });
  });

  it("announces only actionable job states assertively", () => {
    const { rerender } = renderListbox({ jobs: [job("a")], selectedId: "a" });
    const live = document.querySelector<HTMLElement>("[aria-live='assertive']")!;
    expect(live.textContent).toBe("");

    rerender(
      <JobListbox
        jobs={[{ ...job("a", "failed"), message: message("job.writeFailed") }]}
        selectedId={null}
        pullFocusId={null}
        onFocusPulled={noop}
        onSelect={noop}
        onRemove={noop}
        onCancel={noop}
      />,
    );

    expect(live.textContent).toContain("a");
    expect(live.textContent).toContain("could not be written");
  });

  it("does not re-announce a restored failure or an existing failure on selection change", () => {
    const failed = { ...job("a", "failed"), message: message("job.writeFailed") };
    const { rerender } = renderListbox({ jobs: [failed], selectedId: "a" });
    const live = document.querySelector<HTMLElement>("[aria-live='assertive']")!;
    expect(live.textContent).toBe("");

    rerender(
      <JobListbox
        jobs={[failed]}
        selectedId={null}
        pullFocusId={null}
        onFocusPulled={noop}
        onSelect={noop}
        onRemove={noop}
        onCancel={noop}
      />,
    );
    expect(live.textContent).toBe("");
  });
});
