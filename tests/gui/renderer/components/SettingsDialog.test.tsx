// @vitest-environment jsdom
/**
 * Behavior tests for the Settings dialog's reset control. These pin the
 * config-sets contract this control has to hold: the button names its target
 * in the app's own vocabulary (the parameters, restored to their initial
 * values), it restores the built-in option defaults, and
 * it leaves the UI font alone. The font is the user's personal cosmetic
 * preference, not a built-in that goes stale, so a reset must not drag it along;
 * that exclusion is the regression this file guards.
 *
 * The dialog is a draft form, so the committed result is asserted through Save
 * (what `onSave` receives), not just the on-screen draft.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { languageNameIn, SettingsDialog } from "../../../../src/gui/renderer/src/components/SettingsDialog";
import { loadCatalogue } from "../../../../src/gui/shared/i18n/catalogues";
import { createTranslator } from "../../../../src/gui/shared/i18n/translate";
import { DEFAULT_PARAMETERS, type GuiSettings } from "../../../../src/gui/shared/spec";
import type { SystemChoices } from "../../../../src/gui/shared/api";
import { eventuallyRendered } from "../../../helpers/eventually.js";

afterEach(cleanup);

Object.defineProperty(window, "zipkit", {
  configurable: true,
  value: { reportError: vi.fn(), discardSettingsSubmission: vi.fn(async () => {}), reportSettingsDraft: vi.fn() },
});

/** Settings that differ from the built-ins on every axis: edited option defaults,
 *  a chosen UI font, a chosen theme, and a chosen language — so a reset's reach
 *  is visible on each. */
const CUSTOM: GuiSettings = {
  defaults: { ...DEFAULT_PARAMETERS, level: 9, exclude: false },
  uiFontFamily: "Iosevka, monospace",
  theme: "dark",
  language: "fr",
  timeZone: "Europe/Paris",
  confirmJobRemoval: false,
  cardRowLimit: 9,
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
const reset = () => screen.getByText("Reset parameters to initial values");

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
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: DEFAULT_PARAMETERS });
  });
});

describe("SettingsDialog initial focus", () => {
  it("names Cancel as the control that takes focus on open", async () => {
    renderDialog();
    await eventuallyRendered(() => expect(document.activeElement?.textContent).toBe("Cancel"));
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
    render(<SettingsDialog system={SYSTEM} settings={{ ...CUSTOM, defaults: DEFAULT_PARAMETERS }} onSave={vi.fn()} onClose={onClose} />);
    fireEvent.click(reset());
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Cancel"));
    await eventuallyRendered(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("edits after reset save the whole new copy", () => {
    const onSave = renderDialog();
    fireEvent.click(reset());
    fireEvent.change(levelInput(), { target: { value: "4" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: { ...DEFAULT_PARAMETERS, level: 4 } });
  });

  it("saves a changed language independently", () => {
    const onSave = renderDialog();
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "ja" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, language: "ja" });
  });

  it("shows human labels while preserving the option values saved to settings", () => {
    const onSave = renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "New job parameters" }));
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
    // The old labels are gone: neither a generic one nor one that says "default"
    // for values the main window also calls the Settings' parameters.
    expect(screen.queryByText("Reset options")).toBeNull();
    expect(screen.queryByText(/default parameters/i)).toBeNull();
  });

  it("restores the built-in option defaults in the draft", () => {
    renderDialog();
    expect(levelInput().value).toBe("9");
    fireEvent.click(reset());
    expect(levelInput().value).toBe(String(DEFAULT_PARAMETERS.level));
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
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: DEFAULT_PARAMETERS });
  });

  it("keeps a font edited in the same session (the reset never blanks the field)", () => {
    const onSave = renderDialog();
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(reset());

    expect(fontInput().value).toBe("Menlo");
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: DEFAULT_PARAMETERS, uiFontFamily: "Menlo" });
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
    await eventuallyRendered(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.change(fontInput(), { target: { value: "Georgia" } });
    view.rerender(<SettingsDialog system={SYSTEM} settings={{ ...CUSTOM, uiFontFamily: "Menlo" }} onSave={onSave} onClose={vi.fn()} />);
    await eventuallyRendered(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(fontInput().value).toBe("Georgia");
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the dialog open and reports a failed durable save", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error("TypeError EACCES /private/tmp/HOSTILE-SENTINEL IPC wrapper"));
    render(<SettingsDialog system={SYSTEM} settings={CUSTOM} onSave={onSave} onClose={onClose} />);
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(screen.getByText("Save"));
    await eventuallyRendered(() => expect(screen.getByRole("alert").textContent).toContain("Settings were not saved"));
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

    await eventuallyRendered(() => expect(fontInput().disabled).toBe(true));
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
    await eventuallyRendered(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("unfreezes and stays open with the error when the save actually fails", async () => {
    const save = deferred();
    const onClose = vi.fn();
    render(<SettingsDialog system={SYSTEM} settings={CUSTOM} onSave={() => save.promise} onClose={onClose} />);
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    fireEvent.click(screen.getByText("Save"));
    await eventuallyRendered(() => expect(fontInput().disabled).toBe(true));

    save.reject(new Error("disk full"));

    await eventuallyRendered(() => expect(screen.getByRole("alert").textContent).toContain("Settings were not saved"));
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

describe("SettingsDialog draft report", () => {
  it("tells main whether edits are unsaved, so quit can ask before discarding them", () => {
    const report = window.zipkit.reportSettingsDraft as ReturnType<typeof vi.fn>;
    report.mockClear();
    renderDialog();
    expect(report).toHaveBeenLastCalledWith(false);
    fireEvent.change(fontInput(), { target: { value: "Menlo" } });
    expect(report).toHaveBeenLastCalledWith(true);
    cleanup();
    expect(report).toHaveBeenLastCalledWith(false);
  });
});

describe("SettingsDialog tabs", () => {
  it("names the parameters under their own tab, with the reset that covers them beside it", () => {
    renderDialog();
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "New job parameters" }));
    const section = screen.getByRole("tabpanel", { name: "New job parameters" });
    expect(within(section).getByRole("button", { name: "Reset parameters to initial values" })).toBeTruthy();
    expect(within(section).getByLabelText("Compression level (1–9)")).toBeTruthy();
    // Language, theme and font sit above it, outside what the reset covers.
    expect(within(section).queryByLabelText(/^UI font/)).toBeNull();
    expect(within(section).queryByRole("group", { name: "Theme" })).toBeNull();
  });
});

describe("SettingsDialog manifest name", () => {
  it.each(["", "a/../b", "a/b", "CON"])("marks an unsafe manifest name on its field and holds Save: %j", (name) => {
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "New job parameters" }));
    const field = screen.getByLabelText("Manifest name (when enabled)") as HTMLInputElement;
    expect(field.value).toBe("zipkit.json");
    fireEvent.change(field, { target: { value: name } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe("Enter one safe filename, without folders or reserved characters.");
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("allows correcting an invalid manifest name while the manifest is disabled", () => {
    const onSave = renderDialog({ ...CUSTOM, defaults: { ...CUSTOM.defaults, manifest: false, manifestName: "a/b" } });
    fireEvent.click(screen.getByRole("tab", { name: "New job parameters" }));
    const field = screen.getByLabelText("Manifest name (when enabled)") as HTMLInputElement;
    expect(field.disabled).toBe(false);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "record.json" } });
    expect(field.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: { ...CUSTOM.defaults, manifest: false, manifestName: "record.json" } });
  });
});

describe("SettingsDialog exclusion patterns", () => {
  it("holds Save for a folder glob targeting files and names the correction on its field", () => {
    const exclusions = [{ pattern: "initial", match: "glob" as const, target: "file" as const, ignoreCase: false }];
    const onSave = renderDialog({ ...CUSTOM, defaults: { ...CUSTOM.defaults, exclusions } });
    fireEvent.click(screen.getByRole("tab", { name: "Exclusion patterns" }));
    const field = screen.getByLabelText("Pattern 1");
    fireEvent.change(field, { target: { value: " cache/ " } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe("A glob ending in / matches folders. Choose Folders or Files and folders.");
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("What pattern 1 applies to"), { target: { value: "dir" } });
    expect(field.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(screen.getByText("Save"));
    expect(onSave.mock.calls[0]![0].defaults.exclusions).toEqual([{ pattern: "cache/", match: "glob", target: "dir", ignoreCase: false }]);
  });

  it("edits the whole list, drops a blank row, and holds Save for a regex that does not compile", () => {
    const onSave = renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Exclusion patterns" }));
    const panel = screen.getByRole("tabpanel", { name: "Exclusion patterns" });
    const first = within(panel).getByLabelText("Pattern 1") as HTMLInputElement;
    expect(first.value).toBe(".DS_Store");
    // Removing every pattern but the first, then adding a broken regex.
    const count = within(panel).getAllByLabelText(/^Pattern \d+$/).length;
    for (let i = count; i > 1; i--) fireEvent.click(within(panel).getByRole("button", { name: `Remove pattern ${i}` }));
    fireEvent.click(within(panel).getByRole("button", { name: "Add pattern" }));
    // A blank row is no pattern: it is no error, and it is not saved.
    expect(within(panel).queryByText("Not a valid regular expression.")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Add pattern" }));
    fireEvent.change(within(panel).getByLabelText("Pattern 3"), { target: { value: "(" } });
    fireEvent.change(within(panel).getByLabelText("Kind of pattern 3"), { target: { value: "regex" } });
    const field = within(panel).getByLabelText("Pattern 3");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe("Not a valid regular expression.");
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText("Pattern 3"), { target: { value: " \\.log$ " } });
    fireEvent.click(within(panel).getByRole("button", { name: "Move pattern 3 up" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Move pattern 2 up" }));
    fireEvent.click(screen.getByText("Save"));
    expect(onSave.mock.calls[0]![0].defaults.exclusions).toEqual([
      { pattern: "\\.log$", match: "regex", target: "both", ignoreCase: false },
      expect.objectContaining({ pattern: ".DS_Store", match: "glob", target: "both", ignoreCase: true }),
    ]);
  });

  it("shows a built-in note as real text in the interface language, kept through other edits, and saves a note typed over it", () => {
    const onSave = renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Exclusion patterns" }));
    const panel = screen.getByRole("tabpanel", { name: "Exclusion patterns" });
    const note = within(panel).getByLabelText("Note on pattern 1") as HTMLTextAreaElement;
    expect(note.value).toBe("Finder’s view settings for a folder. Finder creates it again.");
    // Changing how the pattern matches keeps its description.
    fireEvent.click(within(panel).getAllByLabelText("Any case")[0]!);
    expect(note.value).toBe("Finder’s view settings for a folder. Finder creates it again.");
    fireEvent.change(within(panel).getByLabelText("Note on pattern 2"), { target: { value: "  Mine  " } });
    fireEvent.click(screen.getByText("Save"));
    const saved = onSave.mock.calls[0]![0].defaults.exclusions;
    // The description is the catalogue's for the pattern's id, so it is saved as no note at all.
    expect(saved[0]).toEqual({ id: "macos.ds-store", pattern: ".DS_Store", match: "glob", target: "both", ignoreCase: false });
    expect(saved[1].note).toBe("Mine");
  });

  it("resets the patterns alone to the list ZipKit ships with", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Exclusion patterns" }));
    const panel = screen.getByRole("tabpanel", { name: "Exclusion patterns" });
    fireEvent.click(within(panel).getByRole("button", { name: "Remove pattern 1" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Reset patterns to initial values" }));
    expect((within(panel).getByLabelText("Pattern 1") as HTMLInputElement).value).toBe(".DS_Store");
  });
});

describe("SettingsDialog number fields", () => {
  const rowLimitInput = () => screen.getByLabelText("Items a Status card lists before folding") as HTMLInputElement;
  const save = () => screen.getByText("Save") as HTMLButtonElement;

  it("keeps a typed level that is not one, says what it takes and holds Save", () => {
    const onSave = renderDialog();
    for (const typed of ["", "0", "10", "3.5", "x"]) {
      fireEvent.change(levelInput(), { target: { value: typed } });
      expect(levelInput().value).toBe(typed);
      expect(levelInput().getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByText("Whole number from 1 to 9")).toBeTruthy();
      expect(save().disabled).toBe(true);
    }
    fireEvent.change(levelInput(), { target: { value: "2" } });
    expect(screen.queryByText("Whole number from 1 to 9")).toBeNull();
    fireEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, defaults: { ...CUSTOM.defaults, level: 2 } });
  });

  it("keeps a typed row limit that is not one, says what it takes and holds Save", () => {
    const onSave = renderDialog();
    for (const typed of ["", "-1", "101", "2.5"]) {
      fireEvent.change(rowLimitInput(), { target: { value: typed } });
      expect(rowLimitInput().value).toBe(typed);
      expect(screen.getByText("Whole number from 0 to 100")).toBeTruthy();
      expect(save().disabled).toBe(true);
    }
    fireEvent.change(rowLimitInput(), { target: { value: "0" } });
    fireEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ ...CUSTOM, cardRowLimit: 0 });
  });

  it("counts a typed number that is not valid as an unsaved edit", async () => {
    renderDialog();
    fireEvent.change(rowLimitInput(), { target: { value: "" } });
    await eventuallyRendered(() => expect(window.zipkit.reportSettingsDraft).toHaveBeenLastCalledWith(true));
  });

  it("puts a reset level back as text", () => {
    renderDialog();
    fireEvent.change(levelInput(), { target: { value: "" } });
    fireEvent.click(reset());
    expect(levelInput().value).toBe(String(DEFAULT_PARAMETERS.level));
    expect(screen.queryByText("Whole number from 1 to 9")).toBeNull();
  });
});
