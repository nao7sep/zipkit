/** Submitted Settings belong to the app until saved or explicitly discarded: one save runs at a
 * time, the newest submission waiting behind it, and a failed one stays for Retry. Unsubmitted
 * modal edits never enter this owner. */
import { BrowserWindow } from "electron";
import type { GuiSettings } from "../shared/spec.js";
import { checkedSettings, currentSettings, saveSettings, serializeSettings, settingsFile, storedSettings, admitSettingsSave } from "./settings.js";
import { writeManagedTextWithin } from "./managed-write.js";
import { applyThemePreference } from "./theme.js";
import { applyLanguagePreference, applyTimeZonePreference, mainTranslator } from "./i18n.js";
import { getMainWindow, log } from "./runtime.js";
import { errorInfo } from "./log.js";
import { showAppMessageDialog } from "./startup-dialog.js";
import { appAdmission } from "./command-admission.js";
import { newestSave } from "./managedJson.js";

const saves = newestSave(publish);

// Whether the Settings dialog holds edits not yet submitted. They live only in
// the renderer; it reports each change so quit can ask before they go.
let draftOpen = false;
export function reportSettingsDraft(dirty: boolean): void { draftOpen = dirty; }
export function settingsDraftOpen(): boolean { return draftOpen; }

/** Called only after the editor's discard decision: a failed submission is forgotten. */
export function discardSettingsSubmission(): void {
  saves.discard();
}

/** Save the dialog's settings; resolves to the settings now in effect. */
export async function submitSettings(draft: GuiSettings): Promise<GuiSettings> {
  if (!appAdmission.accepting()) throw new Error("The app is shutting down");
  await saves.save(checkedSettings(draft, log));
  return currentSettings();
}

export function settleSettingsSave(): Promise<void> {
  return saves.flush();
}

async function publish(packet: GuiSettings): Promise<void> {
  let saved: GuiSettings;
  try { saved = await saveSettings(packet, log); }
  catch (error) {
    log.error("failed to persist settings", { error: errorInfo(error) });
    throw error;
  }
  // The same application path runs for Save and quit Retry. A later cancelled
  // quit must leave both main and renderer using these committed preferences.
  const failures: unknown[] = [];
  try { applyThemePreference(saved.theme); } catch (error) { failures.push(error); }
  try { await applyLanguagePreference(saved.language, (error) => failures.push(error)); }
  catch (error) { failures.push(error); }
  try { applyTimeZonePreference(saved.timeZone); } catch (error) { failures.push(error); }
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
}

/** Windows cannot await the event loop at session-end. Publish the unsaved
 * packet through the same atomic writer; skip optional backups and UI changes. */
export function saveSettingsBeforeSessionEnd(boundMs: number): void {
  const submitted = saves.unsaved();
  if (!submitted) return;
  admitSettingsSave();
  const stored = storedSettings(submitted);
  writeManagedTextWithin(settingsFile(), serializeSettings(stored), boundMs, undefined,
    { createAbsent: Object.keys(stored).length > 0, kind: "config" });
}
