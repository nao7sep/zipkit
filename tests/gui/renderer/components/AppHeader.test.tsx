// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppHeader } from "../../../../src/gui/renderer/src/components/AppHeader";
import { eventuallyRendered } from "../../../helpers/eventually.js";

afterEach(cleanup);

function mountHeader() {
  const callbacks = {
    onOpenSettings: vi.fn(),
    onOpenRecords: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onOpenAbout: vi.fn(),
  };
  render(<AppHeader {...callbacks} />);
  return { trigger: screen.getByRole("button", { name: "Menu" }), ...callbacks };
}

async function focused(name: string) {
  const item = await screen.findByRole("menuitem", { name });
  await eventuallyRendered(() => expect(document.activeElement).toBe(item));
  return item;
}

describe("AppHeader menu targets", () => {
  it("initializes pointer opening and keeps arrows and Enter independent of hover", async () => {
    const header = mountHeader();
    fireEvent.pointerDown(header.trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const settings = await focused("Settings");
    fireEvent.keyDown(settings, { key: "ArrowDown" });
    fireEvent.keyDown(await focused("Records"), { key: "ArrowDown" });
    const shortcuts = await focused("Shortcut keys");
    fireEvent.pointerMove(settings, { pointerType: "mouse" });
    fireEvent.pointerLeave(settings, { pointerType: "mouse" });
    expect(document.activeElement).toBe(shortcuts);
    fireEvent.keyDown(shortcuts, { key: "ArrowDown" });
    fireEvent.keyDown(await focused("About ZipKit"), { key: "Enter" });
    expect(header.onOpenAbout).toHaveBeenCalledTimes(1);
    expect(header.onOpenSettings).not.toHaveBeenCalled();
    expect(header.onOpenShortcuts).not.toHaveBeenCalled();
    await eventuallyRendered(() => expect(screen.queryByRole("menu")).toBeNull());
    await eventuallyRendered(() => expect(document.activeElement).toBe(header.trigger));
  });

  it.each(["Enter", " ", "ArrowDown"])("opens with %s at the first command, then moves on the first arrow", async (key) => {
    const { trigger } = mountHeader();
    trigger.focus();
    fireEvent.keyDown(trigger, { key });
    fireEvent.keyDown(await focused("Settings"), { key: "ArrowDown" });
    await focused("Records");
  });

  it("opens with ArrowUp at the last command and moves back immediately", async () => {
    const { trigger } = mountHeader();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.keyDown(await focused("About ZipKit"), { key: "ArrowUp" });
    await focused("Shortcut keys");
  });

  it("activates the clicked command when a different command has keyboard focus", async () => {
    const header = mountHeader();
    fireEvent.keyDown(header.trigger, { key: "Enter" });
    fireEvent.keyDown(await focused("Settings"), { key: "End" });
    await focused("About ZipKit");
    fireEvent.click(screen.getByRole("menuitem", { name: "Records" }));
    expect(header.onOpenRecords).toHaveBeenCalledTimes(1);
    expect(header.onOpenAbout).not.toHaveBeenCalled();
    await eventuallyRendered(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it.each(["Escape", "Tab"])("closes with %s and returns focus to the trigger", async (key) => {
    const { trigger } = mountHeader();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(await focused("Settings"), { key });
    await eventuallyRendered(() => expect(screen.queryByRole("menu")).toBeNull());
    await eventuallyRendered(() => expect(document.activeElement).toBe(trigger));
  });

  it("leaves IME keys to composition rather than opening, moving, activating or closing", async () => {
    const header = mountHeader();
    fireEvent.keyDown(header.trigger, { key: "Enter", isComposing: true });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(header.trigger, { key: "Enter" });
    const settings = await focused("Settings");
    for (const key of ["ArrowDown", "Enter", "Escape", "Tab"]) {
      fireEvent.keyDown(settings, { key, isComposing: true });
    }
    expect(document.activeElement).toBe(settings);
    expect(header.onOpenSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
