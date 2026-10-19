/**
 * The exclusion patterns ZipKit starts with: files and folders an operating
 * system or a file server writes beside a user's own, which are never a user's
 * file. They are an ordinary list, not a preset: a caller shows it, edits it,
 * resets it and passes it whole as `policy.exclusions`. It is plain data with
 * no Node imports, so a window loads it too (`zipkitsdk/defaults`). Each
 * matches in any case, since the casing varies by file system, and carries an
 * English note saying what it leaves out. A trailing slash marks a folder-only pattern.
 */

import type { ExclusionPattern } from "../types.ts";

function os(note: string, pattern: string): ExclusionPattern {
  const folder = pattern.endsWith("/");
  return { pattern, match: "glob", target: folder ? "dir" : "both", ignoreCase: true, note };
}

/** Grouped by operating system, the files met most often first; no two
 *  overlap, so the order decides only how the list reads. */
export const DEFAULT_EXCLUSIONS: readonly ExclusionPattern[] = Object.freeze([
  // macOS: everyday files
  os("Finder’s view settings for a folder. Finder creates it again.", ".DS_Store"),
  os("Mac-only data saved beside a file on a drive that isn’t Mac-formatted. ZipKit doesn’t keep such data.", "._*"),
  os("Mac-only data left over from unzipping a ZIP made on a Mac. Not part of the files themselves.", "__MACOSX/"),
  // "Icon" followed by a carriage return.
  os("A folder’s custom icon in Finder. A ZIP can’t hold its image.", "Icon\r"),
  os("Tells Finder to show the folder’s name translated. Without it, the folder shows its own name.", ".localized"),
  // macOS: folders and files at a drive's root
  os("A drive’s Trash (macOS). Holds what was deleted from that drive.", ".Trashes"),
  os("A drive’s Spotlight search index. macOS rebuilds it.", ".Spotlight-V100"),
  os("macOS’s record of changes on a drive. Rebuilt as needed.", ".fseventsd"),
  os("Temporary files macOS keeps on a drive.", ".TemporaryItems"),
  os("Older versions of documents macOS saved on a drive. Only macOS can read them.", ".DocumentRevisions-V100"),
  os("Time Machine snapshots kept on the Mac itself (older macOS). Only Time Machine can use them.", ".MobileBackups/"),
  os("A drive’s custom icon in Finder. It belongs to the drive, not the files.", ".VolumeIcon.icns"),
  os("Marks a drive as a Time Machine backup disk. Not a file of yours.", ".com.apple.timemachine.donotpresent"),
  // macOS: file servers and classic Mac OS
  os("Mac-only data kept by a file server or a drive that isn’t Mac-formatted. ZipKit doesn’t keep such data.", ".AppleDouble/"),
  os("Settings an AirPort base station saved on a shared drive.", ".apdisk"),
  os("An old Apple file server’s own records. Not files of yours.", ".AppleDB"),
  os("An old Apple file server’s own records. Not files of yours.", ".AppleDesktop"),
  os("Classic Mac OS’s record of a drive’s files and icons. The system rebuilds it.", "Desktop DB"),
  os("Classic Mac OS’s record of a drive’s files and icons. The system rebuilds it.", "Desktop DF"),
  // Windows
  os("Windows’ thumbnail cache for a folder. Windows creates it again.", "Thumbs.db"),
  os("A folder’s icon and display name, set by Windows or a sync app. The files don’t need it.", "desktop.ini"),
  os("A drive’s Recycle Bin. Holds what was deleted from that drive.", "$RECYCLE.BIN/"),
  os("A drive’s Recycle Bin from older Windows. Holds what was deleted from that drive.", "RECYCLER/"),
  os("A drive’s Recycle Bin from older Windows. Holds what was deleted from that drive.", "RECYCLED/"),
  os("Windows’ restore points and search index for a drive. Only Windows can use them.", "System Volume Information/"),
  os("Windows’ memory or hibernation file, often several gigabytes. Windows creates it again at startup.", "pagefile.sys"),
  os("Windows’ memory or hibernation file, often several gigabytes. Windows creates it again at startup.", "hiberfil.sys"),
  os("Windows’ memory or hibernation file, often several gigabytes. Windows creates it again at startup.", "swapfile.sys"),
  os("Windows Media Center’s thumbnail cache. Rebuilt when needed.", "ehthumbs.db"),
  os("Windows Media Center’s thumbnail cache. Rebuilt when needed.", "ehthumbs_vista.db"),
  // Linux
  os("A folder’s icon and view settings in KDE. The files don’t need it.", ".directory"),
  os("A drive’s Trash (Linux). Holds what was deleted from that drive.", ".Trash-*/"),
  os("A file deleted on a network share while still open. It disappears once closed.", ".nfs*"),
  os("A file deleted while still open (Linux). It disappears once closed.", ".fuse_hidden*"),
].map((p) => Object.freeze(p)));
