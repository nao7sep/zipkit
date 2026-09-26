import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  defaults: new Map<string, unknown>(),
  calls: [] as string[],
  preferred: ["ja-JP", "en-US"],
  isPackaged: true,
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
  BrowserWindow: { getAllWindows: () => [] },
}));

const { readSavedPreference } = await import("../../../src/gui/main/i18n.js");

describe("readSavedPreference", () => {
  it("reads the saved choice from config.json's text", () => {
    expect(readSavedPreference(JSON.stringify({ version: 1, language: "ko" }))).toBe("ko");
  });

  it("is System for a missing, unreadable, unknown or corrupt choice", () => {
    expect(readSavedPreference(null)).toBe("system");
    expect(readSavedPreference(JSON.stringify({ version: 1 }))).toBe("system");
    expect(readSavedPreference(JSON.stringify({ version: 1, language: "tlh" }))).toBe("system");
    expect(readSavedPreference("{ not json")).toBe("system");
    expect(readSavedPreference("null")).toBe("system");
  });
});

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
    i18n.settleLanguage("fr", vi.fn());
    expect(electron.calls).toContain("remove");
    expect(electron.calls.indexOf("remove")).toBeLessThan(electron.calls.indexOf("read"));
    expect(electron.defaults.get("AppleLanguages")).toEqual(["fr"]);
  });

  it("removes the entry when System is chosen", async () => {
    electron.defaults.set("AppleLanguages", ["fr"]);
    const i18n = await load();
    i18n.settleLanguage("system", vi.fn());
    expect(electron.defaults.has("AppleLanguages")).toBe(false);
  });

  it("touches no defaults off macOS", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const i18n = await load();
    i18n.settleLanguage("fr", vi.fn());
    expect(electron.calls.filter((call) => call !== "read")).toEqual([]);
  });

  it("touches no defaults on an unpackaged macOS run", async () => {
    electron.isPackaged = false;
    const i18n = await load();
    i18n.settleLanguage("fr", vi.fn());
    expect(electron.calls.filter((call) => call !== "read")).toEqual([]);
  });
});
