/**
 * The options → ArchiveSpec mapping: the GUI's format-coercion edge. It turns
 * the visible option state into a typed spec; the SDK still owns all validation
 * and every default not set here. Pure
 * (no Electron, no Node, no SDK runtime), so it is unit-tested directly.
 */

import type { ArchivePolicy, ArchiveSpec, DeepPartial, NameAction } from "../../sdk/types.js";

/** The visible option state for one job. Defaults mirror the SDK's own defaults. */
export interface GuiOptions {
  /** Built-in OS-junk preset on. */
  junk: boolean;
  /** Make every name-portability issue block (error) instead of being auto-fixed. */
  strict: boolean;
  /** Deflate level 1–9. */
  level: number;
  symlinks: "ignore" | "preserve" | "follow";
  emptyDirs: "keep" | "prune";
  /** Embed the `_metadata.json` manifest. */
  metadata: boolean;
  /** Record a per-file SHA-256 in the manifest. */
  hash: boolean;
  /** Archive comment (empty = none). */
  comment: string;
  /** Output directory the archive is written into ("" = beside the input). */
  outputDir: string;
  /** Explicit zip file name ("" = automatic, from the input). */
  fileName: string;
  /** Overwrite an existing output. */
  overwrite: boolean;
}

export const DEFAULT_OPTIONS: GuiOptions = {
  junk: true,
  strict: false,
  level: 6,
  symlinks: "ignore",
  emptyDirs: "keep",
  metadata: true,
  hash: true,
  comment: "",
  outputDir: "",
  fileName: "",
  overwrite: false,
};

/** Build the `ArchiveSpec` for the given inputs and option state. Only the fields
 *  the UI controls are set; the SDK fills the rest from its defaults. The output
 *  path is NOT set here — it is composed from `outputDir`/`fileName` in the main
 *  process (`resolveOutputPath`), which needs the host path/home logic the
 *  Node-free shared layer cannot import. */
export function buildSpec(inputs: string[], o: GuiOptions): ArchiveSpec {
  const policy: DeepPartial<ArchivePolicy> = {
    junk: o.junk ? "builtin" : "none",
    symlinks: o.symlinks,
    emptyDirs: o.emptyDirs,
    compression: { level: o.level },
    metadata: o.metadata ? { hash: o.hash } : false,
  };
  if (o.strict) {
    const e: NameAction = "error";
    policy.names = {
      nfc: e,
      invalidChars: e,
      controlChars: e,
      trailingDotSpace: e,
      reserved: e,
      suspicious: "error",
    };
  }

  const spec: ArchiveSpec = { inputs, policy };
  if (o.overwrite) spec.overwrite = true;
  if (o.comment.trim() !== "") spec.comment = o.comment;
  return spec;
}

/**
 * The option fields that change a *dry run's* result — which entries are scanned,
 * the portability findings, the resolved output path, and the writable/overwrite
 * gate. Compression `level`, the archive `comment`, and the manifest `hash` are
 * write-time only: they never alter the plan, so editing them must NOT re-plan
 * (re-planning just to re-emit an identical report is the redundant dry run we
 * avoid). Keep this list in step with what {@link buildSpec} and the output
 * composition actually feed the plan.
 */
const PLAN_AFFECTING: (keyof GuiOptions)[] = [
  "junk",
  "strict",
  "symlinks",
  "emptyDirs",
  "metadata",
  "outputDir",
  "fileName",
  "overwrite",
];

/** Whether two option states differ in a way that requires a fresh dry run. */
export function planAffectingChanged(a: GuiOptions, b: GuiOptions): boolean {
  return PLAN_AFFECTING.some((k) => a[k] !== b[k]);
}
