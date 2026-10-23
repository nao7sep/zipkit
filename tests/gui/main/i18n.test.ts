import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  defaults: new Map<string, unknown>(),
  calls: [] as string[],
  preferred: ["ja-JP", "en-US"],
  isPackaged: true,
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
}));

vi.mock("electron", () => ({
  app: {
    getPreferredSystemLanguages: () => {
      electron.calls.push("read");
      return (electron.defaults.get("AppleLanguages") as string[] | undefined) ?? electron.preferred;
    },
    getSystemLocale: () => "ja-JP",
    get isPackaged() {
      return electron.isPackaged;
    },
  },
  systemPreferences: {
    setUserDefault: (key: string, _type: string, value: unknown) => {
      electron.calls.push(`set ${JSON.stringify(value)}`);
      electron.defaults.set(key, value);
    },
    removeUserDefault: (key: string) => {
      electron.calls.push("remove");
      electron.defaults.delete(key);
    },
  },
  BrowserWindow: { getAllWindows: () => electron.windows },
}));

describe("AppKit language alignment", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    electron.defaults.clear();
    electron.calls.splice(0);
    electron.preferred = ["ja-JP", "en-US"];
    electron.isPackaged = true;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  async function load() {
    vi.resetModules();
    return import("../../../src/gui/main/i18n.js");
  }

  it("clears its own entry before reading the computer, then writes the saved choice", async () => {
    const i18n = await load();
    await i18n.settleLanguage("fr", vi.fn());
    expect(electron.calls).toContain("remove");
    expect(electron.calls.indexOf("remove")).toBeLessThan(electron.calls.indexOf("read"));
    expect(electron.defaults.get("AppleLanguages")).toEqual(["fr"]);
  });

  it("removes the entry when System is chosen", async () => {
    electron.defaults.set("AppleLanguages", ["fr"]);
    const i18n = await load();
    await i18n.settleLanguage("system", vi.fn());
    expect(electron.defaults.has("AppleLanguages")).toBe(false);
  });

  it("touches no defaults off macOS", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const i18n = await load();
    await i18n.settleLanguage("fr", vi.fn());
    expect(electron.calls.filter((call) => call !== "read")).toEqual([]);
  });

  it("touches no defaults on an unpackaged macOS run", async () => {
    electron.isPackaged = false;
    const i18n = await load();
    await i18n.settleLanguage("fr", vi.fn());
    expect(electron.calls.filter((call) => call !== "read")).toEqual([]);
  });
});

describe("applyLanguagePreference", () => {
  it("keeps the last of overlapping saved choices, whichever catalogue loads first", async () => {
    vi.resetModules();
    const i18n = await import("../../../src/gui/main/i18n.js");
    const { loadCatalogue } = await import("../../../src/gui/shared/i18n/catalogues.js");
    await i18n.settleLanguage("en", vi.fn());
    await loadCatalogue("de");

    const first = i18n.applyLanguagePreference("fr", vi.fn());
    const second = i18n.applyLanguagePreference("de", vi.fn());
    await Promise.all([first, second]);

    expect(i18n.mainTranslator().language).toBe("de");
  });
});

describe("applyTimeZonePreference", () => {
  it("hands the windows the saved display zone with the language, and System as the computer's", async () => {
    vi.resetModules();
    const i18n = await import("../../../src/gui/main/i18n.js");
    await i18n.settleLanguage("en", vi.fn());
    const send = vi.fn();
    electron.windows.splice(0, electron.windows.length, { isDestroyed: () => false, webContents: { send } });
    try {
      expect(i18n.languageEnvironment().timeZone).toBeNull();
      i18n.applyTimeZonePreference("Asia/Tokyo");
      expect(send).toHaveBeenCalledExactlyOnceWith("zipkit:languageChanged", { language: "en", locale: "en", timeZone: "Asia/Tokyo" });
      i18n.applyTimeZonePreference("Asia/Tokyo");
      expect(send).toHaveBeenCalledOnce();
      i18n.applyTimeZonePreference("system");
      expect(i18n.languageEnvironment().timeZone).toBeNull();
      expect(send).toHaveBeenCalledTimes(2);
    } finally { electron.windows.splice(0); }
  });
});
