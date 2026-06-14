/**
 * Output path resolution. An explicit output wins. Otherwise the
 * archive is written beside what is archived: a single directory yields
 * `<dirname>.zip` next to it, a single file yields `<stem>.zip` next to it, and
 * several things in one parent yield `<parent>.zip` in that parent. Several
 * things in different parents is an error with no fallback, because the
 * question is where to write, and guessing is wrong. Pure path arithmetic; the
 * existence check is the scan edge's job.
 */

import path from "node:path";
import { PolicyError } from "../errors.js";
import type { ResolvedInput } from "../plan/arcname.js";

export function resolveOutputPath(
  output: string | undefined,
  inputs: ResolvedInput[],
  isDir: boolean[],
  cwd: string,
): string {
  if (output !== undefined) return path.resolve(cwd, output);

  if (inputs.length === 1) {
    const input = inputs[0];
    if (!input) {
      throw new PolicyError("output.ambiguous", "no inputs to infer an output path from");
    }
    const dir = path.dirname(input.path);
    const base = path.basename(input.path);
    if (isDir[0]) {
      return path.join(dir, `${base}.zip`);
    }
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    return path.join(dir, `${stem}.zip`);
  }

  const parents = new Set(inputs.map((input) => path.dirname(input.path)));
  if (parents.size === 1) {
    const parent = [...parents][0] as string;
    return path.join(parent, `${path.basename(parent)}.zip`);
  }

  throw new PolicyError(
    "output.ambiguous",
    "cannot infer the output path: inputs live in different parents; pass an explicit output",
  );
}
