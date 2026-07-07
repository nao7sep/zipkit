// @vitest-environment jsdom
/**
 * DOM-behavior tests for the queue listbox: the roving single-tab-stop, arrow
 * navigation moving real DOM focus, deterministic recovery (and recovery focus)
 * on Delete, Esc-to-cancel, and the row action buttons being kept out of the tab
 * order. The pure index math is covered separately in listbox-nav.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JobListbox } from "../../../../src/gui/renderer/src/components/JobListbox";
import type { Job } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";

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
    expect(screen.getByTitle("Cancel (Esc)").tabIndex).toBe(-1);
    expect(screen.getByTitle("Remove (Del)").tabIndex).toBe(-1);
  });
});
