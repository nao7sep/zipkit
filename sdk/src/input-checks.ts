/** Pure semantic checks shared by SDK admission and editors. */
import { fullFixSegment } from "./plan/nameFix.ts";

/** A single safe entry name, without normalizing away separators or traversal. */
export function isSafePathComponent(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/]/.test(name)
    && fullFixSegment(name, "_") === name;
}

export function exclusionIssue(rule: { pattern: string; match?: "glob" | "regex"; target?: "file" | "dir" | "both" }): "regex" | "target" | null {
  if (rule.match === "regex") {
    try { new RegExp(rule.pattern); } catch { return "regex"; }
  } else if (rule.pattern.endsWith("/") && rule.target === "file") return "target";
  return null;
}
