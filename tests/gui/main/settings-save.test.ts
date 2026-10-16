import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../src/gui/shared/spec.js";
const effects = vi.hoisted(() => ({ write: vi.fn(), sync: vi.fn(), apply: vi.fn(), send: vi.fn(), language: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [{ webContents: { send: effects.send } }] } }));
vi.mock("../../../src/gui/main/managedJson.js", async (original) => ({
  ...await original<typeof import("../../../src/gui/main/managedJson.js")>(), writeManagedJson: effects.write,
}));
vi.mock("../../../src/gui/main/managed-write.js", () => ({ writeManagedTextWithin: effects.sync }));
vi.mock("../../../src/gui/main/runtime.js", () => ({ getMainWindow: () => null, log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../src/gui/main/theme.js", () => ({ applyThemePreference: effects.apply }));
vi.mock("../../../src/gui/main/i18n.js", () => ({ applyLanguagePreference: effects.language, mainTranslator: () => ({ t: (key: string) => key }) }));
vi.mock("../../../src/gui/main/startup-dialog.js", () => ({ showAppMessageDialog: vi.fn(async () => {}) }));
import { discardSettingsSubmission, saveSettingsBeforeSessionEnd, settingsSavePending, settleSettingsSave, submitSettings } from "../../../src/gui/main/settings-save.js";
import { currentSettings } from "../../../src/gui/main/settings.js";
import { appAdmission } from "../../../src/gui/main/command-admission.js";

beforeEach(() => {
  appAdmission.reopen();
  discardSettingsSubmission();
  vi.clearAllMocks();
  effects.write.mockResolvedValue(undefined);
  effects.language.mockResolvedValue(undefined);
});

it("joins only the same submitted packet after a renderer reload, through interface application", async () => {
  let finish!: () => void;
  effects.language.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const packet = { ...DEFAULT_SETTINGS, theme: "dark" as const };
  const save = submitSettings(packet);
  await vi.waitFor(() => expect(effects.language).toHaveBeenCalledOnce());
  try {
    expect(submitSettings({ ...packet })).toBe(save);
    const different = submitSettings({ ...packet, uiFontFamily: "Georgia" });
    expect(different).not.toBe(save);
    await expect(different).rejects.toThrow("pending");
    expect(effects.write).toHaveBeenCalledOnce();
  } finally { finish(); await save; }
  await submitSettings({ ...packet, uiFontFamily: "Georgia" });
  expect(currentSettings().uiFontFamily).toBe("Georgia");
});

it("refuses new Settings submissions during quit while joining the already submitted save", async () => {
  let finish!: () => void;
  effects.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const save = submitSettings({ ...DEFAULT_SETTINGS, theme: "dark" });
  appAdmission.close();
  try {
    const refused = submitSettings({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(refused).not.toBe(save);
    await expect(refused).rejects.toThrow("shutting down");
    const join = settleSettingsSave();
    finish();
    await Promise.all([save, join]);
    expect(currentSettings().theme).toBe("dark");
  } finally { appAdmission.reopen(); finish(); await save; }
});

it("joins actual publication, retains it through a close attempt, and broadcasts the commit", async () => {
  let finish!: () => void;
  effects.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const save = submitSettings({ ...DEFAULT_SETTINGS, theme: "dark" });
  const join = settleSettingsSave();
  expect(settingsSavePending()).toBe(true);
  expect(() => discardSettingsSubmission()).toThrow("pending");
  expect(effects.write).toHaveBeenCalledOnce();
  expect(effects.send).not.toHaveBeenCalled();
  finish();
  await Promise.all([save, join]);
  expect(settingsSavePending()).toBe(false);
  expect(currentSettings().theme).toBe("dark");
  expect(effects.apply).toHaveBeenCalledWith("dark");
  expect(effects.send).toHaveBeenCalledWith("zipkit:settingsChanged", expect.objectContaining({ theme: "dark" }));
  discardSettingsSubmission();
  await settleSettingsSave();
  expect(effects.write).toHaveBeenCalledOnce();
});

it("retries captured submitted values after failure, without taking later local edits", async () => {
  effects.write.mockRejectedValueOnce(new Error("full"));
  const draft = { ...DEFAULT_SETTINGS, uiFontFamily: "Georgia", defaults: { ...DEFAULT_SETTINGS.defaults } };
  await expect(submitSettings(draft)).rejects.toThrow("full");
  draft.uiFontFamily = "unsubmitted";
  draft.defaults.level = 1;
  await settleSettingsSave();
  expect(effects.write).toHaveBeenCalledTimes(2);
  expect(currentSettings().uiFontFamily).toBe("Georgia");
  expect(currentSettings().defaults.level).toBe(DEFAULT_SETTINGS.defaults.level);
});

it("explicit discard retires a failed submission, and a replacement Save replaces it", async () => {
  effects.write.mockRejectedValueOnce(new Error("full"));
  await expect(submitSettings({ ...DEFAULT_SETTINGS, theme: "dark" })).rejects.toThrow();
  discardSettingsSubmission();
  await settleSettingsSave();
  saveSettingsBeforeSessionEnd(100);
  expect(effects.write).toHaveBeenCalledOnce();
  expect(effects.sync).not.toHaveBeenCalled();
  effects.write.mockRejectedValueOnce(new Error("full"));
  await expect(submitSettings({ ...DEFAULT_SETTINGS, theme: "dark" })).rejects.toThrow();
  await submitSettings({ ...DEFAULT_SETTINGS, theme: "light" });
  expect(currentSettings().theme).toBe("light");
});

it("Windows takeover publishes the same captured packet and preserves absent-default behavior", async () => {
  let finish!: () => void;
  effects.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const save = submitSettings(DEFAULT_SETTINGS);
  saveSettingsBeforeSessionEnd(321);
  expect(effects.sync).toHaveBeenCalledWith(expect.stringMatching(/config.json$/), "{}", 321, undefined, { createAbsent: false, durable: true });
  finish();
  await save;
  effects.sync.mockClear();
  saveSettingsBeforeSessionEnd(321);
  expect(effects.sync).not.toHaveBeenCalled();
});

it("Windows takeover saves a failed submission rather than subsequent edits to the draft", async () => {
  effects.write.mockRejectedValueOnce(new Error("disk full"));
  const draft = { ...DEFAULT_SETTINGS, theme: "dark" as const, defaults: { ...DEFAULT_SETTINGS.defaults, level: 2 } };
  await expect(submitSettings(draft)).rejects.toThrow("disk full");
  draft.defaults.level = 3;
  saveSettingsBeforeSessionEnd(250);
  const [, text, bound, , options] = effects.sync.mock.calls[0]!;
  expect(JSON.parse(text)).toMatchObject({ theme: "dark", defaults: { level: 2 } });
  expect(bound).toBe(250);
  expect(options).toEqual({ createAbsent: true, durable: true });
  expect(effects.apply).not.toHaveBeenCalled();
  expect(effects.send).not.toHaveBeenCalled();
});
