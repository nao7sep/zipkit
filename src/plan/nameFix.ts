/**
 * Segment-level name fixing (§4 pass 4, §10.2). Each path segment is repaired
 * in a fixed order: NFC normalization, invalid-character substitution,
 * control-character stripping, trailing dot/space trimming, reserved-name
 * suffixing, and suspicious-character flagging (kept). The order is the §9.2
 * registry order; `name.invalid-char` substitutes the Windows-illegal set while
 * `name.control-char` strips, per the registry's distinct dispositions.
 *
 * `fixSegment` is pure and exported for direct table testing. A fix is
 * attributed to the node whose leaf segment it is: when an entry's path is
 * repaired, only the leaf segment produces findings and transformations on
 * that entry, because every parent segment is the leaf of its own directory
 * node. This keeps each defect reported once while every entry's full path is
 * corrected consistently.
 */

import { finding } from "../registry.js";
import type { RuleId } from "../registry.js";
import type { Transformation } from "../internal/types.js";
import type { ArchivePolicy } from "../types.js";
import type { WorkItem } from "./workItem.js";

const INVALID_CHARS = /[<>:"|?*\\]/g;
const TRAILING_DOT_SPACE = /[ .]+$/;

// Zero-width, BOM/ZWNBSP, bidirectional overrides, and directional isolates:
// flagged as suspicious but kept (§10.2).
const SUSPICIOUS_CODES = new Set<number>([
  0x200b, 0x200c, 0x200d, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
  0x2069,
]);

const RESERVED = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export interface SegmentFix {
  segment: string;
  rules: RuleId[];
  transformations: Transformation[];
}

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

export function fixSegment(segment: string, replacement: string): SegmentFix {
  const rules: RuleId[] = [];
  const transformations: Transformation[] = [];
  let s = segment;

  const step = (rule: RuleId, after: string): void => {
    if (after === s) return;
    transformations.push({ rule, before: s, after });
    rules.push(rule);
    s = after;
  };

  step("name.nfd", s.normalize("NFC"));
  step("name.invalid-char", s.replace(INVALID_CHARS, replacement));
  step("name.control-char", stripControlChars(s));
  step("name.trailing-dot-space", s.replace(TRAILING_DOT_SPACE, ""));
  if (isReservedStem(s)) step("name.reserved", suffixReserved(s));

  // The fixes can empty a segment (all control characters, only trailing dots);
  // an empty path component is invalid, so fall back to the replacement.
  if (s === "") {
    s = replacement;
  }

  if (hasSuspicious(s)) {
    rules.push("name.suspicious");
  }

  return { segment: s, rules, transformations };
}

function messageFor(rule: RuleId): string {
  switch (rule) {
    case "name.nfd":
      return "name normalized from NFD to NFC";
    case "name.invalid-char":
      return "invalid characters substituted";
    case "name.control-char":
      return "control characters stripped";
    case "name.trailing-dot-space":
      return "trailing dots or spaces trimmed";
    case "name.reserved":
      return "reserved device name suffixed";
    case "name.suspicious":
      return "zero-width or bidirectional-override characters present (kept)";
    default:
      return "name fixed";
  }
}

export function applyNameFix(items: WorkItem[], policy: ArchivePolicy): void {
  const replacement = policy.invalidCharReplacement;

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

    const fixes = segments.map((segment) => fixSegment(segment, replacement));
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
      for (const rule of fix.rules) {
        const fixField =
          rule === "name.suspicious" ? undefined : { kind: "rename" as const, to: item.archivePath };
        item.findings.push(finding(rule, item.originalPath, messageFor(rule), fixField));
      }
    }
  }
}
