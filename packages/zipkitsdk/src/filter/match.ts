/**
 * The exclusion engine, shared by every verb. User exclude rules and (for
 * archiving) the junk preset form one ordered list; the first rule that matches
 * a path excludes it, and the matched rule is returned so the caller can report
 * *why*. The system is inclusive by default: a path with no matching rule is
 * kept. There is no "include" — what goes in is chosen by the inputs, and what
 * comes out by `dest`; rules only ever subtract.
 *
 * The matcher is pure. On the archive side the scan layer uses it to prune
 * excluded directory subtrees during the walk and the plan layer to decide each
 * surviving entry; on the read side `extract` uses it to decide which entries
 * are written. One engine, every caller.
 *
 * Pattern dialects follow gitignore conventions: a glob without a leading slash
 * is unanchored and matches at any depth; a leading slash (or any interior
 * slash) anchors to the root; `**` spans segments; a regex matches anywhere
 * unless anchored with `^`/`$`; literal is a plain path comparison. The
 * trailing-slash directory convention is expressed through each rule's `target`,
 * set by the caller, not re-derived here. User exclude rules match
 * case-sensitively; the junk preset matches case-insensitively.
 */

import picomatch from "picomatch";
import type { JunkRule } from "./junk.js";
import { JUNK_RULES } from "./junk.js";
import type { RuleId } from "../registry.js";
import type { ArchivePolicy, FilterRule } from "../types.js";

export interface CompiledRule {
  target: "file" | "dir" | "both";
  test: (path: string) => boolean;
  /** Registry rule id when this rule came from the junk preset. */
  junkRule?: Extract<RuleId, "macos.junk" | "windows.junk" | "linux.junk">;
  /** Human-readable description for an entry's `excludeReason`. */
  describe: string;
}

export interface FilterMatcher {
  /** The first exclude rule that applies to the path, or null when none match. */
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
  // prefix; `dot: true` lets dotfile junk (`.DS_Store`) match.
  const globs = anchored ? [body] : [body, `**/${body}`];
  const isMatch = picomatch(globs, { dot: true, nocase });
  return (path) => isMatch(path);
}

function compileLiteral(pattern: string, nocase: boolean): (path: string) => boolean {
  let body = stripTrailingSlash(pattern);
  const anchored = isAnchored(body);
  if (body.startsWith("/")) body = body.slice(1);
  if (nocase) {
    const want = body.toLowerCase();
    if (anchored) return (path) => path.toLowerCase() === want;
    return (path) => {
      const p = path.toLowerCase();
      return p === want || p.endsWith(`/${want}`);
    };
  }
  if (anchored) return (path) => path === body;
  return (path) => path === body || path.endsWith(`/${body}`);
}

function compileTest(rule: FilterRule, nocase: boolean): (path: string) => boolean {
  switch (rule.match) {
    case "regex": {
      const re = new RegExp(rule.pattern, nocase ? "i" : "");
      return (path) => re.test(path);
    }
    case "literal":
      return compileLiteral(rule.pattern, nocase);
    case "glob":
      return compileGlob(rule.pattern, nocase);
  }
}

// User exclude rules are case-sensitive (gitignore convention); the junk preset
// is case-insensitive, because OS-generated names (`Thumbs.db`, `.DS_Store`)
// vary in case across filesystems and none is ever a real file worth keeping.
function compileUserRule(rule: FilterRule): CompiledRule {
  return {
    target: rule.target,
    test: compileTest(rule, false),
    describe: `exclude rule: ${rule.pattern}`,
  };
}

function compileJunkRule(entry: JunkRule): CompiledRule {
  return {
    target: entry.rule.target,
    test: compileTest(entry.rule, true),
    junkRule: entry.id,
    describe: `junk: ${entry.rule.pattern}`,
  };
}

function applies(target: CompiledRule["target"], isDir: boolean): boolean {
  if (target === "both") return true;
  return isDir ? target === "dir" : target === "file";
}

/**
 * Build the ordered matcher: user exclude rules first, then the junk preset when
 * requested. Verb-agnostic — `create` passes its policy's filters and junk
 * setting, `extract` passes its exclude rules with no junk.
 */
export function buildMatcher(rules: FilterRule[], includeJunk: boolean): FilterMatcher {
  const compiled: CompiledRule[] = rules.map(compileUserRule);
  if (includeJunk) {
    for (const entry of JUNK_RULES) compiled.push(compileJunkRule(entry));
  }
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

/**
 * Derive the exclusion matcher from a resolved archive policy — the single place
 * the junk toggle (`junk === "builtin"`) is read. The scan walk and the plan
 * filter pass both go through here, so they can never build the matcher from
 * divergent arguments.
 */
export function matcherFor(policy: ArchivePolicy): FilterMatcher {
  return buildMatcher(policy.filters, policy.junk === "builtin");
}
