/**
 * No-overwrite publication of a completed temp file staged beside its target
 * (storage-path conventions, Replacement and publication). A hard link claims
 * the name atomically. A file system without hard links (exFAT, FAT, some
 * network shares) gets the next best thing: the name is confirmed free, then
 * the temp is renamed in, so no reader ever sees a partial file. What remains
 * is another writer taking the same name between the check and the rename.
 * The temp is never copied into place, which would expose a partial file and
 * could leave one behind that looks finished.
 */

import { throwIfAborted } from "../errors.ts";
import type { Volume } from "./volume.ts";

/** Link failures that mean the file system has no hard links, not that this
 *  link failed. */
const LINK_UNSUPPORTED = new Set(["EACCES", "EMLINK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);

export interface PublishOperations {
  link(tempPath: string, output: string): Promise<void>;
  /** Whether anything is at `output` now. */
  exists(output: string): Promise<boolean>;
  rename(tempPath: string, output: string): Promise<void>;
  unlink(tempPath: string): Promise<void>;
}

/** The publication operations over the run's bounded {@link Volume}: the link
 *  and the rename are commit calls, the name check is ordinary work, and the
 *  temp's removal after a link is cleanup. */
export function volumePublishOperations(volume: Volume, durable = false): PublishOperations {
  return {
    link: (tempPath, output) => volume.publishLink(tempPath, output, durable),
    exists: async (output) => {
      try {
        await volume.lstat(output);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },
    rename: (tempPath, output) => volume.publishRename(tempPath, output, durable),
    unlink: (path) => volume.unlink(path),
  };
}

/** What a publication did: put the archive in place, or found the name taken
 *  and left the temp where it is. */
export type Publication = "published" | "exists";

export async function publishNoOverwrite(
  tempPath: string,
  output: string,
  signal: AbortSignal | undefined,
  operations: PublishOperations,
): Promise<Publication> {
  throwIfAborted(signal);
  try {
    await operations.link(tempPath, output);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "exists";
    if (!code || !LINK_UNSUPPORTED.has(code)) throw err;
    if (await operations.exists(output)) return "exists";
    throwIfAborted(signal);
    await operations.rename(tempPath, output);
    return "published";
  }

  try {
    await operations.unlink(tempPath);
  } catch {
    // Publication already committed. Temp cleanup cannot turn success into a
    // reported failure; the committed output remains authoritative.
  }
  return "published";
}
