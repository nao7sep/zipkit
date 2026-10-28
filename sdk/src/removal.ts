/**
 * The checks before the originals an archive was made from are removed, so
 * that removing them cannot lose data: the archive does not sit inside an
 * input (removing that input would take it along), it verifies against its
 * manifest, and a fresh scan of the inputs still matches that manifest. Each
 * check runs only once those before it passed. The archive's state is read
 * first, so the answer can say which file verified.
 */

import { classify, ZipKitError } from "./errors.ts";
import { isWithin } from "./internal/path.ts";
import type { Volume } from "./internal/volume.ts";
import type { PathState, RemovalCheck, SourceComparison, VerifyReport } from "./types.ts";

/** Whether `output` resolves to a location at or inside any of `inputs`. Both
 *  sides are resolved to their physical identities, so a link cannot hide the
 *  archive inside an input. */
export async function outputInsideInputs(output: string, inputs: readonly string[], volume: Volume): Promise<boolean> {
  const out = await volume.realpath(output);
  const roots = await Promise.all(inputs.map((input) => volume.realpath(input)));
  return roots.some((root) => isWithin(root, out));
}

/** The steps {@link checkRemoval} runs, each a look at the disk. */
export interface RemovalSteps {
  /** What is at the archive's path now. */
  state(): Promise<PathState>;
  /** Whether the archive sits at or inside an input. */
  inside(): Promise<boolean>;
  /** The archive verified against its manifest: whether it passed, and what failed. */
  verify(): Promise<{ ok: boolean; report: VerifyReport }>;
  /** A fresh scan of the inputs still present, compared with the manifest,
   *  with what inputs already removed took explained. */
  compare(): Promise<SourceComparison>;
}

/** A step's failure, classified, or thrown as it is when it is a
 *  cancellation, which ends the check rather than answering it. */
function stepFailure(error: unknown, subject: string): ZipKitError {
  const failure = classify(error, subject);
  if (failure.kind === "cancelled") throw failure;
  return failure;
}

/**
 * Run the checks in order and stop at the first that refuses. A check that
 * cannot finish refuses too, naming its step and carrying its error; a
 * cancellation is thrown instead, since it answers nothing.
 */
export async function checkRemoval(steps: RemovalSteps, archive: string): Promise<RemovalCheck> {
  const refuse = (refusal: NonNullable<RemovalCheck["refusal"]>, verified: RemovalCheck["verified"] = null): RemovalCheck =>
    ({ refusal, verified });
  let seen: PathState | null = null;
  try {
    seen = await steps.state();
    if (seen.kind !== "present") throw new ZipKitError("path.missing", "Archive identity could not be established", { subject: archive });
  } catch (error) {
    return refuse({ reason: "error", step: "verify", error: stepFailure(error, archive).toJSON() });
  }
  try {
    if (await steps.inside()) return refuse({ reason: "inside" });
  } catch (error) {
    return refuse({ reason: "error", step: "location", error: stepFailure(error, archive).toJSON() });
  }
  try {
    const verification = await steps.verify();
    if (!verification.ok) return refuse({ reason: "verify-failed", report: verification.report });
  } catch (error) {
    return refuse({ reason: "error", step: "verify", error: stepFailure(error, archive).toJSON() });
  }
  const verified = { fingerprint: seen?.kind === "present" ? seen.fingerprint : null };
  try {
    const comparison = await steps.compare();
    if (!comparison.matches) return refuse({ reason: "changed", comparison }, verified);
    // The archive is read once more right before removal is authorized, so
    // one replaced or removed during the checks does not authorize it.
    const after = await steps.state();
    if (after.kind !== "present" || after.fingerprint !== verified.fingerprint) {
      throw new ZipKitError("archive.changed", "Archive changed during the removal checks", { subject: archive });
    }
  } catch (error) {
    return refuse({ reason: "error", step: "recheck", error: stepFailure(error, archive).toJSON() }, verified);
  }
  return { refusal: null, verified };
}
