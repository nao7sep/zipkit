/**
 * What is at a path, as ZipKit must tell it apart: there (with a comparable
 * fingerprint), gone, or out of reach. A path is out of reach, never gone,
 * when the drive that holds it is not connected or the path cannot be read, so
 * an ejected drive or a permission change is never taken for a deletion. The
 * drive rule is pure given the platform, so it unit-tests without one; the
 * look-ups use the SDK's bounded volume.
 */

import path from "node:path";
import type { Volume } from "../../sdk/index.js";
import { ZipKitError } from "../../sdk/index.js";

export type PathState =
  | { kind: "present"; fingerprint: string }
  | { kind: "gone" }
  | { kind: "unavailable" };

/** The folder a removable or network drive is mounted at, for a path on one,
 *  or the drive root on Windows; null for a path on the system drive. A path
 *  whose mount point is missing is on a drive that is not connected. */
export function mountPointOf(target: string, platform: NodeJS.Platform): string | null {
  if (platform === "win32") {
    const root = path.win32.parse(target).root;
    return root === "" ? null : root;
  }
  const parts = target.split("/");
  if (platform === "darwin") return parts[1] === "Volumes" && parts[2] ? `/Volumes/${parts[2]}` : null;
  if (parts[1] === "mnt" && parts[2]) return `/mnt/${parts[2]}`;
  if (parts[1] === "media" && parts[2] && parts[3]) return `/media/${parts[2]}/${parts[3]}`;
  if (parts[1] === "run" && parts[2] === "media" && parts[3] && parts[4]) return `/run/media/${parts[3]}/${parts[4]}`;
  return null;
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Whether the drive holding `target` is not connected. */
export async function driveMissing(target: string, volume: Volume, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const mount = mountPointOf(target, platform);
  if (mount === null) return false;
  try { await volume.lstat(mount); return false; }
  catch (error) {
    if (error instanceof ZipKitError) throw error;
    return missing(error);
  }
}

/** What is at `target` now. A stalled volume rejects, so a caller keeps what
 *  it knew rather than guessing. */
export async function pathState(target: string, volume: Volume, platform: NodeJS.Platform = process.platform): Promise<PathState> {
  try {
    const st = await volume.lstat(target);
    return { kind: "present", fingerprint: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}` };
  } catch (error) {
    if (error instanceof ZipKitError) throw error;
    if (!missing(error)) return { kind: "unavailable" };
    return (await driveMissing(target, volume, platform)) ? { kind: "unavailable" } : { kind: "gone" };
  }
}

/** Whether two fingerprints name the same file, whatever its content. */
export function sameFile(a: string, b: string): boolean {
  return a.split(":").slice(0, 2).join(":") === b.split(":").slice(0, 2).join(":");
}
