/**
 * Building exclude rules from CLI pattern strings — the one place both `create`
 * and `extract` turn `--exclude`/`--exclude-regex` flags into {@link FilterRule}s,
 * so the two verbs agree on dialect and the trailing-slash directory convention.
 */

import type { FilterRule } from "../types.js";

/** A glob exclusion. A trailing slash targets directories only. */
export function globExclude(pattern: string): FilterRule {
  return { pattern, match: "glob", target: pattern.endsWith("/") ? "dir" : "both" };
}

/** A regex exclusion. Applies to files and directories alike. */
export function regexExclude(pattern: string): FilterRule {
  return { pattern, match: "regex", target: "both" };
}
