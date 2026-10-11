/** Cooperating archive operations reserve only the paths they use. Claims are
 * taken as one set, without waiting while holding another claim. An unresolved
 * external effect retains its claim through physical settlement. */
import path from "node:path";
import type { Volume } from "../../sdk/internal/volume.js";

export interface FileResource {
  location: string;
  identity: string | null;
  /** Canonical existing prefix; only names beyond it lack physical evidence. */
  existingPrefix?: string;
}
export interface FileUse extends FileResource { mode: "read" | "change" }
export interface EffectClaim { release(settlement?: Promise<void> | null): void }

function contains(a: string, b: string): boolean {
  const relative = path.relative(a, b);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function uncertain(name: string): boolean {
  return /[^\x00-\x7f]/.test(name) || (process.platform === "win32" && (/~\d/.test(name) || /[. ]$/.test(name)));
}
function possibleNamespaceOverlap(a: FileUse, b: FileUse): boolean {
  const segments = (file: string) => file.split(path.sep).filter(Boolean);
  const left = segments(a.location), right = segments(b.location);
  const leftKnown = segments(a.existingPrefix ?? path.parse(a.location).root).length;
  const rightKnown = segments(b.existingPrefix ?? path.parse(b.location).root).length;
  const folded = (name: string) => (process.platform === "win32" ? name.replace(/[. ]+$/, "") : name).normalize("NFC").toLowerCase();
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!, y = right[i]!;
    if (x === y) continue;
    // Distinct canonical existing directories disprove an alias. An unresolved
    // name cannot: Unicode and short-name equivalence are filesystem-owned.
    if (i < leftKnown && i < rightKnown) return false;
    if (folded(x) !== folded(y) && !uncertain(x) && !uncertain(y)) return false;
  }
  return true;
}
function overlaps(a: FileUse, b: FileUse): boolean {
  if (a.mode === "read" && b.mode === "read") return false;
  if (a.identity !== null && a.identity === b.identity) return true;
  if (contains(a.location, b.location) || contains(b.location, a.location)) return true;
  // A missing leaf has no physical identity to disprove an insensitive alias.
  if (a.identity === null || b.identity === null) {
    return possibleNamespaceOverlap(a, b);
  }
  return false;
}
export function createArchiveEffects() {
  const held = new Set<FileUse[]>();
  return {
    claim(uses: FileUse[]): EffectClaim | null {
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
export const appArchiveEffects = createArchiveEffects();

async function canonicalPrefix(file: string, volume: Volume): Promise<{ location: string; existing: string }> {
  try { const location = await volume.realpath(file); return { location, existing: location }; }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    const prefix = await canonicalPrefix(parent, volume);
    return { location: path.join(prefix.location, path.basename(file)), existing: prefix.existing };
  }
}
/** Namespace identity protects replacement; resolved identity also covers
 * directory aliases and hard links. All lookups use bounded SDK volume I/O. */
export async function fileResources(files: string[], volume: Volume): Promise<FileResource[]> {
  const resources: FileResource[] = [];
  for (const file of files) {
    const prefix = await canonicalPrefix(path.dirname(file), volume);
    const location = path.join(prefix.location, path.basename(file));
    let identity: string | null = null;
    try { const st = await volume.lstat(file); identity = `${st.dev}:${st.ino}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    resources.push({ location, identity, existingPrefix: prefix.existing });
    if (identity !== null) {
      try {
        const canonical = await volume.realpath(file);
        if (canonical !== location) {
          const st = await volume.stat(file);
          resources.push({ location: canonical, identity: `${st.dev}:${st.ino}`, existingPrefix: canonical });
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return resources;
}
