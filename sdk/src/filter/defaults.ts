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
  os("Finder’s view settings for a folder, rebuilt when it is opened", ".DS_Store"),
  os("Mac file details stored as separate files on drives that aren’t Mac-formatted", "._*"),
  os("Mac file details left behind by unzipping a Mac-made ZIP", "__MACOSX/"),
  // "Icon" followed by a carriage return.
  os("A custom folder icon, whose image a ZIP can’t hold", "Icon\r"),
  os("Finder’s marker for a folder shown under a translated name", ".localized"),
  // macOS: folders and files at a drive's root
  os("A drive’s Trash (macOS)", ".Trashes"),
  os("A drive’s Spotlight search index (macOS)", ".Spotlight-V100"),
  os("A drive’s log of file changes (macOS)", ".fseventsd"),
  os("A drive’s temporary files (macOS)", ".TemporaryItems"),
  os("A drive’s database of saved document versions (macOS)", ".DocumentRevisions-V100"),
  os("A drive’s local Time Machine snapshots (older macOS)", ".MobileBackups/"),
  os("A drive’s custom icon (macOS)", ".VolumeIcon.icns"),
  os("Time Machine’s marker on a backup drive", ".com.apple.timemachine.donotpresent"),
  // macOS: file servers and classic Mac OS
  os("Mac file details kept by a file server or a drive that isn’t Mac-formatted", ".AppleDouble/"),
  os("A shared drive’s AirPort Disk settings", ".apdisk"),
  os("An old Apple file server’s own database", ".AppleDB"),
  os("An old Apple file server’s own database", ".AppleDesktop"),
  os("A drive’s desktop database (classic Mac OS)", "Desktop DB"),
  os("A drive’s desktop database (classic Mac OS)", "Desktop DF"),
  // Windows
  os("Windows’ thumbnail cache", "Thumbs.db"),
  os("A folder’s display settings, added by Windows and sync apps", "desktop.ini"),
  os("A drive’s Recycle Bin (Windows)", "$RECYCLE.BIN/"),
  os("A drive’s Recycle Bin (older Windows)", "RECYCLER/"),
  os("A drive’s Recycle Bin (older Windows)", "RECYCLED/"),
  os("A drive’s restore points and search index (Windows)", "System Volume Information/"),
  os("A drive’s Windows memory or hibernation file", "pagefile.sys"),
  os("A drive’s Windows memory or hibernation file", "hiberfil.sys"),
  os("A drive’s Windows memory or hibernation file", "swapfile.sys"),
  os("Windows Media Center’s thumbnail cache", "ehthumbs.db"),
  os("Windows Media Center’s thumbnail cache", "ehthumbs_vista.db"),
  // Linux
  os("A folder’s display settings in KDE (Linux)", ".directory"),
  os("A drive’s Trash (Linux)", ".Trash-*/"),
  os("A file deleted on a network share while still open", ".nfs*"),
  os("A file deleted while still open (Linux)", ".fuse_hidden*"),
].map((p) => Object.freeze(p)));
