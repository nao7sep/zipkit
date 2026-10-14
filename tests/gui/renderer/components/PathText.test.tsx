// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PathText, splitPath } from "../../../../src/gui/renderer/src/components/PathText";

afterEach(cleanup);

describe("splitPath", () => {
  it.each([
    ["/Users/me/Documents/report.pdf", "/Users/me/Documents", "/report.pdf"],
    ["C:\\Users\\me\\report.pdf", "C:\\Users\\me", "\\report.pdf"],
    ["report.pdf", "", "report.pdf"],
    ["/Volumes", "", "/Volumes"],
  ])("keeps the final segment of %j whole", (path, head, tail) => {
    expect(splitPath(path)).toEqual({ head, tail });
  });
});

describe("PathText", () => {
  it("draws the head and the final segment apart and keeps the whole path as its text", () => {
    const { container } = render(<PathText path="/Users/me/report.pdf" />);
    expect(container.querySelector(".path-line__head")?.textContent).toBe("/Users/me");
    expect(container.querySelector(".path-line__tail")?.textContent).toBe("/report.pdf");
    expect(container.textContent).toBe("/Users/me/report.pdf");
  });
});
