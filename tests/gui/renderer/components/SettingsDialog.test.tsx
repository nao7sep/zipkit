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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsDialog } from "../../../../src/gui/renderer/src/components/SettingsDialog";
import { DEFAULT_OPTIONS, type GuiSettings } from "../../../../src/gui/shared/spec";

afterEach(cleanup);

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

describe("SettingsDialog reset", () => {
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
});
