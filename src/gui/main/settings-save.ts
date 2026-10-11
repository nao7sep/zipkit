/** Submitted Settings belong to the app until saved or explicitly discarded.
 * A timeout never releases the actual write; Retry joins it while it is pending.
 * Unsubmitted modal edits never enter this owner. */
import { BrowserWindow } from "electron";
import { changedSettings, DEFAULT_SETTINGS, type GuiSettings } from "../shared/spec.js";
import { checkedSettings, saveSettings, serializeSettings, settingsFile } from "./settings.js";
import { writeManagedTextWithin } from "./managed-write.js";
import { applyThemePreference } from "./theme.js";
import { applyLanguagePreference, mainTranslator } from "./i18n.js";
import { getMainWindow, log } from "./runtime.js";
import { errorInfo } from "./log.js";
import { showAppMessageDialog } from "./startup-dialog.js";

let submitted: GuiSettings | undefined;
let running: Promise<GuiSettings> | undefined;

export function settingsSavePending(): boolean { return running !== undefined; }

/** Called only after the editor's discard decision, or its native window close.
 * Refusing while busy preserves the same guard as the modal's disabled controls. */
export function discardSettingsSubmission(): void {
  if (running) throw new Error("Settings publication is still pending");
  submitted = undefined;
}

export function submitSettings(draft: GuiSettings): Promise<GuiSettings> {
  if (running) return running;
  submitted = checkedSettings(draft, log);
  return publish();
}

export async function settleSettingsSave(): Promise<void> {
  if (running) await running;
  else if (submitted) await publish();
}

function publish(): Promise<GuiSettings> {
  const packet = submitted!;
  const work = (async () => {
    let saved: GuiSettings;
    try { saved = await saveSettings(packet, log); }
    catch (error) {
      log.error("failed to persist settings", { error: errorInfo(error) });
      throw error;
    }
    submitted = undefined;
    // The same application path runs for Save and quit Retry. A later cancelled
    // quit must leave both main and renderer using these committed preferences.
    const failures: unknown[] = [];
    try { applyThemePreference(saved.theme); } catch (error) { failures.push(error); }
    try { await applyLanguagePreference(saved.language, (error) => failures.push(error)); }
    catch (error) { failures.push(error); }
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("zipkit:settingsChanged", saved); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) {
      log.warn("settings saved but interface application was incomplete", { errors: failures.map(errorInfo) });
      const { t } = mainTranslator();
      void showAppMessageDialog({ owner: getMainWindow() ?? undefined,
        title: t("settings.title"), message: t("settings.savedApplyFailed"), button: "ok",
      }).catch((error) => log.error("saved settings warning could not be shown", { error: errorInfo(error) }));
    }
    return saved;
  })();
  running = work.finally(() => { running = undefined; });
  return running;
}

/** Windows cannot await the event loop at session-end. Publish the captured
 * packet through the same atomic writer; skip optional backups and UI changes. */
export function saveSettingsBeforeSessionEnd(boundMs: number): void {
  if (!submitted) return;
  const stored = changedSettings(DEFAULT_SETTINGS, submitted);
  writeManagedTextWithin(settingsFile(), serializeSettings(stored), boundMs, undefined,
    { createAbsent: Object.keys(stored).length > 0 });
}
