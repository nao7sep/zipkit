/**
 * The quit questions use the app's own question dialog, on the main window when
 * one is open and standalone otherwise, with the safe choice as both default and
 * Escape/close outcome, and an ending session's signal passed through.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, response: 0 }));

vi.mock("electron", () => ({}));
vi.mock("../../../src/gui/main/startup-dialog.js", () => ({
  showAppQuestionDialog: async (options: Record<string, unknown>) => {
    shown.calls.push(options);
    return shown.response;
  },
}));
vi.mock("../../../src/gui/main/i18n.js", async () => {
  const { createTranslator } = await import("../../../src/gui/shared/i18n/translate.js");
  return { mainTranslator: () => createTranslator("en") };
});

import type { BrowserWindow } from "electron";
import { askQueueNotSaved, confirmQuitDuringWrite } from "../../../src/gui/main/quit-confirm-dialog.js";

const owner = { id: 1 } as unknown as BrowserWindow;

beforeEach(() => {
  shown.calls.length = 0;
  shown.response = 0;
});

describe("confirmQuitDuringWrite", () => {
  it("asks on the main window, with Keep Working as the default and the close outcome", async () => {
    const signal = new AbortController().signal;
    shown.response = 0;

    await expect(confirmQuitDuringWrite(owner, signal)).resolves.toBe(true);

    const options = shown.calls[0]!;
    expect(options.owner).toBe(owner);
    expect(options.signal).toBe(signal);
    expect(options.labels).toEqual(["Cancel the Job and Quit", "Keep Working"]);
    expect(options).toMatchObject({ defaultId: 1, cancelId: 1, title: "A job is still running" });
    expect(options.message).toContain("files already sent to Trash may still arrive there");
  });

  it("asks standalone with no window open, and keeps working on any other answer", async () => {
    shown.response = 1;

    await expect(confirmQuitDuringWrite(null, new AbortController().signal)).resolves.toBe(false);

    expect(shown.calls[0]!.owner).toBeUndefined();
  });
});

describe("askQueueNotSaved", () => {
  it.each([[0, "retry"], [1, "quit"], [2, "cancel"], [7, "cancel"]] as const)("maps answer %i to %s", async (response, choice) => {
    shown.response = response;
    await expect(askQueueNotSaved(owner, new AbortController().signal)).resolves.toBe(choice);
    expect(shown.calls[0]).toMatchObject({ owner, defaultId: 0, cancelId: 2, labels: ["Retry", "Quit Anyway", "Cancel"] });
  });
});
