import { describe, expect, it } from "vitest";
import { DEFAULT_EXCLUSIONS } from "zipkitsdk/types";
import { BUILT_IN_EXCLUSIONS, descriptionKey, noteShown, noteStored } from "../../../src/gui/shared/exclusions";
import { createTranslator } from "../../../src/gui/shared/i18n/translate";
import { loadCatalogue } from "../../../src/gui/shared/i18n/catalogues";

await loadCatalogue("ja");

describe("built-in exclusion descriptions", () => {
  const ja = createTranslator("ja");
  const t = (key: Parameters<typeof ja.t>[0]) => ja.t(key);
  const dsStore = BUILT_IN_EXCLUSIONS[0]!;

  it("are keyed on the SDK's pattern ids, never its English notes, and shown in the interface language", () => {
    expect(dsStore).toEqual({ id: "macos.ds-store", pattern: ".DS_Store", match: "glob", target: "both", ignoreCase: true });
    expect(noteShown(dsStore, t)).toBe("Finder のフォルダ表示設定。Finder が作り直します。");
    expect(noteShown({ pattern: "x" } as never, t)).toBe("");
  });

  it("follow the language while untouched, and keep what the user typed as typed", () => {
    expect(noteStored(noteShown(dsStore, t), dsStore, t)).toBeUndefined();
    expect(noteStored("自分のメモ", dsStore, t)).toBe("自分のメモ");
    expect(noteShown({ ...dsStore, note: "自分のメモ" }, t)).toBe("自分のメモ");
    // A cleared description stays cleared rather than coming back.
    expect(noteStored("", dsStore, t)).toBe("");
    expect(noteShown({ ...dsStore, note: "" }, t)).toBe("");
  });

  it("cover every built-in pattern", () => {
    for (const p of DEFAULT_EXCLUSIONS) expect(descriptionKey(p.id), p.pattern).toBeDefined();
  });
});
