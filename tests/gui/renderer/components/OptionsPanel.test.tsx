// @vitest-environment jsdom
/**
 * A parameter row wraps instead of overlapping: its label may wrap, the row
 * lets the control drop below the label, and a select can shrink below its
 * longest option. The layout itself is judged by hand at the narrowest pane.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OptionsPanel } from "../../../../src/gui/renderer/src/components/OptionsPanel";
import { DEFAULT_OPTIONS } from "../../../../src/gui/shared/spec";

afterEach(cleanup);

Object.defineProperty(window, "zipkit", {
  configurable: true,
  value: { reportError: vi.fn(), chooseOutputDir: vi.fn() },
});

describe("OptionsPanel field rows", () => {
  it("lets a label wrap and its select shrink, in a row that wraps", () => {
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={vi.fn()} disabled={false} />);
    const select = screen.getByRole("combobox", { name: "Symlinks" });
    const row = select.closest("label")!;
    const label = row.firstElementChild as HTMLElement;
    expect(row.style.flexWrap).toBe("wrap");
    expect(label.style.whiteSpace).not.toBe("nowrap");
    expect(select.style.minWidth).toBe("0px");
    expect(select.style.maxWidth).toBe("100%");
  });
});
