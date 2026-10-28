import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LANGUAGES } from "../../src/gui/shared/i18n/languages";

const config = parse(
  readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8"),
) as {
  mac?: { extendInfo?: Record<string, unknown> };
  nsis?: Record<string, unknown>;
};

describe("interface languages in the packaged app", () => {
  it("declares exactly the interface languages as the bundle's localizations", () => {
    expect(config.mac?.extendInfo?.CFBundleLocalizations).toEqual([...LANGUAGES]);
  });

  it("builds a multi-language installer in the same languages, English first as the fallback", () => {
    const installer = config.nsis?.installerLanguages as string[];
    expect(config.nsis?.multiLanguageInstaller).toBe(true);
    expect(installer[0]).toBe("en_US");
    // electron-builder names each language with its region; the set must be the
    // interface's, one installer language per interface language.
    const asInterface = installer.map((tag) => {
      const [language, region] = tag.split("_");
      if (language === "zh") return "zh-Hans";
      if (language === "pt") return `pt-${region}`;
      return language;
    });
    expect(asInterface).toEqual([...LANGUAGES]);
  });
});
