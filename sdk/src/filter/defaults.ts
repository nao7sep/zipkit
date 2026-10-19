/**
 * The exclusion patterns ZipKit starts with: files and folders an operating
 * system or a file server writes beside a user's own, which are never a user's
 * file. They are an ordinary list, not a preset: a caller shows it, edits it,
 * resets it and passes it whole as `policy.exclusions`. It is plain data with
 * no Node imports, so a window loads it too (`zipkitsdk/defaults`). Each matches in any
 * case, since the casing varies by file system, and carries a label naming
 * where it comes from. A trailing slash marks a folder-only pattern.
 */

import type { ExclusionPattern } from "../types.ts";

function os(label: string, pattern: string): ExclusionPattern {
  const folder = pattern.endsWith("/");
  return { pattern, match: "glob", target: folder ? "dir" : "both", ignoreCase: true, label };
}

export const DEFAULT_EXCLUSIONS: readonly ExclusionPattern[] = Object.freeze([
  os("macOS", ".DS_Store"),
  os("macOS", "__MACOSX/"),
  os("macOS", "._*"),
  // AppleDouble store on non-HFS volumes (AFP/Netatalk and copies to FAT or
  // network shares), the folder beside the `._*` files above.
  os("macOS", ".AppleDouble/"),
  // The custom-folder-icon file: "Icon" followed by a carriage return.
  os("macOS", "Icon\r"),
  os("macOS", ".Spotlight-V100"),
  os("macOS", ".DocumentRevisions-V100"),
  os("macOS", ".TemporaryItems"),
  os("macOS", ".Trashes"),
  os("macOS", ".fseventsd"),
  os("macOS", ".apdisk"),
  os("macOS", ".com.apple.timemachine.donotpresent"),
  os("macOS", ".VolumeIcon.icns"),
  // The empty marker Finder leaves in a folder whose name it shows translated.
  os("macOS", ".localized"),
  // An AFP file server's own databases at the root of a shared volume.
  os("macOS", ".AppleDB"),
  os("macOS", ".AppleDesktop"),
  os("Windows", "Thumbs.db"),
  os("Windows", "ehthumbs.db"),
  os("Windows", "ehthumbs_vista.db"),
  os("Windows", "desktop.ini"),
  os("Windows", "$RECYCLE.BIN/"),
  os("Windows", "System Volume Information/"),
  os("Linux", ".Trash-*/"),
  os("Linux", ".directory"),
  os("Linux", ".nfs*"),
  // A FUSE file system's stand-in for a file deleted while still open.
  os("Linux", ".fuse_hidden*"),
].map((p) => Object.freeze(p)));
