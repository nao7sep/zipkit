// @vitest-environment jsdom
/**
 * Behavior tests for the Settings dialog's reset control. These pin the
 * config-seeding contract this control has to hold: the button names its target
 * in the app's own vocabulary ("default parameters" — the same phrase the main
 * window's per-job toggle uses), it restores the built-in option defaults, and
 * it leaves the UI font alone. The font is the user's personal cosmetic
 * preference, not a built-in that goes stale, so a reset must not drag it along;
 * that exclusion is the regression this file guards.
 *
 * The dialog is a draft form, so the committed result is asserted through Save
 * (what `onSave` receives), not just the on-screen draft.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsDialog } from "../../../../src/gui/renderer/src/components/SettingsDialog";
import { DEFAULT_OPTIONS, type GuiSettings } from "../../../../src/gui/shared/spec";

afterEach(cleanup);

Object.defineProperty(window, "zipkit", {
  configurable: true,
  value: { reportError: vi.fn() },
});

/** Settings that differ from the built-ins on both axes: edited option defaults
 *  AND a chosen UI font — so a reset's reach is visible on each. */
const CUSTOM: GuiSettings = {
  defaults: { ...DEFAULT_OPTIONS, level: 9, junk: false, comment: "mine" },
  uiFontFamily: "Iosevka, monospace",
};

function renderDialog(settings: GuiSettings = CUSTOM) {
  const onSave = vi.fn();
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  return onSave;
}

const fontInput = () => screen.getByPlaceholderText("Default") as HTMLInputElement;
const levelInput = () => screen.getByLabelText("Compression level (1–9)") as HTMLInputElement;
const reset = () => screen.getByText("Reset default parameters");

// ModalShell gives the footer's FIRST DOM control the safe-default focus, so a
// stray Enter on open must land on Cancel. The footer is deliberately written in
// a different order than it renders: the reset is pulled to the visual far left
// with `order: -1`, but stays SECOND in the DOM. Until now the only thing
// recording that was a comment above the JSX, and a comment does not fail a
// build — reordering the JSX to match what the eye sees (the natural tidy-up,
// since a reader will ask why Cancel is written first when it renders second)
// would silently move the open-then-Enter target onto "Reset default
// parameters". This asserts the DOM order that safety rides on.
describe("SettingsDialog footer order", () => {
  it("puts Cancel first in the DOM so footer-first focus is the safe default", () => {
    renderDialog();
    const footer = document.querySelector("[data-modal-footer]");
    expect(footer).toBeTruthy();
    const labels = Array.from(footer!.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Cancel", "Reset default parameters", "Save"]);
  });
});

describe("SettingsDialog reset", () => {
  it("shows human labels while preserving the option values saved to settings", () => {
    const onSave = renderDialog();
    const symlinks = screen.getByLabelText("Symlinks") as HTMLSelectElement;
    const emptyDirs = screen.getByLabelText("Empty directories") as HTMLSelectElement;

    expect((screen.getByRole("option", { name: "Ignore" }) as HTMLOptionElement).value).toBe("ignore");
    expect((screen.getByRole("option", { name: "Preserve" }) as HTMLOptionElement).value).toBe("preserve");
    expect((screen.getByRole("option", { name: "Follow" }) as HTMLOptionElement).value).toBe("follow");
    expect((screen.getByRole("option", { name: "Keep" }) as HTMLOptionElement).value).toBe("keep");
    expect((screen.getByRole("option", { name: "Prune" }) as HTMLOptionElement).value).toBe("prune");

    fireEvent.change(symlinks, { target: { value: "follow" } });
    fireEvent.change(emptyDirs, { target: { value: "prune" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({
      defaults: { ...CUSTOM.defaults, symlinks: "follow", emptyDirs: "prune" },
      uiFontFamily: CUSTOM.uiFontFamily,
    });
  });

  it("labels the control for exactly what it resets", () => {
    renderDialog();
    expect(reset()).toBeTruthy();
    // The old generic label is gone (the app calls these knobs "default parameters").
    expect(screen.queryByText("Reset options")).toBeNull();
  });

  it("restores the built-in option defaults in the draft", () => {
    renderDialog();
    expect(levelInput().value).toBe("9");
    fireEvent.click(reset());
    expect(levelInput().value).toBe(String(DEFAULT_OPTIONS.level));
  });

  it("leaves a custom UI font intact while restoring the defaults", () => {
    const onSave = renderDialog();
    expect(fontInput().value).toBe("Iosevka, monospace");

    fireEvent.click(reset());

    // The font survives the reset in the draft...
    expect(fontInput().value).toBe("Iosevka, monospace");

    // ...and in what Save actually commits: defaults back to the built-ins,
    // font untouched.
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      defaults: DEFAULT_OPTIONS,
      uiFontFamily: "Iosevka, monospace",
    });
  });

  it("keeps a font edited in the same session (the reset never blanks the field)", () => {
    const onSave = renderDialog();
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(reset());

    expect(fontInput().value).toBe("Menlo");
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ defaults: DEFAULT_OPTIONS, uiFontFamily: "Menlo" });
  });

  it("keeps the dialog open and reports a failed durable save", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error("TypeError EACCES /private/tmp/HOSTILE-SENTINEL IPC wrapper"));
    render(<SettingsDialog settings={CUSTOM} onSave={onSave} onClose={onClose} />);
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Settings were not saved"));
    expect(screen.getByRole("alert").textContent).not.toContain("HOSTILE-SENTINEL");
    expect(onClose).not.toHaveBeenCalled();
  });
});
