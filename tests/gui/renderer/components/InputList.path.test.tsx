// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { InputList } from "../../../../src/gui/renderer/src/components/InputList";
import type { Job } from "../../../../src/gui/shared/api";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";

afterEach(cleanup);

const path = "/Users/me/Projects/client/deliverables/final-report.pdf";
const job: Job = {
  id: "job-1",
  inputs: [path],
  entries: [{ path, kind: "file" }],
  options: DEFAULT_OPTIONS,
  intent: "save",
  state: "done",
};

describe("an input's path", () => {
  it("shows one line keeping its final segment, and reveals the whole path by pointer, touch or keyboard", () => {
    render(
      <InputList
        job={job}
        editable={false}
        onAdd={async () => null}
        onRemove={() => {}}
        onDropFiles={async () => ({ operationKey: "noop", entryKey: "noop", result: null })}
        result={null}
        onResult={() => {}}
      />,
    );
    const toggle = screen.getByRole("button", { name: path });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".path-line__tail")?.textContent).toBe("/final-report.pdf");
    // A locked job still lets the user read its inputs.
    expect((toggle as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.querySelector(".path-line")).toBeNull();
    expect(toggle.querySelector(".path-toggle__whole")?.textContent).toBe(path);

    fireEvent.click(toggle);
    expect(toggle.querySelector(".path-line__tail")?.textContent).toBe("/final-report.pdf");
  });
});
