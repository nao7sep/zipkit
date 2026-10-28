// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryField } from "../../../../src/gui/renderer/src/components/DirectoryField";
import { eventuallyRendered } from "../../../helpers/eventually.js";

afterEach(cleanup);

describe("DirectoryField picker failure", () => {
  it("passes current text and source context on every Choose without filling a cancelled blank", async () => {
    const chooseOutputDir = vi.fn(async () => "");
    Object.defineProperty(window, "zipkit", { configurable: true, value: { chooseOutputDir, reportError: vi.fn() } });
    const onChange = vi.fn();
    const inputs = ["/source/a.txt"];
    const view = render(<DirectoryField label="Output" value="" inputs={inputs} fileName="bundle" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await eventuallyRendered(() => expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false));
    expect(chooseOutputDir).toHaveBeenLastCalledWith("", inputs, "bundle");
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    view.rerender(<DirectoryField label="Output" value="~/typed" inputs={inputs} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await eventuallyRendered(() => expect(chooseOutputDir).toHaveBeenLastCalledWith("~/typed", inputs, undefined));
  });
  it("sends typing immediately and uses the latest parent owner when a picker settles late", async () => {
    let finish!: (value: string) => void;
    Object.defineProperty(window, "zipkit", { configurable: true, value: {
      chooseOutputDir: () => new Promise<string>((resolve) => { finish = resolve; }), reportError: vi.fn(),
    } });
    const first = vi.fn(), latest = vi.fn();
    const view = render(<DirectoryField label="Output" value="/first" onChange={first} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/typed" } });
    expect(first).toHaveBeenCalledExactlyOnceWith("/typed");
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    view.rerender(<DirectoryField label="Output" value="/typed" onChange={latest} />);
    finish("/chosen");
    await eventuallyRendered(() => expect(latest).toHaveBeenCalledExactlyOnceWith("/chosen"));
    expect(first).toHaveBeenCalledOnce();
  });
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
    await eventuallyRendered(() => expect((choose as HTMLButtonElement).disabled).toBe(false));
  });
});
