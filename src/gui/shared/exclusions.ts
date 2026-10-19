/**
 * The exclusion patterns the app starts with, and their notes in the
 * interface language. The list is the SDK's built-in one, English notes
 * included, so a built-in note is stored as that English text. The note field
 * shows it as real, editable text in the interface language
 * ({@link noteShown}); what the user types is stored as typed, unless it is
 * a built-in note's text in that language, which is stored as the English
 * note again ({@link noteStored}). An untouched description therefore follows
 * the language, and survives any change to its pattern's other fields.
 */

import type { ExclusionPattern } from "zipkitsdk/types";
import { DEFAULT_EXCLUSIONS } from "zipkitsdk/defaults";
import type { MessageKey } from "./i18n/catalogues.js";

/** The built-in list as the app stores it, with the SDK's English notes. */
export const BUILT_IN_EXCLUSIONS: readonly ExclusionPattern[] = DEFAULT_EXCLUSIONS.map((p) => ({ ...p }));

/** Each built-in pattern's description, by pattern. */
const DESCRIPTIONS: Readonly<Record<string, MessageKey>> = {
  ".DS_Store": "exclusionNote.dsStore",
  "__MACOSX/": "exclusionNote.macosx",
  "._*": "exclusionNote.appleDoubleFiles",
  ".AppleDouble/": "exclusionNote.appleDoubleFolder",
  "Icon\r": "exclusionNote.folderIcon",
  ".Spotlight-V100": "exclusionNote.spotlight",
  ".DocumentRevisions-V100": "exclusionNote.revisions",
  ".TemporaryItems": "exclusionNote.temporaryItems",
  ".Trashes": "exclusionNote.trashMac",
  ".fseventsd": "exclusionNote.fseventsd",
  ".apdisk": "exclusionNote.apdisk",
  ".com.apple.timemachine.donotpresent": "exclusionNote.timeMachine",
  ".VolumeIcon.icns": "exclusionNote.volumeIcon",
  ".localized": "exclusionNote.localized",
  ".AppleDB": "exclusionNote.appleServer",
  ".AppleDesktop": "exclusionNote.appleServer",
  "Thumbs.db": "exclusionNote.thumbs",
  "ehthumbs.db": "exclusionNote.mediaCenterThumbs",
  "ehthumbs_vista.db": "exclusionNote.mediaCenterThumbs",
  "desktop.ini": "exclusionNote.desktopIni",
  "$RECYCLE.BIN/": "exclusionNote.recycleBin",
  "System Volume Information/": "exclusionNote.systemVolume",
  ".Trash-*/": "exclusionNote.trashLinux",
  ".directory": "exclusionNote.kdeDirectory",
  ".nfs*": "exclusionNote.nfs",
  ".fuse_hidden*": "exclusionNote.fuseHidden",
  "pagefile.sys": "exclusionNote.windowsMemory",
  "hiberfil.sys": "exclusionNote.windowsMemory",
  "swapfile.sys": "exclusionNote.windowsMemory",
  "RECYCLER/": "exclusionNote.oldRecycleBin",
  "RECYCLED/": "exclusionNote.oldRecycleBin",
  "Desktop DB": "exclusionNote.classicDesktop",
  "Desktop DF": "exclusionNote.classicDesktop",
  ".MobileBackups/": "exclusionNote.mobileBackups",
};

/** Each built-in English note's description key. */
const NOTE_KEYS: ReadonlyMap<string, MessageKey> = new Map(
  DEFAULT_EXCLUSIONS.flatMap((p) => (p.note !== undefined && DESCRIPTIONS[p.pattern] ? [[p.note, DESCRIPTIONS[p.pattern]!] as const] : [])),
);

/** A stored note as the field shows it: a built-in note in the interface
 *  language, any other as stored. */
export function noteShown(note: string | undefined, translate: (key: MessageKey) => string): string {
  if (note === undefined) return "";
  const key = NOTE_KEYS.get(note);
  return key ? translate(key) : note;
}

/** The text typed into a note field as it is stored: a built-in note's text
 *  in the interface language as its English note, so it keeps following the
 *  language; any other text as typed. */
export function noteStored(text: string, translate: (key: MessageKey) => string): string {
  for (const [english, key] of NOTE_KEYS) if (translate(key) === text) return english;
  return text;
}
