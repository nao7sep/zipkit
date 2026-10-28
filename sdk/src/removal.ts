/**
 * Removing the originals an archive was made from, after the checks that make
 * it unable to lose data: the archive does not sit inside an input (removing
 * that input would take it along), it verifies against its manifest, and a
 * fresh scan of the inputs still matches that manifest. Each check runs only
 * once those before it passed. The archive's state is read first, so the
 * answer can say which file verified, and once more right before the
 * originals go. Then each original goes in turn.
 */

import { classify, fsFailure, ZipKitError } from "./errors.ts";
import { isWithin } from "./internal/path.ts";
import type { Volume } from "./internal/volume.ts";
import type { PathState, RemovalOutcome, RemovalRefusal, SourceComparison, VerifyReport } from "./types.ts";

/** What the checks answered: a refusal, or null, and which file verified. */
export interface RemovalCheck {
  refusal: RemovalRefusal | null;
  verified: { fingerprint: string | null } | null;
}

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
  const refuse = (refusal: RemovalRefusal, verified: RemovalCheck["verified"] = null): RemovalCheck =>
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
    // The archive is read once more right before the originals go, so one
    // replaced or removed during the checks does not let them go.
    const after = await steps.state();
    if (after.kind !== "present" || after.fingerprint !== verified.fingerprint) {
      throw new ZipKitError("archive.changed", "Archive changed during the removal checks", { subject: archive });
    }
  } catch (error) {
    return refuse({ reason: "error", step: "recheck", error: stepFailure(error, archive).toJSON() }, verified);
  }
  return { refusal: null, verified };
}

/** How one original goes: to the Trash or deleted for good. */
export interface RemovalSink {
  remove(path: string): Promise<void>;
  /** Whether a path whose removal failed is gone anyway, removed by something else. */
  gone(path: string, error: unknown): Promise<boolean>;
}

/**
 * Remove each path in turn, every call run to its end. A cancel stops before
 * the next path, which is kept; a path whose removal failed is gone when
 * something else already took it, and kept otherwise.
 */
export async function removeInTurn(paths: readonly string[], sink: RemovalSink, signal?: AbortSignal): Promise<RemovalOutcome> {
  const outcome: RemovalOutcome = { removed: [], gone: [], kept: [] };
  for (const path of paths) {
    if (signal?.aborted) {
      outcome.kept.push({ path, error: new ZipKitError("operation.cancelled", "cancelled before its turn", { subject: path }).toJSON() });
      continue;
    }
    try {
      await sink.remove(path);
      outcome.removed.push(path);
    } catch (error) {
      if (await sink.gone(path, error)) outcome.gone.push(path);
      else outcome.kept.push({ path, error: fsFailure(error, path).toJSON() });
    }
  }
  return outcome;
}
