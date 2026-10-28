import { describe, expect, it } from "vitest";
import { loadCatalogue, loadedCatalogue, type MessageKey } from "../../src/gui/shared/i18n/catalogues";
import { createTranslator, message, sentences } from "../../src/gui/shared/i18n/translate";

await Promise.all((["de", "ru", "ja"] as const).map(loadCatalogue));

describe("createTranslator", () => {
  it("formats times in the display zone it is given, and in the computer's without one", () => {
    const instant = new Date(Date.UTC(2026, 0, 1, 15, 30, 0));
    expect(createTranslator("en", "en-US", "Asia/Tokyo").logTime(instant)).toContain("12:30:00");
    expect(createTranslator("en", "en-US", "UTC").logTime(instant)).toContain("3:30:00");
    expect(createTranslator("en", "en-US", "Asia/Tokyo").dateTime(instant)).toContain("Jan 2, 2026");
    expect(createTranslator("en", "en-US").timeZone).toBeUndefined();
  });

  it("fills placeholders and formats numbers for the locale", () => {
    expect(createTranslator("en").t("about.version", { version: "1.2.0" })).toBe("Version 1.2.0");
    expect(createTranslator("en", "en-US").t("jobs.countFiles", { count: 12345 })).toBe("12,345 files");
    expect(createTranslator("de").t("jobs.countFiles", { count: 12345 })).toContain("12.345");
  });

  it("writes a size in bytes in the largest unit it reaches, counting in thousands as the Finder does", () => {
    const en = createTranslator("en", "en-US");
    expect(en.t("job.saved", { size: { bytes: 208_540_997 } })).toBe("Saved (208.5 MB).");
    expect(en.size(999)).toBe("999 bytes");
    expect(en.size(1)).toBe("1 byte");
    expect(en.size(1500)).toBe("1.5 kB");
    expect(en.size(999_960)).toBe("1 MB");
    expect(en.size(3_000_000_000)).toBe("3 GB");
    expect(createTranslator("ja").t("job.savedVerified", { size: { bytes: 208_540_997 } })).toBe("保存して検証しました（208.5 MB）。");
    expect(createTranslator("de").size(208_540_997)).toBe("208,5 MB");
  });

  it("chooses the plural form by the language's own rules", () => {
    const ru = createTranslator("ru");
    const one = ru.t("job.blocking", { count: 1 });
    const few = ru.t("job.blocking", { count: 3 });
    const many = ru.t("job.blocking", { count: 5 });
    expect(new Set([one, few.replace("3", "1"), many.replace("5", "1")]).size).toBe(3);
    expect(ru.t("job.blocking", { count: 21 })).toBe(one.replace("1", "21"));
    expect(createTranslator("en").t("job.blocking", { count: 1 })).toBe("1 blocking finding");
    expect(createTranslator("en").t("job.blocking", { count: 0 })).toBe("0 blocking findings");
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
      message("originals.alreadyGone", { count: 2 }),
    ]);
    expect(t.text(joined!)).toBe(
      "1 original was moved to recoverable Trash. 1 original was kept. 2 originals were already gone.",
    );
    expect(sentences([])).toBeNull();
  });

  it("lists items the way the language lists them", () => {
    expect(createTranslator("en").list(["a", "b", "c"])).toBe("a, b, c");
  });

  it("splits an entry around its placeholders for markup", () => {
    expect(createTranslator("en").parts("options.embedManifest")).toEqual(["Embed manifest (", "file", ")"]);
  });

  it("reads a key the language's catalogue lacks in English", () => {
    const ja = loadedCatalogue("ja") as Record<string, unknown>;
    const held = ja["common.save"];
    delete ja["common.save"];
    try {
      expect(createTranslator("ja").t("common.save")).toBe(createTranslator("en").t("common.save"));
    } finally {
      ja["common.save"] = held;
    }
  });

  it("shows a key no catalogue carries instead of failing the render", () => {
    // Types keep this out of the app; a stale build or a half-merged catalogue
    // could still reach it, and a window must not go down over one string.
    const missing = "gone.missing" as unknown as MessageKey;
    expect(createTranslator("ja").t(missing)).toBe("gone.missing");
  });
});
