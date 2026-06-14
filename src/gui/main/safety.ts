/**
 * Guard for the "move originals to Trash" flow: refuse it when the archive would
 * land *inside* one of the inputs, because moving that input to Trash would take
 * the freshly written archive with it. Pure path arithmetic (no filesystem), so
 * it is unit-tested directly. The destructive flow can't know this is unsafe from
 * any SDK verdict — it is the GUI's own action — so the check lives here.
 */

import path from "node:path";

/** Whether `output` resolves to a location at or inside any of `inputs`. */
export function outputInsideInputs(output: string, inputs: string[]): boolean {
  const out = path.resolve(output);
  return inputs.some((input) => {
    const root = path.resolve(input);
    if (out === root) return true;
    const rel = path.relative(root, out);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}
