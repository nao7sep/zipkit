/**
 * The built-in junk preset, covering macOS, Windows, and Linux/freedesktop.
 * Each entry is a filter rule tagged with the registry rule it reports under,
 * so an excluded junk file produces the right `macos.junk` / `windows.junk` /
 * `linux.junk` info finding. A trailing slash marks a directory-only rule; the
 * matcher honours `target`, so the slash is purely declarative here. Every
 * pattern names OS-generated metadata that is never a real user file.
 */

import type { RuleId } from "../registry.js";
import type { FilterRule } from "../types.js";

export interface JunkRule {
  id: Extract<RuleId, "macos.junk" | "windows.junk" | "linux.junk">;
  rule: FilterRule;
}

function junk(id: JunkRule["id"], pattern: string): JunkRule {
  const isDir = pattern.endsWith("/");
  return {
    id,
    rule: {
      pattern,
      match: "glob",
      target: isDir ? "dir" : "both",
    },
  };
}

export const JUNK_RULES: readonly JunkRule[] = [
  // macOS
  junk("macos.junk", ".DS_Store"),
  junk("macos.junk", "__MACOSX/"),
  junk("macos.junk", "._*"),
  // The custom-folder-icon file: literally "Icon" followed by a carriage
  // return. It rides along in any folder given a custom icon in Finder.
  junk("macos.junk", "Icon\r"),
  junk("macos.junk", ".Spotlight-V100"),
  junk("macos.junk", ".DocumentRevisions-V100"),
  junk("macos.junk", ".TemporaryItems"),
  junk("macos.junk", ".Trashes"),
  junk("macos.junk", ".fseventsd"),
  junk("macos.junk", ".apdisk"),
  junk("macos.junk", ".com.apple.timemachine.donotpresent"),
  junk("macos.junk", ".VolumeIcon.icns"),
  // Windows
  junk("windows.junk", "Thumbs.db"),
  junk("windows.junk", "ehthumbs.db"),
  junk("windows.junk", "desktop.ini"),
  junk("windows.junk", "$RECYCLE.BIN/"),
  junk("windows.junk", "System Volume Information/"),
  // Linux / freedesktop
  junk("linux.junk", ".Trash-*/"),
  junk("linux.junk", ".directory"),
  junk("linux.junk", ".nfs*"),
];
