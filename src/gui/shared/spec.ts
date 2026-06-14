/**
 * The options → ArchiveSpec mapping: the GUI's format-coercion edge, mirroring
 * what the CLI's flag layer does. It turns the visible option state into a typed
 * spec; the SDK still owns all validation and every default not set here. Pure
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
  /** Explicit output path (empty = infer beside the input). */
  output: string;
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
  output: "",
  overwrite: false,
};

/** Build the `ArchiveSpec` for the given inputs and option state. Only the fields
 *  the UI controls are set; the SDK fills the rest from its defaults. */
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
  const output = o.output.trim();
  if (output !== "") spec.output = output;
  if (o.overwrite) spec.overwrite = true;
  if (o.comment.trim() !== "") spec.comment = o.comment;
  return spec;
}
