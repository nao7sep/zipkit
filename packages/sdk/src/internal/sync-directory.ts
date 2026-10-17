/** Request directory metadata synchronization where Node and the filesystem
 * support it. Windows exposes no directory flush through Node's file API.
 * Unsupported capability is distinct from an I/O or permission failure. */
import { open } from "node:fs/promises";

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const unsupported = (error: unknown) => ["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException)?.code ?? "");
  const handle = await open(directory, "r").catch((error: unknown) => {
    if (unsupported(error)) return null;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync().catch((error: unknown) => {
      if (!unsupported(error)) throw error;
    });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  await handle.close();
}
