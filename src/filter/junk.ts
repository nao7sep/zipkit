/**
 * The built-in junk preset (§10.1), bidirectional across macOS and Windows.
 * Each entry is a filter rule tagged with the registry rule it reports under,
 * so an excluded junk file produces the right `macos.junk` / `windows.junk`
 * info finding. A trailing slash marks a directory-only rule; the matcher
 * honours `target`, so the slash is purely declarative here.
 */

import type { RuleId } from "../registry.js";
import type { FilterRule } from "../types.js";

export interface JunkRule {
  id: Extract<RuleId, "macos.junk" | "windows.junk">;
  rule: FilterRule;
}

function junk(id: JunkRule["id"], pattern: string): JunkRule {
  const isDir = pattern.endsWith("/");
  return {
    id,
    rule: {
      action: "exclude",
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
  junk("macos.junk", ".Spotlight-V100"),
  junk("macos.junk", ".Trashes"),
  junk("macos.junk", ".fseventsd"),
  // Windows
  junk("windows.junk", "Thumbs.db"),
  junk("windows.junk", "ehthumbs.db"),
  junk("windows.junk", "desktop.ini"),
  junk("windows.junk", "$RECYCLE.BIN/"),
  junk("windows.junk", "System Volume Information/"),
];
