/**
 * The rule registry and severity contract. Severity decides blocking and
 * nothing else: an `error` blocks the write, a `warning` and an `info` never
 * do. There is no separate strict gating — a caller who wants an issue to block
 * sets that issue's severity to `error` (for the configurable name rules, via
 * the `names` policy; see `plan/nameFix.ts`).
 *
 * Most rules have a fixed severity, stamped here. The name rules are the
 * exception: their severity is chosen per run from the policy action, so
 * `finding()` is called with an explicit `severity` for them. The registry
 * entry is then only a default; the call site is authoritative.
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
  | "linux.junk"
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
  /** The rule's severity, which alone decides blocking (`error` blocks). For
   *  the configurable name rules this is a default the call site overrides. */
  severity: Severity;
  /** Human-readable default disposition. */
  disposition: string;
}

export const RULE_REGISTRY: Record<RuleId, RuleSpec> = {
  "path.absolute": { severity: "warning", disposition: "strip prefix" },
  "path.traversal": { severity: "error", disposition: "abort" },
  "path.too-long": { severity: "warning", disposition: "keep" },
  "macos.junk": { severity: "info", disposition: "exclude" },
  "windows.junk": { severity: "info", disposition: "exclude" },
  "linux.junk": { severity: "info", disposition: "exclude" },
  "entry.symlink": { severity: "warning", disposition: "exclude" },
  // The name rules' severity is set per run from the `names` policy action
  // (fix → info, warn → warning, error → error); these defaults are only used
  // if a call site forgets to pass one.
  "name.nfd": { severity: "info", disposition: "normalize to NFC" },
  "name.invalid-char": { severity: "info", disposition: "substitute" },
  "name.control-char": { severity: "info", disposition: "strip" },
  "name.trailing-dot-space": { severity: "info", disposition: "trim" },
  "name.reserved": { severity: "info", disposition: "suffix" },
  "name.suspicious": { severity: "warning", disposition: "keep" },
  "entry.duplicate": { severity: "info", disposition: "deduplicate" },
  "collision.case": { severity: "error", disposition: "abort" },
  "collision.post-fix": { severity: "error", disposition: "abort" },
  "time.pre-1980": { severity: "warning", disposition: "clamp" },
  "time.post-2107": { severity: "warning", disposition: "clamp" },
  "compat.zip64": { severity: "warning", disposition: "use Zip64" },
  "compat.zip64-required": { severity: "error", disposition: "abort" },
};

/** The rule ids in pipeline order. */
export const RULE_ORDER = Object.keys(RULE_REGISTRY) as RuleId[];

/** True if the rule is known to the registry. */
export function isKnownRule(rule: string): rule is RuleId {
  return Object.prototype.hasOwnProperty.call(RULE_REGISTRY, rule);
}

/**
 * Construct a finding — the single sanctioned way, so every finding carries a
 * tier. It takes either form:
 *
 * - a registry `RuleId`, whose severity defaults to the registry tier (a caller
 *   passes an explicit `severity` only for the configurable name rules, whose
 *   tier is chosen per run from the policy action); or
 * - an arbitrary `rule` string with an explicit `severity`, which is how an
 *   operational fault rides as a finding (its fault code in `rule`,
 *   `severity:"error"`, the OS cause folded into `message`) and how the extract
 *   pass records its CRC/SHA/path findings.
 */
export function finding(
  rule: RuleId,
  path: string,
  message: string,
  opts?: { fix?: Finding["fix"]; severity?: Severity },
): Finding;
export function finding(
  rule: string,
  path: string,
  message: string,
  opts: { fix?: Finding["fix"]; severity: Severity },
): Finding;
export function finding(
  rule: string,
  path: string,
  message: string,
  opts?: { fix?: Finding["fix"]; severity?: Severity },
): Finding {
  const severity =
    opts?.severity ?? (isKnownRule(rule) ? RULE_REGISTRY[rule].severity : "error");
  const f: Finding = { rule, severity, path, message };
  if (opts?.fix) f.fix = opts.fix;
  return f;
}
