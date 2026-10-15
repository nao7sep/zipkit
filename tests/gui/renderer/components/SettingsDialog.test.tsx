// @vitest-environment jsdom
/**
 * Behavior tests for the Settings dialog's reset control. These pin the
 * config-sets contract this control has to hold: the button names its target
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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { languageNameIn, SettingsDialog } from "../../../../src/gui/renderer/src/components/SettingsDialog";
import { loadCatalogue } from "../../../../src/gui/shared/i18n/catalogues";
import { createTranslator } from "../../../../src/gui/shared/i18n/translate";
import { DEFAULT_OPTIONS, type GuiSettings } from "../../../../src/gui/shared/spec";
import type { SystemChoices } from "../../../../src/gui/shared/api";

afterEach(cleanup);

Object.defineProperty(window, "zipkit", {
  configurable: true,
  value: { reportError: vi.fn(), discardSettingsSubmission: vi.fn(async () => {}) },
});

/** Settings that differ from the built-ins on every axis: edited option defaults,
 *  a chosen UI font, a chosen theme, and a chosen language — so a reset's reach
 *  is visible on each. */
const CUSTOM: GuiSettings = {
  defaults: { ...DEFAULT_OPTIONS, level: 9, junk: false, comment: "mine", fileName: "mine.zip" },
  uiFontFamily: "Iosevka, monospace",
  theme: "dark",
  language: "fr",
  timeZone: "Europe/Paris",
};

/** What each System choice resolves to on the test's imaginary computer. */
const SYSTEM: SystemChoices = { appearance: "light", language: "de", timeZone: "Asia/Tokyo" };

function renderDialog(settings: GuiSettings = CUSTOM) {
  const onSave = vi.fn();
  render(<SettingsDialog system={SYSTEM} settings={settings} onSave={onSave} onClose={vi.fn()} />);
  return onSave;
}

const fontInput = () => screen.getByLabelText(/^UI font/) as HTMLInputElement;
const levelInput = () => screen.getByLabelText("Compression level (1–9)") as HTMLInputElement;
const reset = () => screen.getByText("Reset default parameters");

describe("SettingsDialog theme", () => {
  it("offers System, Light, and Dark as one radio group, applied only by Save", () => {
    const onSave = renderDialog();
    const group = screen.getByRole("group", { name: "Theme" });
    const radios = Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual(["System (Light)", "Light", "Dark"]);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios.find((radio) => radio.checked)?.value).toBe("dark");

    fireEvent.click(radios[1]!);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, theme: "light" });
  });

  it("leaves the theme alone when the default parameters are reset", () => {
    const onSave = renderDialog();
    fireEvent.click(reset());
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: DEFAULT_OPTIONS });
  });
});

describe("SettingsDialog initial focus", () => {
  it("names Cancel as the control that takes focus on open", async () => {
    renderDialog();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    expect(screen.getByText("Cancel").hasAttribute("data-modal-autofocus")).toBe(true);
  });
});

describe("SettingsDialog UI font", () => {
  it("shows the built-in font stack as the empty field's placeholder", () => {
    const style = document.createElement("style");
    style.textContent = ':root { --font-ui-default: Avenir, sans-serif; }';
    document.head.append(style);
    try {
      renderDialog({ ...CUSTOM, uiFontFamily: "" });
      expect(fontInput().placeholder).toMatch(/^Avenir,\s*sans-serif$/);
    } finally {
      style.remove();
    }
  });
});

describe("SettingsDialog reset", () => {
  it("a reset that changes nothing leaves Save disabled and closes without asking", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog system={SYSTEM} settings={{ ...CUSTOM, defaults: DEFAULT_OPTIONS }} onSave={vi.fn()} onClose={onClose} />);
    fireEvent.click(reset());
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("edits after reset save the whole new copy", () => {
    const onSave = renderDialog();
    fireEvent.click(reset());
    fireEvent.change(levelInput(), { target: { value: "4" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: { ...DEFAULT_OPTIONS, level: 4 } });
  });

  it("saves a changed language independently", () => {
    const onSave = renderDialog();
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "ja" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, language: "ja" });
  });

  it("shows human labels while preserving the option values saved to settings", () => {
    const onSave = renderDialog();
    const symlinks = screen.getByLabelText("Symlinks") as HTMLSelectElement;
    const emptyDirs = screen.getByLabelText("Empty directories") as HTMLSelectElement;

    expect((within(symlinks).getByRole("option", { name: "Ignore" }) as HTMLOptionElement).value).toBe("ignore");
    expect((within(symlinks).getByRole("option", { name: "Preserve" }) as HTMLOptionElement).value).toBe("preserve");
    expect((within(symlinks).getByRole("option", { name: "Follow" }) as HTMLOptionElement).value).toBe("follow");
    expect((within(emptyDirs).getByRole("option", { name: "Keep" }) as HTMLOptionElement).value).toBe("keep");
    expect((within(emptyDirs).getByRole("option", { name: "Prune" }) as HTMLOptionElement).value).toBe("prune");

    fireEvent.change(symlinks, { target: { value: "follow" } });
    fireEvent.change(emptyDirs, { target: { value: "prune" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({
      ...CUSTOM,
      defaults: { ...CUSTOM.defaults, symlinks: "follow", emptyDirs: "prune" },
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

    // ...and in what Save hands over.
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: DEFAULT_OPTIONS });
  });

  it("keeps a font edited in the same session (the reset never blanks the field)", () => {
    const onSave = renderDialog();
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(reset());

    expect(fontInput().value).toBe("Menlo");
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: DEFAULT_OPTIONS, uiFontFamily: "Menlo" });
  });

  it("cleans the font field on blur", () => {
    renderDialog();
    fireEvent.change(fontInput(), { target: { value: "  Menlo,\n monospace " } });
    fireEvent.blur(fontInput());
    expect(fontInput().value).toBe("Menlo, monospace");
  });

  it("a successful quit retry clears the old error while preserving newer draft edits", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("full"));
    const view = render(<SettingsDialog system={SYSTEM} settings={CUSTOM} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.change(fontInput(), { target: { value: "Georgia" } });
    view.rerender(<SettingsDialog system={SYSTEM} settings={{ ...CUSTOM, uiFontFamily: "Menlo" }} onSave={onSave} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(fontInput().value).toBe("Georgia");
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the dialog open and reports a failed durable save", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error("TypeError EACCES /private/tmp/HOSTILE-SENTINEL IPC wrapper"));
    render(<SettingsDialog system={SYSTEM} settings={CUSTOM} onSave={onSave} onClose={onClose} />);
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Settings were not saved"));
    expect(screen.getByRole("alert").textContent).not.toContain("HOSTILE-SENTINEL");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SettingsDialog while a save runs", () => {
  function deferred() {
    let settle!: { resolve: () => void; reject: (error: Error) => void };
    const promise = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    return { promise, ...settle };
  }

  it("freezes every field and close path until the save settles, then closes once", async () => {
    const save = deferred();
    const onClose = vi.fn();
    render(<SettingsDialog system={SYSTEM} settings={CUSTOM} onSave={() => save.promise} onClose={onClose} />);
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(fontInput().disabled).toBe(true));
    expect(levelInput().matches(":disabled")).toBe(true); // through the options fieldset
    expect((screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Light" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByText("Cancel") as HTMLButtonElement).disabled).toBe(true);
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard changes?")).toBeNull();

    save.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("unfreezes and stays open with the error when the save actually fails", async () => {
    const save = deferred();
    const onClose = vi.fn();
    render(<SettingsDialog system={SYSTEM} settings={CUSTOM} onSave={() => save.promise} onClose={onClose} />);
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(fontInput().disabled).toBe(true));

    save.reject(new Error("disk full"));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Settings were not saved"));
    expect(fontInput().disabled).toBe(false);
    expect(fontInput().value).toBe("Menlo");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SettingsDialog System entries", () => {
  it("name what language, theme and time zone System resolves to now, in the interface language", () => {
    renderDialog();
    // The time zone list is long; reading each select's first option directly
    // keeps the check from scanning hundreds of zones.
    expect((screen.getByLabelText("Language") as HTMLSelectElement).options[0]!.textContent).toBe("System (German)");
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).options[0]!.textContent).toBe("System (Asia/Tokyo)");
    expect(screen.getByLabelText("System (Light)")).toBeTruthy();
  });

  it("chooses a time zone from the list and saves it", () => {
    const onSave = renderDialog();
    const zone = screen.getByLabelText("Time zone") as HTMLSelectElement;
    expect(zone.value).toBe("Europe/Paris");
    expect(Array.from(zone.options).map((option) => option.value)).toContain("UTC");
    fireEvent.change(zone, { target: { value: "system" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, timeZone: "system" });
  });
});

describe("System entries in another interface language", () => {
  it("speak it in both the word and the value", async () => {
    await loadCatalogue("ja");
    const ja = createTranslator("ja");
    expect(ja.t("settings.system", { value: languageNameIn("de", "ja") })).toBe("システム（ドイツ語）");
    expect(ja.t("settings.system", { value: ja.t("settings.themeDark") })).toBe("システム（ダーク）");
    expect(languageNameIn("pt-BR", "en")).toBe("Portuguese");
    expect(languageNameIn("zh-Hans", "en")).toBe("Chinese");
  });
});
