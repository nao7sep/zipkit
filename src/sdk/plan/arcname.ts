/**
 * Arcname resolution (pass 1). Given an input's anchor and the
 * shape of the run, compute the archive-path prefix under which the input's
 * contents land, then join it with each entry's path relative to that input.
 *
 * The functions are pure string logic (node:path is pure). The scan edge calls
 * them after a stat tells it whether each input is a directory, so a single
 * source of arcname truth serves both the walk (pruning, labelling) and the
 * plan.
 */

import path from "node:path";
import { PolicyError } from "../errors.js";
import { toForwardSlash, trimSlashes } from "../internal/path.js";
import type { ArchiveInput } from "../types.js";

export interface ResolvedInput {
  path: string; // absolute
}

export function normalizeInputs(inputs: ArchiveInput[], cwd: string): ResolvedInput[] {
  return inputs.map((input) => ({ path: path.resolve(cwd, input) }));
}

/**
 * The anchor prefix for one input. A single directory flattens to the archive
 * root — its contents land bare, since the output filename already carries the
 * directory's name. With multiple inputs each directory keeps its basename as a
 * top-level folder so distinct inputs cannot silently merge; a file always lands
 * at its basename.
 */
export function computeAnchor(input: ResolvedInput, isDir: boolean, inputCount: number): string {
  const base = path.basename(input.path);
  if (isDir && inputCount === 1) return "";
  return base;
}

export function joinArchivePath(anchor: string, relative: string): string {
  const rel = trimSlashes(toForwardSlash(relative));
  if (anchor === "") return rel;
  if (rel === "") return anchor;
  return `${anchor}/${rel}`;
}

/**
 * Distinct inputs that resolve to the same non-empty prefix would nest into one
 * another silently; that is an error. Root-level merges (empty anchor)
 * are left to per-entry collision detection.
 */
export function checkAnchorCollisions(inputs: ResolvedInput[], anchors: string[]): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i] ?? "";
    if (anchor === "") continue;
    const prev = seen.get(anchor);
    if (prev !== undefined) {
      throw new PolicyError(
        "input.prefix-collision",
        `inputs "${inputs[prev]?.path}" and "${inputs[i]?.path}" resolve to the same archive prefix "${anchor}"`,
      );
    }
    seen.set(anchor, i);
  }
}
