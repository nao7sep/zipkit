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

describe("JobListbox", () => {
  it("is one tab stop: only the selected option is tabbable", () => {
    render(
      <JobListbox jobs={[job("a"), job("b"), job("c")]} selectedId="b" onSelect={noop} onRemove={noop} onCancel={noop} />,
    );
    const [a, b, c] = rows();
    expect(a!.tabIndex).toBe(-1);
    expect(b!.tabIndex).toBe(0);
    expect(c!.tabIndex).toBe(-1);
    expect(b!.getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown moves selection and DOM focus to the next option", () => {
    const onSelect = vi.fn();
    render(
      <JobListbox jobs={[job("a"), job("b"), job("c")]} selectedId="a" onSelect={onSelect} onRemove={noop} onCancel={noop} />,
    );
    rows()[0]!.focus();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("Delete on the active row recovers to the neighbor (selection + focus) and removes it", () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    render(
      <JobListbox jobs={[job("a"), job("b"), job("c")]} selectedId="a" onSelect={onSelect} onRemove={onRemove} onCancel={noop} />,
    );
    rows()[0]!.focus();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Delete" });
    expect(onSelect).toHaveBeenCalledWith("b"); // next slides into place
    expect(document.activeElement).toBe(rows()[1]); // focus moved before unmount
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("Esc cancels a running active row; Delete is ignored on it", () => {
    const onCancel = vi.fn();
    const onRemove = vi.fn();
    render(
      <JobListbox jobs={[job("a", "running")]} selectedId="a" onSelect={noop} onRemove={onRemove} onCancel={onCancel} />,
    );
    const list = screen.getByRole("listbox");
    rows()[0]!.focus();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledWith("a");
    fireEvent.keyDown(list, { key: "Delete" });
    expect(onRemove).not.toHaveBeenCalled(); // a running job is not removable
  });

  it("keeps the row action buttons out of the tab order", () => {
    render(
      <JobListbox jobs={[job("a", "planning")]} selectedId="a" onSelect={noop} onRemove={noop} onCancel={noop} />,
    );
    expect(screen.getByTitle("Cancel (Esc)").tabIndex).toBe(-1);
    expect(screen.getByTitle("Remove (Del)").tabIndex).toBe(-1);
  });
});
