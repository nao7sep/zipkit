/** Portable no-clobber publication for a completed same-directory temp file. */

import { constants } from "node:fs";
import { copyFile, link, unlink } from "node:fs/promises";

const LINK_UNSUPPORTED = new Set(["EACCES", "EMLINK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);

export interface PublishOperations {
  link(tempPath: string, output: string): Promise<void>;
  copyExclusive(tempPath: string, output: string): Promise<void>;
  unlink(tempPath: string): Promise<void>;
}

const realOperations: PublishOperations = {
  link,
  copyExclusive: (tempPath, output) => copyFile(tempPath, output, constants.COPYFILE_EXCL),
  unlink,
};

/**
 * Publish without replacing an existing destination. Hard linking is the atomic
 * same-inode path. Filesystems without hard-link support fall back to an
 * exclusive copy: the target name is still claimed with O_EXCL semantics, so a
 * concurrent winner is preserved rather than overwritten. The completed temp
 * remains the recovery source until either publication path succeeds.
 */
export async function publishNoOverwrite(
  tempPath: string,
  output: string,
  operations: PublishOperations = realOperations,
): Promise<void> {
  try {
    await operations.link(tempPath, output);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !LINK_UNSUPPORTED.has(code)) throw err;
    await operations.copyExclusive(tempPath, output);
  }

  try {
    await operations.unlink(tempPath);
  } catch {
    // Publication already committed. Temp cleanup cannot turn success into a
    // reported failure; the committed output remains authoritative.
  }
}
