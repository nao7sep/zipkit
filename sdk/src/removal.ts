/**
 * The checks before the originals an archive was made from are removed, so
 * that removing them cannot lose data: the archive is still the one expected,
 * it does not sit inside an input (removing that input would take it along),
 * it verifies against its manifest, and a fresh scan of the inputs still
 * matches that manifest. Each check runs only once those before it passed.
 */

import path from "node:path";
import { fsFailure, type ZipKitError } from "./errors.ts";
import type { Volume } from "./internal/volume.ts";
import type { PathState, PlannedEntry, RemovalCheck, SourceComparison, Unarchived, VerifyReport } from "./types.ts";

/** Whether `output` resolves to a location at or inside any of `inputs`. Both
 *  sides are resolved to their physical identities, so a link cannot hide the
 *  archive inside an input; a stalled drive fails the check instead of hanging. */
export async function outputInsideInputs(output: string, inputs: readonly string[], volume: Volume): Promise<boolean> {
  const out = await volume.realpath(output);
  const roots = await Promise.all(inputs.map((input) => volume.realpath(input)));
  return roots.some((root) => {
    if (out === root) return true;
    const rel = path.relative(root, out);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

/** An input's own name: the first segment of every manifest source path it
 *  contributed. */
function inputName(input: string): string {
  return input.split(/[\\/]/).filter((s) => s !== "").pop() ?? "";
}

/**
 * A comparison of only the inputs still present, after some were already
 * removed: the manifest entries the removed inputs contributed are missing by
 * design, so they are not a difference. A removed input that shares its name
 * with one still present explains nothing, since their entries cannot be told
 * apart.
 */
export function explainRemoved(comparison: SourceComparison, present: readonly string[], removed: readonly string[]): SourceComparison {
  if (removed.length === 0) return comparison;
  const presentNames = new Set(present.map(inputName));
  const removedNames = new Set(removed.map(inputName).filter((name) => !presentNames.has(name)));
  const missing = comparison.missing.filter((p) => !removedNames.has(p.split("/")[0] ?? ""));
  const matches =
    comparison.added.length === 0 &&
    missing.length === 0 &&
    comparison.changed.length === 0 &&
    comparison.unlisted.length === 0;
  return { ...comparison, missing, matches };
}

/** The steps {@link checkRemoval} runs, each a look at the disk. */
export interface RemovalSteps {
  /** What is at the archive's path now. */
  state(): Promise<PathState>;
  /** Whether the archive sits at or inside an input. */
  inside(): Promise<boolean>;
  /** The archive verified against its manifest: whether it passed, and what failed. */
  verify(): Promise<{ ok: boolean; report: VerifyReport }>;
  /** A fresh scan of the inputs still present, compared with the manifest. */
  compare(): Promise<SourceComparison>;
}

/** A step's failure as the refusal carries it, or thrown as it is when it
 *  is a cancellation, which ends the check rather than answering it. */
function stepFailure(error: unknown, subject: string): ZipKitError {
  const failure = fsFailure(error, subject);
  if (failure.kind === "cancelled") throw failure;
  return failure;
}

/**
 * Run the checks in order and stop at the first that refuses. A check that
 * cannot finish refuses too, naming its step and carrying its error; a
 * cancellation is thrown instead, since it answers nothing.
 */
export async function checkRemoval(
  steps: RemovalSteps,
  archive: string,
  inputs: readonly string[],
  removed: readonly string[],
): Promise<RemovalCheck> {
  const refuse = (refusal: NonNullable<RemovalCheck["refusal"]>, verified: RemovalCheck["verified"] = null): RemovalCheck =>
    ({ refusal, verified });
  let seen: PathState | null = null;
  // Unknown is an answer here: the verification says whether the archive is there.
  try { seen = await steps.state(); } catch (error) { stepFailure(error, archive); }
  try {
    if (await steps.inside()) return refuse({ reason: "inside" });
  } catch (error) {
    return refuse({ reason: "error", step: "location", error: stepFailure(error, archive) });
  }
  try {
    const verification = await steps.verify();
    if (!verification.ok) return refuse({ reason: "verify-failed", report: verification.report });
  } catch (error) {
    return refuse({ reason: "error", step: "verify", error: stepFailure(error, archive) });
  }
  const verified = { fingerprint: seen?.kind === "present" ? seen.fingerprint : null };
  try {
    const comparison = explainRemoved(await steps.compare(), inputs, removed);
    if (!comparison.matches) return refuse({ reason: "changed", comparison }, verified);
  } catch (error) {
    return refuse({ reason: "error", step: "recheck", error: stepFailure(error, archive) }, verified);
  }
  return { refusal: null, verified };
}

/** What removing the originals `plan` was made from would take without a
 *  copy in the archive: the items it leaves out, but for duplicates archived
 *  through another input, and the folders it could not read. */
export function unarchived(plan: { entries: readonly PlannedEntry[] }): Unarchived {
  return {
    excluded: plan.entries.filter((entry) => entry.excluded && entry.excludeCode !== "duplicate"),
    unlisted: plan.entries.filter((entry) => entry.findings.some((f) => f.rule === "entry.unlisted")),
  };
}
