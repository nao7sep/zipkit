// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryField } from "../../../../src/gui/renderer/src/components/DirectoryField";

afterEach(cleanup);

describe("DirectoryField picker failure", () => {
  it("retains the path, authors the result, and logs hostile diagnostics", async () => {
    const reportError = vi.fn();
    Object.defineProperty(window, "zipkit", { configurable: true, value: {
      chooseOutputDir: vi.fn(async () => { throw new Error("EACCES /private/tmp/ZIPKIT_PICKER_SENTINEL"); }),
      reportError,
    } });
    const onChange = vi.fn();
    render(<DirectoryField label="Output" value="/kept/path" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("current path is unchanged");
    expect(alert.textContent).not.toContain("ZIPKIT_PICKER_SENTINEL");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/kept/path");
    expect(onChange).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("choose output directory", expect.objectContaining({ message: expect.stringContaining("ZIPKIT_PICKER_SENTINEL") }));
  });
});
