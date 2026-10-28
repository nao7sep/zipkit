/** Path claims, for an app that runs several archive operations at once:
 * each reserves only the paths it uses, so two never change, or one change
 * while another reads, the same file, folder or alias of one. Claims are taken
 * as one set, without waiting while holding another claim. An unresolved
 * external effect retains its claim through physical settlement. */
import path from "node:path";
import type { Volume } from "./internal/volume.ts";
import { aliasUnprovable, foldedName } from "./internal/name-equivalence.ts";
import { isWithin } from "./internal/path.ts";
import { fsFailure } from "./errors.ts";

/** A path as a claim compares it (see `ZipKit.pathResources`). */
export interface PathResource {
  /** The canonical location, its existing folders resolved. */
  location: string;
  /** The physical file it is, or null when nothing is there yet. */
  identity: string | null;
  /** Canonical existing prefix; only names beyond it lack physical evidence. */
  existingPrefix?: string;
}
/** A path an operation reads or changes. */
export interface PathUse extends PathResource { mode: "read" | "change" }
/** A held claim. Release it with the settlement of an effect that may still
 *  land, to hold the paths until it does, or with null when that cannot be
 *  known, to hold them for good. */
export interface PathClaim { release(settlement?: Promise<void> | null): void }
/** The claims one app holds. */
export interface PathClaims {
  /** Take every use at once, or none (null) when any overlaps a held claim:
   *  two reads never conflict. */
  claim(uses: PathUse[]): PathClaim | null;
}

function possibleNamespaceOverlap(a: PathUse, b: PathUse): boolean {
  const segments = (file: string) => file.split(path.sep).filter(Boolean);
  const left = segments(a.location), right = segments(b.location);
  const leftKnown = segments(a.existingPrefix ?? path.parse(a.location).root).length;
  const rightKnown = segments(b.existingPrefix ?? path.parse(b.location).root).length;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!, y = right[i]!;
    if (x === y) continue;
    // Distinct canonical existing directories disprove an alias. An unresolved
    // name cannot: Unicode and short-name equivalence are filesystem-owned.
    if (i < leftKnown && i < rightKnown) return false;
    if (foldedName(x) !== foldedName(y) && !aliasUnprovable(x) && !aliasUnprovable(y)) return false;
  }
  return true;
}
function overlaps(a: PathUse, b: PathUse): boolean {
  if (a.mode === "read" && b.mode === "read") return false;
  if (a.identity !== null && a.identity === b.identity) return true;
  if (isWithin(a.location, b.location) || isWithin(b.location, a.location)) return true;
  // A missing leaf has no physical identity to disprove an insensitive alias.
  if (a.identity === null || b.identity === null) {
    return possibleNamespaceOverlap(a, b);
  }
  return false;
}
export function createPathClaims(): PathClaims {
  const held = new Set<PathUse[]>();
  return {
    claim(uses: PathUse[]): PathClaim | null {
      if ([...held].some((other) => uses.some((use) => other.some((item) => overlaps(use, item))))) return null;
      held.add(uses);
      let retiring = false;
      return { release(settlement) {
        if (retiring) return;
        retiring = true;
        if (settlement === null) return; // unknown physical outcome: session-long reservation
        if (settlement) void settlement.then(() => held.delete(uses), () => held.delete(uses));
        else held.delete(uses);
      } };
    },
  };
}

async function canonicalPrefix(file: string, volume: Volume): Promise<{ location: string; existing: string }> {
  try { const location = await volume.realpath(file); return { location, existing: location }; }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw fsFailure(error, file);
    const parent = path.dirname(file);
    if (parent === file) throw fsFailure(error, file);
    const prefix = await canonicalPrefix(parent, volume);
    return { location: path.join(prefix.location, path.basename(file)), existing: prefix.existing };
  }
}
/** Namespace identity protects replacement; resolved identity also covers
 * directory aliases and hard links. All lookups use SDK volume I/O. */
export async function pathResources(files: readonly string[], volume: Volume): Promise<PathResource[]> {
  const resources: PathResource[] = [];
  for (const file of files) {
    const prefix = await canonicalPrefix(path.dirname(file), volume);
    const location = path.join(prefix.location, path.basename(file));
    let identity: string | null = null;
    try { const st = await volume.lstat(file); identity = `${st.dev}:${st.ino}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fsFailure(error, file); }
    resources.push({ location, identity, existingPrefix: prefix.existing });
    if (identity !== null) {
      try {
        const canonical = await volume.realpath(file);
        if (canonical !== location) {
          const st = await volume.stat(file);
          resources.push({ location: canonical, identity: `${st.dev}:${st.ino}`, existingPrefix: canonical });
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fsFailure(error, file); }
    }
  }
  return resources;
}
