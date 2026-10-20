/**
 * The exclusion patterns ZipKit starts with: files and folders an operating
 * system or a file server writes beside a user's own, which are never a user's
 * file. They are an ordinary list, not a preset: a caller shows it, edits it,
 * resets it and passes it whole as `policy.exclusions`. It is plain data with
 * no Node imports, so a window loads it too (`zipkitsdk/types`). Each
 * matches in any case, since the casing varies by file system, and carries a
 * stable id, which a caller keys its own description on, and an English note
 * saying what it leaves out. A trailing slash marks a folder-only pattern.
 */

import type { ExclusionPattern } from "../types.ts";

function os(id: string, note: string, pattern: string): ExclusionPattern {
  const folder = pattern.endsWith("/");
  return { id, pattern, match: "glob", target: folder ? "dir" : "both", ignoreCase: true, note };
}

/** Grouped by operating system, the files met most often first; no two
 *  overlap, so the order decides only how the list reads. */
export const DEFAULT_EXCLUSIONS: readonly ExclusionPattern[] = Object.freeze([
  // macOS: everyday files
  os("macos.ds-store", "Finder’s view settings for a folder. Finder creates it again.", ".DS_Store"),
  os("macos.apple-double-file", "Mac-only data saved beside a file on a drive that isn’t Mac-formatted. ZipKit doesn’t keep such data.", "._*"),
  os("macos.macosx", "Mac-only data left over from unzipping a ZIP made on a Mac. Not part of the files themselves.", "__MACOSX/"),
  // "Icon" followed by a carriage return.
  os("macos.folder-icon", "A folder’s custom icon in Finder. A ZIP can’t hold its image.", "Icon\r"),
  os("macos.localized", "Tells Finder to show the folder’s name translated. Without it, the folder shows its own name.", ".localized"),
  // macOS: folders and files at a drive's root
  os("macos.trashes", "A drive’s Trash (macOS). Holds what was deleted from that drive.", ".Trashes"),
  os("macos.spotlight", "A drive’s Spotlight search index. macOS rebuilds it.", ".Spotlight-V100"),
  os("macos.fseventsd", "macOS’s record of changes on a drive. Rebuilt as needed.", ".fseventsd"),
  os("macos.temporary-items", "Temporary files macOS keeps on a drive.", ".TemporaryItems"),
  os("macos.document-revisions", "Older versions of documents macOS saved on a drive. Only macOS can read them.", ".DocumentRevisions-V100"),
  os("macos.mobile-backups", "Time Machine snapshots kept on the Mac itself (older macOS). Only Time Machine can use them.", ".MobileBackups/"),
  os("macos.volume-icon", "A drive’s custom icon in Finder. It belongs to the drive, not the files.", ".VolumeIcon.icns"),
  os("macos.time-machine-disk", "Marks a drive as a Time Machine backup disk. Not a file of yours.", ".com.apple.timemachine.donotpresent"),
  // macOS: file servers and classic Mac OS
  os("macos.apple-double-folder", "Mac-only data kept by a file server or a drive that isn’t Mac-formatted. ZipKit doesn’t keep such data.", ".AppleDouble/"),
  os("macos.apdisk", "Settings an AirPort base station saved on a shared drive.", ".apdisk"),
  os("macos.apple-db", "An old Apple file server’s own records. Not files of yours.", ".AppleDB"),
  os("macos.apple-desktop", "An old Apple file server’s own records. Not files of yours.", ".AppleDesktop"),
  os("macos.desktop-db", "Classic Mac OS’s record of a drive’s files and icons. The system rebuilds it.", "Desktop DB"),
  os("macos.desktop-df", "Classic Mac OS’s record of a drive’s files and icons. The system rebuilds it.", "Desktop DF"),
  // Windows
  os("windows.thumbs", "Windows’ thumbnail cache for a folder. Windows creates it again.", "Thumbs.db"),
  os("windows.desktop-ini", "A folder’s icon and display name, set by Windows or a sync app. The files don’t need it.", "desktop.ini"),
  os("windows.recycle-bin", "A drive’s Recycle Bin. Holds what was deleted from that drive.", "$RECYCLE.BIN/"),
  os("windows.recycler", "A drive’s Recycle Bin from older Windows. Holds what was deleted from that drive.", "RECYCLER/"),
  os("windows.recycled", "A drive’s Recycle Bin from older Windows. Holds what was deleted from that drive.", "RECYCLED/"),
  os("windows.system-volume-information", "Windows’ restore points and search index for a drive. Only Windows can use them.", "System Volume Information/"),
  os("windows.pagefile", "Windows’ memory or hibernation file, often several gigabytes. Windows creates it again at startup.", "pagefile.sys"),
  os("windows.hiberfil", "Windows’ memory or hibernation file, often several gigabytes. Windows creates it again at startup.", "hiberfil.sys"),
  os("windows.swapfile", "Windows’ memory or hibernation file, often several gigabytes. Windows creates it again at startup.", "swapfile.sys"),
  os("windows.ehthumbs", "Windows Media Center’s thumbnail cache. Rebuilt when needed.", "ehthumbs.db"),
  os("windows.ehthumbs-vista", "Windows Media Center’s thumbnail cache. Rebuilt when needed.", "ehthumbs_vista.db"),
  // Linux
  os("linux.kde-directory", "A folder’s icon and view settings in KDE. The files don’t need it.", ".directory"),
  os("linux.trash", "A drive’s Trash (Linux). Holds what was deleted from that drive.", ".Trash-*/"),
  os("linux.nfs", "A file deleted on a network share while still open. It disappears once closed.", ".nfs*"),
  os("linux.fuse-hidden", "A file deleted while still open (Linux). It disappears once closed.", ".fuse_hidden*"),
].map((p) => Object.freeze(p)));
