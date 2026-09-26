import { describe, expect, it } from "vitest";
import type { MessageKey } from "../../src/gui/shared/i18n/catalogues";
import { createTranslator, message, sentences } from "../../src/gui/shared/i18n/translate";

describe("createTranslator", () => {
  it("fills placeholders and formats numbers for the locale", () => {
    expect(createTranslator("en").t("about.version", { version: "1.2.0" })).toBe("Version 1.2.0");
    expect(createTranslator("en", "en-US").t("job.saved", { count: 12345 })).toBe("Saved (12,345 bytes).");
    expect(createTranslator("de").t("job.saved", { count: 12345 })).toContain("12.345");
  });

  it("chooses the plural form by the language's own rules", () => {
    const ru = createTranslator("ru");
    const one = ru.t("jobs.files", { count: 1 });
    const few = ru.t("jobs.files", { count: 3 });
    const many = ru.t("jobs.files", { count: 5 });
    expect(new Set([one, few.replace("3", "1"), many.replace("5", "1")]).size).toBe(3);
    expect(ru.t("jobs.files", { count: 21 })).toBe(one.replace("1", "21"));
    expect(createTranslator("en").t("jobs.files", { count: 1 })).toBe("1 file");
    expect(createTranslator("en").t("jobs.files", { count: 0 })).toBe("0 files");
  });

  it("renders a message descriptor, with a message as a value in the same language", () => {
    const t = createTranslator("en");
    const detail = message("trash.kept", { count: 2 });
    expect(t.text(message("job.savedVerifiedPartial", { detail }))).toBe(
      "The archive was saved and verified. 2 originals were kept.",
    );
  });

  it("runs several messages together as consecutive sentences through one entry", () => {
    const t = createTranslator("en");
    const joined = sentences([
      message("trash.moved", { count: 1 }),
      message("trash.kept", { count: 1 }),
      message("trash.unconfirmed", { count: 2 }),
    ]);
    expect(t.text(joined!)).toBe(
      "1 original was moved to recoverable Trash. 1 original was kept. 2 originals were still being moved and may yet reach recoverable Trash.",
    );
    expect(sentences([])).toBeNull();
  });

  it("lists items the way the language lists them", () => {
    expect(createTranslator("en").list(["a", "b", "c"])).toBe("a, b, c");
  });

  it("splits an entry around its placeholders for markup", () => {
    expect(createTranslator("en").parts("options.embedManifest")).toEqual(["Embed manifest (", "file", ")"]);
  });

  it("shows a key the catalogue lacks instead of failing the render", () => {
    // Types keep this out of the app; a stale build or a half-merged catalogue
    // could still reach it, and a window must not go down over one string.
    const missing = "gone.missing" as unknown as MessageKey;
    expect(createTranslator("ja").t(missing)).toBe("gone.missing");
  });
});
