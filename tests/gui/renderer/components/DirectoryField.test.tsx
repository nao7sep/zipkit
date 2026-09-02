// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("allows only one native picker request at a time", async () => {
    let finish!: (value: string) => void;
    const chooseOutputDir = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    Object.defineProperty(window, "zipkit", { configurable: true, value: {
      chooseOutputDir,
      reportError: vi.fn(),
    } });
    render(<DirectoryField label="Output" value="/kept/path" onChange={vi.fn()} />);

    const choose = screen.getByRole("button", { name: "Choose" });
    fireEvent.click(choose);
    fireEvent.click(choose);

    expect(chooseOutputDir).toHaveBeenCalledOnce();
    expect((choose as HTMLButtonElement).disabled).toBe(true);
    finish("");
    await waitFor(() => expect((choose as HTMLButtonElement).disabled).toBe(false));
  });
});
