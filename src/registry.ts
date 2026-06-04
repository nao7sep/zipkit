/**
 * The rule registry and severity contract. Severity lives in exactly one
 * place. Rules never write a tier inline; they call {@link finding}, which
 * stamps the severity from this table. The coupling is exact: an `error` is the
 * tier that blocks unconditionally, a `warning` blocks only under strict
 * gating, and `info` never blocks. Changing a tier changes observable blocking
 * behaviour and is a breaking change to strict-gating semantics.
 *
 * The table is in pipeline order: path rooting, content selection, name
 * fixing, deduplication, collision detection, timestamp resolution, and
 * container feasibility.
 */

import type { Finding, Severity } from "./types.js";

export type RuleId =
  | "path.absolute"
  | "path.traversal"
  | "path.too-long"
  | "macos.junk"
  | "windows.junk"
  | "entry.symlink"
  | "name.nfd"
  | "name.invalid-char"
  | "name.control-char"
  | "name.trailing-dot-space"
  | "name.reserved"
  | "name.suspicious"
  | "entry.duplicate"
  | "collision.case"
  | "collision.post-fix"
  | "time.pre-1980"
  | "time.post-2107"
  | "compat.zip64"
  | "compat.zip64-required";

export interface RuleSpec {
  severity: Severity;
  /** Blocks the write with no strict gating (true exactly for `error`). */
  blocksNormally: boolean;
  /** Blocks the write under `--strict` (true for `error` and `warning`). */
  blocksUnderStrict: boolean;
  /** Human-readable default disposition. */
  disposition: string;
}

export const RULE_REGISTRY: Record<RuleId, RuleSpec> = {
  "path.absolute": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "strip prefix" },
  "path.traversal": { severity: "error", blocksNormally: true, blocksUnderStrict: true, disposition: "abort" },
  "path.too-long": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "keep" },
  "macos.junk": { severity: "info", blocksNormally: false, blocksUnderStrict: false, disposition: "exclude" },
  "windows.junk": { severity: "info", blocksNormally: false, blocksUnderStrict: false, disposition: "exclude" },
  "entry.symlink": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "exclude" },
  "name.nfd": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "normalize to NFC" },
  "name.invalid-char": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "substitute" },
  "name.control-char": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "strip" },
  "name.trailing-dot-space": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "trim" },
  "name.reserved": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "suffix" },
  "name.suspicious": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "keep" },
  "entry.duplicate": { severity: "info", blocksNormally: false, blocksUnderStrict: false, disposition: "deduplicate" },
  "collision.case": { severity: "error", blocksNormally: true, blocksUnderStrict: true, disposition: "abort" },
  "collision.post-fix": { severity: "error", blocksNormally: true, blocksUnderStrict: true, disposition: "abort" },
  "time.pre-1980": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "clamp" },
  "time.post-2107": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "clamp" },
  "compat.zip64": { severity: "warning", blocksNormally: false, blocksUnderStrict: true, disposition: "use Zip64" },
  "compat.zip64-required": { severity: "error", blocksNormally: true, blocksUnderStrict: true, disposition: "abort" },
};

/** The rule ids in pipeline order. */
export const RULE_ORDER = Object.keys(RULE_REGISTRY) as RuleId[];

/** True if the rule is known to the registry. */
export function isKnownRule(rule: string): rule is RuleId {
  return Object.prototype.hasOwnProperty.call(RULE_REGISTRY, rule);
}

/**
 * Construct a finding, stamping its severity from the registry. This is the
 * only sanctioned way to create a finding, so the invariant — every
 * finding's severity equals its registry tier — holds by construction.
 */
export function finding(
  rule: RuleId,
  path: string,
  message: string,
  fix?: Finding["fix"],
): Finding {
  const f: Finding = {
    rule,
    severity: RULE_REGISTRY[rule].severity,
    path,
    message,
  };
  if (fix) f.fix = fix;
  return f;
}

/** Whether a finding of this rule blocks the write under the given gating. */
export function ruleBlocks(rule: RuleId, strict: boolean): boolean {
  const spec = RULE_REGISTRY[rule];
  return strict ? spec.blocksUnderStrict : spec.blocksNormally;
}
