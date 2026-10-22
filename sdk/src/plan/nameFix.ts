/**
 * Segment-level name fixing (pass 4). Each path segment is examined in a fixed
 * order — NFC normalization, invalid-character substitution, control-character
 * stripping, trailing dot/space trimming, reserved-name suffixing, and
 * suspicious-character flagging — and each class is governed by its own policy
 * action (`names.*`):
 *
 * - `fix`   repair the segment, record an `info` finding and a name fix;
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
 * findings and name fixes on that entry, because every parent segment is
 * the leaf of its own directory node. This keeps each defect reported once while
 * every entry's full path is corrected consistently.
 */

import { finding } from "../registry.ts";
import type { RuleId } from "../registry.ts";
import type { NameFix } from "../internal/types.ts";
import type { ArchivePolicy, NameAction, NameRules, Severity } from "../types.ts";
import type { WorkItem } from "./workItem.ts";

const INVALID_CHARS = /[<>:"|?*\\]/g;
const INVALID_RUN = /([<>:"|?*\\]+)/;

// The full-width look-alike of each character Windows forbids in names.
const FULLWIDTH: Record<string, string> = {
  "<": "\uff1c", ">": "\uff1e", ":": "\uff1a", '"': "\uff02",
  "|": "\uff5c", "?": "\uff1f", "*": "\uff0a", "\\": "\uff3c",
};

/** One part of a name (its stem or its extension) with each run of invalid
 *  characters dropped where a separator would only clutter it — at either end,
 *  or beside white space of any kind (a full-width space included) — and any
 *  other run replaced by `inner`. A dropped run that leaves white space doubled
 *  or dangling has it tidied; nothing else in the name is touched, so an
 *  underscore or a space the name already had stays as it was. */
function tidyPart(part: string, inner: string): string {
  const pieces = part.split(INVALID_RUN);
  if (pieces.length === 1) return part;
  let out = pieces[0]!;
  for (let i = 1; i < pieces.length; i += 2) {
    let after = pieces[i + 1]!;
    const atStart = out === "";
    const atEnd = after === "" && i === pieces.length - 2;
    if (atStart) {
      after = after.replace(/^\s+/u, "");
    } else if (atEnd) {
      out = out.replace(/\s+$/u, "");
    } else if (/\s$/u.test(out) || /^\s/u.test(after)) {
      if (/\s$/u.test(out) && /^\s/u.test(after)) out = out.slice(0, -1);
    } else {
      out += inner;
    }
    out += after;
  }
  return out;
}

/** A segment with the characters Windows forbids replaced in the given style. */
function fixInvalidChars(segment: string, names: NameRules): string {
  switch (names.invalidCharStyle) {
    case "replace":
      return segment.replace(INVALID_CHARS, names.invalidCharReplacement);
    case "fullwidth":
      return segment.replace(INVALID_CHARS, (ch) => FULLWIDTH[ch]!);
    case "tidy":
    case "remove": {
      // The stem and the extension are tidied apart, so a run just before the
      // extension counts as the end of the name.
      const inner = names.invalidCharStyle === "tidy" ? names.invalidCharReplacement : "";
      const dot = segment.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [segment.slice(0, dot), segment.slice(dot)] : [segment, ""];
      const fixedStem = tidyPart(stem, inner);
      // A stem made only of invalid characters keeps one replacement rather
      // than turning the name into a hidden dot file.
      let fixed = (fixedStem === "" && stem !== "" ? names.invalidCharReplacement : fixedStem) + tidyPart(ext, inner);
      // Nor may dropping a leading run uncover a dot the name did not start
      // with ("?..txt" is not "..txt").
      if (fixed.startsWith(".") && !segment.startsWith(".")) fixed = names.invalidCharReplacement + fixed;
      return fixed;
    }
  }
}
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

// Windows device names, matched against the upper-cased stem: CON, PRN, AUX,
// NUL, COM and LPT with a digit 0-9 or a superscript 1-3 (U+00B9, U+00B2,
// U+00B3), and the console names CONIN$ and CONOUT$.
const PORT_SUFFIXES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "\u00b9", "\u00b2", "\u00b3"];
const RESERVED = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...PORT_SUFFIXES.map((d) => `COM${d}`),
  ...PORT_SUFFIXES.map((d) => `LPT${d}`),
]);

/** A name issue detected on a segment: its rule, the tier the action assigned,
 *  and whether the fix was actually applied (only `fix` applies). */
export interface SegmentIssue {
  rule: RuleId;
  severity: Severity;
  applied: boolean;
}

export interface SegmentFix {
  segment: string;
  issues: SegmentIssue[];
  nameFixes: NameFix[];
}

/** The all-`fix` action set (minus the replacement) used by `fullFixSegment`. */
const ALL_FIX: Omit<NameRules, "invalidCharReplacement"> = {
  nfc: "fix",
  invalidChars: "fix",
  invalidCharStyle: "replace",
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
  // Windows drops spaces at the end of the stem when it parses a device
  // name, so `CON .txt` names the device as `CON.txt` does.
  const stem = (dot === -1 ? segment : segment.slice(0, dot)).replace(/ +$/, "");
  return RESERVED.has(stem.toUpperCase());
}

function suffixReserved(segment: string): string {
  const dot = segment.indexOf(".");
  if (dot === -1) return `${segment}_`;
  return `${segment.slice(0, dot)}_${segment.slice(dot)}`;
}

export function processSegment(segment: string, names: NameRules): SegmentFix {
  const issues: SegmentIssue[] = [];
  const nameFixes: NameFix[] = [];
  let s = segment;

  // Detect one class: if `after` differs, the class is present. The action then
  // decides whether to apply the fix and at what tier to report it.
  const step = (rule: RuleId, action: NameAction, after: string): void => {
    if (after === s) return;
    if (action === "fix") {
      nameFixes.push({ rule, before: s, after });
      issues.push({ rule, severity: "info", applied: true });
      s = after;
    } else if (action === "warn") {
      issues.push({ rule, severity: "warning", applied: false });
    } else if (action === "error") {
      issues.push({ rule, severity: "error", applied: false });
    }
  };

  step("name.nfd", names.nfc, s.normalize("NFC"));
  step("name.invalid-char", names.invalidChars, fixInvalidChars(s, names));
  step("name.control-char", names.controlChars, stripControlChars(s));
  step("name.trailing-dot-space", names.trailingDotSpace, s.replace(TRAILING_DOT_SPACE, ""));
  if (isReservedStem(s)) step("name.reserved", names.reserved, suffixReserved(s));

  // A fix can empty a segment (all control characters, only trailing dots); an
  // empty path component is invalid, so fall back to the replacement. Only an
  // applied fix can reach here, so this never silently alters a left-as-is name.
  if (s === "") s = names.invalidCharReplacement;
  // Nor may a fix leave only dots or white space: "." and ".." would point at
  // the folder itself or its parent, and Windows drops such a name to nothing.
  // A name that came in that way is the path pass's to judge, not changed here.
  if (nameFixes.length > 0 && /^[.\s]+$/u.test(s)) s = names.invalidCharReplacement;
  // The fix that led there owns the fallback, so the recorded fixes still lead
  // from the name found to the name written.
  const last = nameFixes.at(-1);
  if (last && last.after !== s) last.after = s;

  if (hasSuspicious(s)) {
    if (names.suspicious === "warn") {
      issues.push({ rule: "name.suspicious", severity: "warning", applied: false });
    } else if (names.suspicious === "error") {
      issues.push({ rule: "name.suspicious", severity: "error", applied: false });
    }
  }

  return { segment: s, issues, nameFixes };
}

/**
 * The segment after every fix is applied unconditionally — the standard the
 * validation boundary holds a manifest name or replacement character to. Equal
 * to the input exactly when the name needs no repair.
 */
export function fullFixSegment(segment: string, replacement: string): string {
  return processSegment(segment, { ...ALL_FIX, invalidCharReplacement: replacement }).segment;
}

export function nameMessage(rule: RuleId, applied: boolean): string {
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
      for (const nameFix of fix.nameFixes) {
        item.nameFixes.push(nameFix);
      }
      for (const issue of fix.issues) {
        const opts: { severity: Severity; fix?: { kind: "rename"; to: string } } = {
          severity: issue.severity,
        };
        // A repaired name carries the rename target; a left-as-is name does not.
        if (issue.applied) opts.fix = { kind: "rename", to: item.archivePath };
        item.findings.push(
          finding(issue.rule, item.originalPath, nameMessage(issue.rule, issue.applied), opts),
        );
      }
    }
  }
}
