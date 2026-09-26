import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, systemPreferences: {} }));

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
