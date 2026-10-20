/**
 * The exclusion engine. A policy's exclusion patterns form one ordered list;
 * the first that matches a path excludes it, and the matched pattern is
 * returned so the caller can report *why*. The system is inclusive by
 * default: a path no pattern matches is kept. There is no "include": what goes
 * in is chosen by the inputs; patterns only ever subtract.
 *
 * The matcher is pure. The scan layer uses it to prune excluded directory
 * subtrees during the walk and the plan layer to decide each surviving entry.
 *
 * Pattern dialects follow gitignore conventions: a glob without a leading slash
 * is unanchored and matches at any depth; a leading slash (or any interior
 * slash) anchors to the root; `**` spans segments; a regex matches anywhere
 * unless anchored with `^`/`$`. A glob's trailing slash marks a folder, as in
 * gitignore: whatever its `target`, it never matches a file. A pattern
 * matches case-sensitively unless it says `ignoreCase`.
 */

import picomatch from "picomatch";
import type { ArchivePolicy, ExcludedBy, ExclusionPattern } from "../types.ts";

export interface CompiledRule {
  target: ExclusionPattern["target"];
  test: (path: string) => boolean;
  /** The pattern as the policy gave it. */
  pattern: ExclusionPattern;
  /** Human-readable description for an entry's `excludeReason`. */
  describe: string;
  /** The pattern as an excluded entry records it. */
  excludedBy: ExcludedBy;
}

export interface FilterMatcher {
  /** The first exclusion pattern that applies to the path, or null when none match. */
  match(path: string, isDir: boolean): CompiledRule | null;
}

function stripTrailingSlash(pattern: string): string {
  return pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
}

function isAnchored(pattern: string): boolean {
  // A leading slash anchors to the root; per gitignore, an interior slash
  // anchors too. A pattern with no slash (or only a trailing one) floats.
  return pattern.startsWith("/") || pattern.includes("/");
}

function compileGlob(pattern: string, nocase: boolean): (path: string) => boolean {
  let body = stripTrailingSlash(pattern);
  const anchored = isAnchored(body);
  if (body.startsWith("/")) body = body.slice(1);
  // Unanchored patterns must match at any depth, so also match under any
  // prefix; `dot: true` lets a dotfile (`.DS_Store`) match.
  const globs = anchored ? [body] : [body, `**/${body}`];
  const isMatch = picomatch(globs, { dot: true, nocase });
  return (path) => isMatch(path);
}

function compileTest(pattern: ExclusionPattern): (path: string) => boolean {
  switch (pattern.match) {
    case "regex": {
      const re = new RegExp(pattern.pattern, pattern.ignoreCase ? "i" : "");
      return (path) => re.test(path);
    }
    case "glob":
      return compileGlob(pattern.pattern, pattern.ignoreCase);
  }
}

/** How an exclusion is described: by its pattern, never its note, so
 *  rewording a note changes no plan or manifest. */
export function describePattern(pattern: ExclusionPattern): string {
  return `pattern ${pattern.pattern}`;
}

/** The pattern as an excluded entry records it: its id and its text. */
export function excludedBy(pattern: ExclusionPattern): ExcludedBy {
  return pattern.id === undefined ? { pattern: pattern.pattern } : { id: pattern.id, pattern: pattern.pattern };
}

function applies(target: CompiledRule["target"], isDir: boolean): boolean {
  if (target === "both") return true;
  return isDir ? target === "dir" : target === "file";
}

/** Which entry kinds a pattern excludes: a glob ending in `/` names folders. */
function targetOf(pattern: ExclusionPattern): CompiledRule["target"] {
  return pattern.match === "glob" && pattern.pattern.endsWith("/") ? "dir" : pattern.target;
}

/** The ordered matcher for a list of exclusion patterns. */
export function buildMatcher(patterns: readonly ExclusionPattern[]): FilterMatcher {
  const compiled: CompiledRule[] = patterns.map((pattern) => ({
    target: targetOf(pattern),
    test: compileTest(pattern),
    pattern,
    describe: describePattern(pattern),
    excludedBy: excludedBy(pattern),
  }));
  return {
    match(path, isDir) {
      for (const rule of compiled) {
        if (!applies(rule.target, isDir)) continue;
        if (rule.test(path)) return rule;
      }
      return null;
    },
  };
}

/** The exclusion matcher of a resolved archive policy. The scan walk and the
 *  plan filter pass both go through here, so they can never build the matcher
 *  from divergent arguments. */
export function matcherFor(policy: ArchivePolicy): FilterMatcher {
  return buildMatcher(policy.exclusions);
}
