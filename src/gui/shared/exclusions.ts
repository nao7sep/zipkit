/**
 * The exclusion patterns the app starts with, and what each one leaves out in
 * the interface language. The list is the SDK's built-in one without its
 * English notes: a built-in pattern's description is worked out from the
 * language at display time and shown as its note field's placeholder
 * (config-sets conventions, In the interface), so a saved list holds no text
 * in whatever language was showing when it was saved. A note the user types,
 * on a built-in pattern or their own, is theirs and is saved as typed.
 */

import type { ExclusionPattern } from "zipkitsdk/types";
import { DEFAULT_EXCLUSIONS } from "zipkitsdk/defaults";
import type { MessageKey } from "./i18n/catalogues.js";

/** The built-in list as the app stores it: without notes. */
export const BUILT_IN_EXCLUSIONS: readonly ExclusionPattern[] = DEFAULT_EXCLUSIONS.map(({ note: _note, ...p }) => p);

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
};

/** The description of a pattern that is one of the built-ins exactly (same
 *  text, dialect, target and case rule), or null for any other. */
export function builtInDescription(p: ExclusionPattern): MessageKey | null {
  const builtIn = BUILT_IN_EXCLUSIONS.find((b) =>
    b.pattern === p.pattern && b.match === p.match && b.target === p.target && b.ignoreCase === p.ignoreCase);
  return builtIn ? DESCRIPTIONS[builtIn.pattern] ?? null : null;
}
