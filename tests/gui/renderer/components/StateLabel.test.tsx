// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StateLabel } from "../../../../src/gui/renderer/src/components/StateLabel";
import { stateColor } from "../../../../src/gui/renderer/src/view";

afterEach(cleanup);

describe("StateLabel", () => {
  it("is plain text in the state's colour, with no pill around it", () => {
    render(<StateLabel state="ready" />);
    const label = screen.getByText("Ready");
    expect(label.style.color).toBe(stateColor("ready"));
    expect(label.style.background).toBe("");
    expect(label.style.border).toBe("");
    expect(label.style.borderRadius).toBe("");
    expect(label.style.padding).toBe("");
  });
});
