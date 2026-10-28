import { describe, expect, it } from "vitest";
import { describeOriginalsRemoval, trashConfirmed } from "../../../src/gui/main/trash-outcome.js";
import { loadCatalogue } from "../../../src/gui/shared/i18n/catalogues.js";
import { createTranslator } from "../../../src/gui/shared/i18n/translate.js";

await loadCatalogue("ru");

const en = createTranslator("en");

describe("trash outcome", () => {
  it("is confirmed only when no path was kept", () => {
    expect(trashConfirmed({ moved: ["/a"], failed: [] })).toBe(true);
    expect(trashConfirmed({ moved: [], failed: [], gone: ["/a"] })).toBe(true);
    expect(trashConfirmed({ moved: [], failed: [{ path: "/a", message: "x" }] })).toBe(false);
  });

  it("names moved, already gone and kept originals separately", () => {
    expect(
      en.text(describeOriginalsRemoval({
        moved: ["/a", "/b"],
        failed: [{ path: "/c", message: "denied" }],
        gone: ["/d"],
      }, "trash")),
    ).toBe(
      "2 originals were moved to recoverable Trash. 1 original was already gone. 1 original was kept.",
    );
  });

  it("omits the buckets that are empty", () => {
    expect(en.text(describeOriginalsRemoval({ moved: [], failed: [{ path: "/a", message: "x" }, { path: "/b", message: "x" }] }, "trash"))).toBe(
      "0 originals were moved to recoverable Trash. 2 originals were kept.",
    );
  });

  it("gives each bucket its own plural form in the reader's language", () => {
    expect(
      createTranslator("ru").text(describeOriginalsRemoval({ moved: ["/a"], failed: [{ path: "/b", message: "x" }, { path: "/c", message: "x" }] }, "trash")),
    ).not.toContain("{");
  });
});
