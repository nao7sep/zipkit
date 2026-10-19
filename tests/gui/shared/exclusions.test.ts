import { describe, expect, it } from "vitest";
import { BUILT_IN_EXCLUSIONS, noteShown, noteStored } from "../../../src/gui/shared/exclusions";
import { createTranslator } from "../../../src/gui/shared/i18n/translate";
import { loadCatalogue } from "../../../src/gui/shared/i18n/catalogues";

await loadCatalogue("ja");

describe("built-in exclusion notes", () => {
  const ja = createTranslator("ja");
  const t = (key: Parameters<typeof ja.t>[0]) => ja.t(key);
  const english = BUILT_IN_EXCLUSIONS[0]!.note!;

  it("are stored in English and shown in the interface language", () => {
    expect(english).toBe("Finder’s view settings for a folder, rebuilt when it is opened");
    expect(noteShown(english, t)).toBe("Finder のフォルダ表示設定（開くと作り直されます）");
    expect(noteShown(undefined, t)).toBe("");
  });

  it("follow the language while untouched, and keep what the user typed as typed", () => {
    expect(noteStored(noteShown(english, t), t)).toBe(english);
    expect(noteStored("自分のメモ", t)).toBe("自分のメモ");
    expect(noteShown("自分のメモ", t)).toBe("自分のメモ");
  });

  it("each have a description in the catalogues", () => {
    for (const p of BUILT_IN_EXCLUSIONS) expect(noteShown(p.note, t), p.pattern).not.toBe(p.note);
  });
});
