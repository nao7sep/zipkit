/**
 * Segment-level name fixing (pass 4). Each path segment is examined in a fixed
 * order — NFC normalization, invalid-character substitution, control-character
 * stripping, trailing dot/space trimming, reserved-name suffixing, and
 * suspicious-character flagging — and each class is governed by its own policy
 * action (`names.*`):
 *
 * - `fix`   repair the segment, record an `info` finding and a transformation;
 * - `warn`  leave it, record a `warning` finding;
 * - `error` leave it, record an `error` finding (which fails the run);
 * - `none`  leave it, record nothing.
 *
 * `name.suspicious` characters are kept by design, so that class has no `fix`
 * action — only `warn`/`error`/`none`, all detection.
 *
 * `processSegment` is pure and exported for direct table testing;
 * `fullFixSegment` applies every fix unconditionally and is what the validation
 * boundary holds names to. A fix is attributed to the node whose leaf segment
 * it is: when an entry's path is repaired, only the leaf segment produces
 * findings and transformations on that entry, because every parent segment is
 * the leaf of its own directory node. This keeps each defect reported once while
 * every entry's full path is corrected consistently.
 */

import { finding } from "../registry.js";
import type { RuleId } from "../registry.js";
import type { Transformation } from "../internal/types.js";
import type { ArchivePolicy, NameAction, NameRules, Severity } from "../types.js";
import type { WorkItem } from "./workItem.js";

const INVALID_CHARS = /[<>:"|?*\\]/g;
const TRAILING_DOT_SPACE = /[ .]+$/;

// Invisible and bidirectional-control characters with no legitimate use in a
// filename: zero-width space, word joiner, BOM/ZWNBSP, the bidi embeddings and
// overrides, and the directional isolates. Flagged as suspicious but kept.
// ZWNJ (U+200C) and ZWJ (U+200D) are deliberately excluded: they are essential
// in Persian/Indic scripts and emoji sequences respectively, so flagging them
// would warn on legitimate names.
const SUSPICIOUS_CODES = new Set<number>([
  0x200b, 0x2060, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

const RESERVED = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** A name issue detected on a segment: its rule, the tier the action assigned,
 *  and whether the fix was actually applied (only `fix` applies). */
interface SegmentIssue {
  rule: RuleId;
  severity: Severity;
  applied: boolean;
}

export interface SegmentFix {
  segment: string;
  issues: SegmentIssue[];
  transformations: Transformation[];
}

/** The all-`fix` action set (minus the replacement) used by `fullFixSegment`. */
const ALL_FIX: Omit<NameRules, "invalidCharReplacement"> = {
  nfc: "fix",
  invalidChars: "fix",
  controlChars: "fix",
  trailingDotSpace: "fix",
  reserved: "fix",
  suspicious: "warn",
};

function stripControlChars(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch.charCodeAt(0) > 0x1f) out += ch;
  }
  return out;
}

function hasSuspicious(segment: string): boolean {
  for (const ch of segment) {
    if (SUSPICIOUS_CODES.has(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

function isReservedStem(segment: string): boolean {
  const dot = segment.indexOf(".");
  const stem = dot === -1 ? segment : segment.slice(0, dot);
  return RESERVED.has(stem.toUpperCase());
}

function suffixReserved(segment: string): string {
  const dot = segment.indexOf(".");
  if (dot === -1) return `${segment}_`;
  return `${segment.slice(0, dot)}_${segment.slice(dot)}`;
}

export function processSegment(segment: string, names: NameRules): SegmentFix {
  const issues: SegmentIssue[] = [];
  const transformations: Transformation[] = [];
  let s = segment;

  // Detect one class: if `after` differs, the class is present. The action then
  // decides whether to apply the fix and at what tier to report it.
  const step = (rule: RuleId, action: NameAction, after: string): void => {
    if (after === s) return;
    if (action === "fix") {
      transformations.push({ rule, before: s, after });
      issues.push({ rule, severity: "info", applied: true });
      s = after;
    } else if (action === "warn") {
      issues.push({ rule, severity: "warning", applied: false });
    } else if (action === "error") {
      issues.push({ rule, severity: "error", applied: false });
    }
  };

  step("name.nfd", names.nfc, s.normalize("NFC"));
  step("name.invalid-char", names.invalidChars, s.replace(INVALID_CHARS, names.invalidCharReplacement));
  step("name.control-char", names.controlChars, stripControlChars(s));
  step("name.trailing-dot-space", names.trailingDotSpace, s.replace(TRAILING_DOT_SPACE, ""));
  if (isReservedStem(s)) step("name.reserved", names.reserved, suffixReserved(s));

  // A fix can empty a segment (all control characters, only trailing dots); an
  // empty path component is invalid, so fall back to the replacement. Only an
  // applied fix can reach here, so this never silently alters a left-as-is name.
  if (s === "") s = names.invalidCharReplacement;

  if (hasSuspicious(s)) {
    if (names.suspicious === "warn") {
      issues.push({ rule: "name.suspicious", severity: "warning", applied: false });
    } else if (names.suspicious === "error") {
      issues.push({ rule: "name.suspicious", severity: "error", applied: false });
    }
  }

  return { segment: s, issues, transformations };
}

/**
 * The segment after every fix is applied unconditionally — the standard the
 * validation boundary holds a metadata name or replacement character to. Equal
 * to the input exactly when the name needs no repair.
 */
export function fullFixSegment(segment: string, replacement: string): string {
  return processSegment(segment, { ...ALL_FIX, invalidCharReplacement: replacement }).segment;
}

function messageFor(rule: RuleId, applied: boolean): string {
  switch (rule) {
    case "name.nfd":
      return applied ? "name normalized from NFD to NFC" : "name is not in NFC form";
    case "name.invalid-char":
      return applied ? "invalid characters substituted" : "name contains invalid characters";
    case "name.control-char":
      return applied ? "control characters stripped" : "name contains control characters";
    case "name.trailing-dot-space":
      return applied ? "trailing dots or spaces trimmed" : "name has trailing dots or spaces";
    case "name.reserved":
      return applied ? "reserved device name suffixed" : "name is a reserved device name";
    case "name.suspicious":
      return "zero-width or bidirectional-override characters present (kept)";
    default:
      return "name fixed";
  }
}

export function applyNameFix(items: WorkItem[], policy: ArchivePolicy): void {
  const names = policy.names;

  // Pre-fix paths of the directory work items that will report their own leaf
  // segment. A non-leaf segment owned by such a directory is fixed silently on
  // each child (so the full path stays consistent) but reported only by the
  // directory; a segment with no owning directory node — e.g. one introduced
  // by a multi-segment `as` anchor — is reported by the entry itself.
  const directoryPaths = new Set<string>();
  for (const item of items) {
    if (!item.excluded && item.type === "dir") directoryPaths.add(item.archivePath);
  }

  for (const item of items) {
    if (item.excluded) continue;
    const segments = item.archivePath.split("/").filter((s) => s !== "");
    if (segments.length === 0) continue;

    const fixes = segments.map((segment) => processSegment(segment, names));
    item.archivePath = fixes.map((f) => f.segment).join("/");

    for (let i = 0; i < fixes.length; i++) {
      const isLeaf = i === fixes.length - 1;
      if (!isLeaf && directoryPaths.has(segments.slice(0, i + 1).join("/"))) {
        continue; // a directory work item reports this segment
      }
      const fix = fixes[i];
      if (!fix) continue;
      for (const transformation of fix.transformations) {
        item.transformations.push(transformation);
      }
      for (const issue of fix.issues) {
        const opts: { severity: Severity; fix?: { kind: "rename"; to: string } } = {
          severity: issue.severity,
        };
        // A repaired name carries the rename target; a left-as-is name does not.
        if (issue.applied) opts.fix = { kind: "rename", to: item.archivePath };
        item.findings.push(
          finding(issue.rule, item.originalPath, messageFor(issue.rule, issue.applied), opts),
        );
      }
    }
  }
}
