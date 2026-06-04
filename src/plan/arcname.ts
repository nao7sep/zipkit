/**
 * Arcname resolution (§4 pass 1, §10.4–§10.5). Given an input's anchor and the
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
import { resolveSegments, toForwardSlash, trimSlashes } from "../internal/path.js";
import type { ArchiveInput } from "../types.js";

export interface ResolvedInput {
  path: string; // absolute
  as?: string;
  flatten?: boolean;
}

export function normalizeInputs(inputs: ArchiveInput[], cwd: string): ResolvedInput[] {
  return inputs.map((input) => {
    if (typeof input === "string") {
      return { path: path.resolve(cwd, input) };
    }
    const resolved: ResolvedInput = { path: path.resolve(cwd, input.path) };
    if (input.as !== undefined) resolved.as = input.as;
    if (input.flatten !== undefined) resolved.flatten = input.flatten;
    return resolved;
  });
}

/**
 * The anchor prefix for one input. With `root`, every input is anchored at its
 * path relative to `root` (and `as`/`flatten` are forbidden). Otherwise a
 * single directory flattens to the root by default — `flatten: false` keeps its
 * name — while multiple inputs are basename-prefixed so they cannot collide
 * silently. A per-input `as` overrides the prefix; a file always lands at its
 * basename.
 */
export function computeAnchor(
  input: ResolvedInput,
  isDir: boolean,
  inputCount: number,
  root: string | undefined,
): string {
  if (root !== undefined) {
    if (input.as !== undefined || input.flatten !== undefined) {
      throw new PolicyError(
        "input.root-conflict",
        `root is mutually exclusive with as/flatten (input: ${input.path})`,
      );
    }
    const rel = path.relative(root, input.path);
    if (rel === "") {
      if (!isDir) {
        throw new PolicyError(
          "input.file-is-root",
          `a file input cannot be the root itself: ${input.path}`,
        );
      }
      return "";
    }
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PolicyError("input.outside-root", `input is not under root: ${input.path}`);
    }
    return trimSlashes(toForwardSlash(rel));
  }

  if (input.as !== undefined) {
    const { segments, escaped } = resolveSegments(toForwardSlash(input.as));
    if (escaped || segments.length === 0) {
      throw new PolicyError(
        "input.invalid-as",
        `the "as" value does not name a valid archive path: "${input.as}"`,
      );
    }
    return segments.join("/");
  }

  const base = path.basename(input.path);
  if (isDir) {
    if (inputCount === 1) return input.flatten === false ? base : "";
    return input.flatten === true ? "" : base;
  }
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
 * another silently; that is an error (§10.4). Root-level merges (empty anchor)
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
