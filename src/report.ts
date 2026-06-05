/**
 * The frozen output contract: the universal report envelope and the stderr
 * event records. The envelope is thin and verb-agnostic — a generic reader does
 * `read stdout → parse → switch (verb)` without knowing any payload shape. The
 * per-verb `data` payloads (CreateData, ExtractData) live in `types.ts` with the
 * rest of the public surface; this module owns the wrapper, the stderr records,
 * and the small builders that stamp `schemaVersion`, derive `ok`, and turn an
 * operational fault into an error-tier finding.
 *
 * The boundary is deliberate (see the output contract, decision D1): the SDK
 * stays idiomatic — it returns the `data` payloads on success and throws on
 * operational faults — and the CLI is the one that wraps a payload in this
 * envelope and folds a thrown fault into `findings`.
 */

import { VERSION } from "./version.js";
import type { Finding } from "./types.js";

/** The frozen contract version. Integer, the first key of every envelope and
 *  every stderr record; bumped only on a breaking change (output contract §9). */
export const SCHEMA_VERSION = 1;

/**
 * The universal report envelope. Every verb, every mode, every outcome emits
 * exactly one of these to stdout. `ok` is derived — it says the verb executed
 * without an error-tier finding, *not* the verb's domain verdict (exit codes key
 * off the per-verb verdict, not `ok` alone).
 */
export interface Report<Verb extends string, Data extends { findings: Finding[] }> {
  schemaVersion: number; // 1; first key
  tool: "zipkit"; // origin — a nested SDK/CLI's report is identifiable
  toolVersion: string; // the zipkit version that produced it
  verb: Verb;
  ok: boolean; // DERIVED: data.findings has no severity === "error"
  data: Data;
}

/** True when no finding is at the error tier. */
export function isOk(findings: Finding[]): boolean {
  return findings.every((f) => f.severity !== "error");
}

/** Wrap a verb's data payload in the envelope, stamping the version and origin
 *  and deriving `ok` from the payload's findings. */
export function buildReport<Verb extends string, Data extends { findings: Finding[] }>(
  verb: Verb,
  data: Data,
): Report<Verb, Data> {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: "zipkit",
    toolVersion: VERSION,
    verb,
    ok: isOk(data.findings),
    data,
  };
}

// ---------------------------------------------------------------------------
// stderr event records (frozen)
// ---------------------------------------------------------------------------

/** A live progress chunk on stderr under `--json`, minified and prefixed
 *  `zipkit[progress]:`. The event set is additive; fields are all optional. */
export interface ProgressEvent {
  schemaVersion: number;
  event:
    | "scan.done"
    | "plan.done"
    | "write.done"
    | "extract.done"
    | "entry.written"
    | "entry.excluded"
    | "entry.renamed";
  entries?: number;
  included?: number;
  excluded?: number;
  bytes?: number;
  path?: string;
  rule?: string;
}

/** A live fault chunk on stderr under `--json`, minified and prefixed
 *  `zipkit[error]:`. The same fault also lands as a finding in the final
 *  stdout report — belt and suspenders, by design. */
export interface ErrorEvent {
  schemaVersion: number;
  code: string; // the fault code, e.g. "write.read-failed"
  message: string; // single-line, OS detail folded in
  path?: string;
}
