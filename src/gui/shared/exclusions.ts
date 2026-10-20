/**
 * The exclusion patterns the app starts with, and their descriptions in the
 * interface language. The list is the SDK's built-in one, each pattern with
 * its stable id and without the SDK's English note: a built-in pattern's
 * description is the catalogue entry for its id, shown as real, editable text
 * in the interface language ({@link noteShown}). What the user types is stored
 * as the pattern's note, unless it is that description in the interface
 * language, which is stored as no note again ({@link noteStored}). An
 * untouched description therefore follows the language, and survives any
 * change to its pattern's other fields.
 */

import { DEFAULT_EXCLUSIONS, type ExclusionPattern } from "zipkitsdk/types";
import type { MessageKey } from "./i18n/catalogues.js";

/** The built-in list as the app stores it: ids, no English notes. */
export const BUILT_IN_EXCLUSIONS: readonly ExclusionPattern[] = DEFAULT_EXCLUSIONS.map(({ note: _note, ...p }) => ({ ...p }));

/** Each built-in pattern's description, by the SDK's stable id. */
const DESCRIPTIONS: Readonly<Record<string, MessageKey>> = {
  "macos.ds-store": "exclusionNote.dsStore",
  "macos.macosx": "exclusionNote.macosx",
  "macos.apple-double-file": "exclusionNote.appleDoubleFiles",
  "macos.apple-double-folder": "exclusionNote.appleDoubleFolder",
  "macos.folder-icon": "exclusionNote.folderIcon",
  "macos.spotlight": "exclusionNote.spotlight",
  "macos.document-revisions": "exclusionNote.revisions",
  "macos.temporary-items": "exclusionNote.temporaryItems",
  "macos.trashes": "exclusionNote.trashMac",
  "macos.fseventsd": "exclusionNote.fseventsd",
  "macos.apdisk": "exclusionNote.apdisk",
  "macos.time-machine-disk": "exclusionNote.timeMachine",
  "macos.volume-icon": "exclusionNote.volumeIcon",
  "macos.localized": "exclusionNote.localized",
  "macos.apple-db": "exclusionNote.appleServer",
  "macos.apple-desktop": "exclusionNote.appleServer",
  "macos.desktop-db": "exclusionNote.classicDesktop",
  "macos.desktop-df": "exclusionNote.classicDesktop",
  "macos.mobile-backups": "exclusionNote.mobileBackups",
  "windows.thumbs": "exclusionNote.thumbs",
  "windows.ehthumbs": "exclusionNote.mediaCenterThumbs",
  "windows.ehthumbs-vista": "exclusionNote.mediaCenterThumbs",
  "windows.desktop-ini": "exclusionNote.desktopIni",
  "windows.recycle-bin": "exclusionNote.recycleBin",
  "windows.system-volume-information": "exclusionNote.systemVolume",
  "windows.pagefile": "exclusionNote.windowsMemory",
  "windows.hiberfil": "exclusionNote.windowsMemory",
  "windows.swapfile": "exclusionNote.windowsMemory",
  "windows.recycler": "exclusionNote.oldRecycleBin",
  "windows.recycled": "exclusionNote.oldRecycleBin",
  "linux.trash": "exclusionNote.trashLinux",
  "linux.kde-directory": "exclusionNote.kdeDirectory",
  "linux.nfs": "exclusionNote.nfs",
  "linux.fuse-hidden": "exclusionNote.fuseHidden",
};

/** A built-in pattern's description key, by its id. */
export function descriptionKey(id: string | undefined): MessageKey | undefined {
  return id === undefined ? undefined : DESCRIPTIONS[id];
}

/** A pattern's note as the field shows it: what the user typed, else a
 *  built-in pattern's description in the interface language. */
export function noteShown(pattern: Pick<ExclusionPattern, "id" | "note">, translate: (key: MessageKey) => string): string {
  if (pattern.note !== undefined) return pattern.note;
  const key = descriptionKey(pattern.id);
  return key ? translate(key) : "";
}

/** The text typed into a note field as it is stored: a built-in pattern's
 *  description in the interface language as no note, so it keeps following
 *  the language; any other text as typed. */
export function noteStored(text: string, pattern: Pick<ExclusionPattern, "id">, translate: (key: MessageKey) => string): string | undefined {
  const key = descriptionKey(pattern.id);
  return key && translate(key) === text ? undefined : text;
}
