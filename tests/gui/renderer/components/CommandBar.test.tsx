// @vitest-environment jsdom
/**
 * Focus-retention behavior for the command bar (focus/selection policy). When a
 * command the user was on unmounts because the job advanced, focus must not be
 * stranded on <body>; it moves to the bar's new primary. But focus that lives
 * somewhere real (another control, a dialog) is never stolen. The pure command
 * mapping is covered in view.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CommandBar } from "../../../../src/gui/renderer/src/components/CommandBar";
import type { Job } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";

afterEach(cleanup);

const job = (state: Job["state"], over: Partial<Job> = {}): Job => ({
  id: "j",
  inputs: ["/a"],
  options: DEFAULT_OPTIONS,
  intent: "save",
  state,
  ...over,
});

const noop = () => {};

describe("CommandBar focus retention", () => {
  it("moves focus to the new primary when the focused button unmounts", () => {
    const { rerender } = render(<CommandBar job={job("ready")} onCommand={noop} />);
    const create = screen.getByText("Create archive");
    create.focus();
    expect(document.activeElement).toBe(create);
    // Job advances to running: Create unmounts, Cancel takes its place.
    rerender(<CommandBar job={job("running")} onCommand={noop} />);
    expect(document.activeElement).toBe(screen.getByText("Cancel"));
  });

  it("does not steal focus when focus lives on another control", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const { rerender } = render(<CommandBar job={job("ready")} onCommand={noop} />);
    outside.focus();
    rerender(<CommandBar job={job("running")} onCommand={noop} />);
    expect(document.activeElement).toBe(outside); // untouched
    outside.remove();
  });

  it("does not grab focus on mount (selecting a job)", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    render(<CommandBar job={job("ready")} onCommand={noop} />);
    expect(document.activeElement).toBe(outside); // mount never pulls focus
    outside.remove();
  });

  it("falls back to the bar itself when the job becomes blocked (no buttons)", () => {
    const { rerender } = render(<CommandBar job={job("ready")} onCommand={noop} />);
    screen.getByText("Create archive").focus();
    rerender(<CommandBar job={job("needs-attention", { message: "blocked" })} onCommand={noop} />);
    // No buttons to land on, so focus rests on the bar container rather than <body>.
    expect(document.activeElement).not.toBe(document.body);
  });
});
