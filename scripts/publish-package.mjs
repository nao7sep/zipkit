/** Publish a locally built package by directory swap; retain the prior package
 * until the clean candidate has been validated. Both launcher families use it.
 * CLI: node publish-package.mjs <candidate> <destination> <relative executable>
 */
import { stat, rename, rm } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export async function publishPackage(candidate, destination, executable) {
  candidate = resolve(candidate);
  destination = resolve(destination);
  const inside = relative(candidate, resolve(candidate, executable));
  if (inside.startsWith("..") || isAbsolute(inside) || candidate === destination) throw new Error("Invalid package candidate");
  if (!(await stat(join(candidate, inside))).isFile()) throw new Error("Candidate executable is not a file");
  const previous = `${candidate}.previous`;
  let movedPrevious = false;
  try {
    await rename(destination, previous);
    movedPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try { await rename(candidate, destination); }
  catch (error) {
    if (movedPrevious) {
      try { await rename(previous, destination); }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], `Package replacement failed; previous package remains at ${previous}`);
      }
    }
    throw error;
  }
  if (movedPrevious) {
    await rm(previous, { recursive: true, force: true }).catch((error) => {
      process.stderr.write(`The new package is ready; previous package cleanup failed at ${previous}: ${error.message}\n`);
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidate, destination, executable] = process.argv.slice(2);
  if (!candidate || !destination || !executable) throw new Error("Expected candidate, destination and relative executable");
  await publishPackage(candidate, destination, executable);
}
