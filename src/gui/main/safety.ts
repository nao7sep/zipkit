/**
 * Guard for the "move originals to Trash" flow: refuse it when the archive would
 * land *inside* one of the inputs, because moving that input to Trash would take
 * the freshly written archive with it. Pure path arithmetic (no filesystem), so
 * it is unit-tested directly. The destructive flow can't know this is unsafe from
 * any SDK verdict — it is the GUI's own action — so the check lives here. Both
 * sides are resolved to their physical identities so symlink aliases cannot
 * bypass the containment decision. The lookups go through the SDK's bounded
 * volume, so a stalled drive fails the check instead of hanging the job.
 */

import path from "node:path";
import type { Volume } from "../../sdk/index.js";

/** Whether `output` resolves to a location at or inside any of `inputs`. */
export async function outputInsideInputs(output: string, inputs: string[], volume: Volume): Promise<boolean> {
  const out = await volume.realpath(output);
  const roots = await Promise.all(inputs.map((input) => volume.realpath(input)));
  return roots.some((root) => {
    if (out === root) return true;
    const rel = path.relative(root, out);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}
