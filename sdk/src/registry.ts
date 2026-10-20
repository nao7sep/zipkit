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
 * fixing, deduplication, collision detection, and timestamp resolution, then
 * verification's rules.
 */

import type { Finding, FindingRule, RuleId, Severity, VerifyRuleId } from "./types.ts";

export type { RuleId };

export type { FindingRule, VerifyRuleId };

export interface RuleSpec {
  /** The rule's severity, which alone decides blocking (`error` blocks). For
   *  the configurable name rules this is a default the call site overrides. */
  severity: Severity;
  /** Human-readable default disposition. */
  disposition: string;
}

export const RULE_REGISTRY: Record<FindingRule, RuleSpec> = {
  "path.absolute": { severity: "warning", disposition: "strip prefix" },
  "path.traversal": { severity: "error", disposition: "abort" },
  "path.too-long": { severity: "warning", disposition: "keep" },
  "exclude.pattern": { severity: "info", disposition: "exclude" },
  // A link left out under `ignore`, or kept as a link under `preserve`, which
  // Windows extracts as a text file: a portability defect either way.
  "entry.symlink-ignored": { severity: "warning", disposition: "exclude" },
  "entry.symlink-preserved": { severity: "warning", disposition: "keep as link" },
  // A socket, FIFO or device, or under `follow` a link that leads nowhere
  // archivable: ZIP cannot store it, so it is left out and reported.
  "entry.unsupported": { severity: "info", disposition: "exclude" },
  // A folder below an input that could not be listed: it is archived without
  // its contents, which are therefore in neither the archive nor the manifest.
  "entry.unlisted": { severity: "warning", disposition: "keep without contents" },
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
  "output.exists": { severity: "error", disposition: "overwrite" },
  // Verification's findings: every one fails the verification.
  "verify.crc32-mismatch": { severity: "error", disposition: "fail" },
  "verify.unreadable": { severity: "error", disposition: "fail" },
  "verify.local-mismatch": { severity: "error", disposition: "fail" },
  "verify.sha256-mismatch": { severity: "error", disposition: "fail" },
  "verify.manifest-mismatch": { severity: "error", disposition: "fail" },
  "verify.missing": { severity: "error", disposition: "fail" },
  "verify.extra": { severity: "error", disposition: "fail" },
};

/**
 * Construct a finding — the single sanctioned way, so every finding carries a
 * tier: the registry's, or for the configurable name rules the `severity` the
 * call site chose per run from the policy action. Its id is its rule and the
 * path it is about, so the same finding on a fresh plan has the same id.
 */
export function finding(
  rule: FindingRule,
  path: string,
  message: string,
  opts?: { fix?: Finding["fix"]; severity?: Severity },
): Finding {
  const severity = opts?.severity ?? RULE_REGISTRY[rule].severity;
  const f: Finding = { id: `${rule}:${path}`, rule, severity, path, message };
  if (opts?.fix) f.fix = opts.fix;
  return f;
}
