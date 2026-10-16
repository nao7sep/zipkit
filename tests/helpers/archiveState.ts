/**
 * The engine's archive look-up for tests that write real archives: the same
 * comparable string the SDK host returns (which file, its size and when it
 * last changed), or null when nothing is at the path.
 */

import { lstat } from "node:fs/promises";

export async function realArchiveState(output: string): Promise<string | null> {
  try {
    const st = await lstat(output, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
