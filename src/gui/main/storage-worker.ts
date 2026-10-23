/** Filesystem preparation stays off Electron's main thread, including slow volumes. */
import { chmod, mkdir } from "node:fs/promises";
import { electronStoragePaths } from "./storage.ts";
import { workerData } from "node:worker_threads";

const { root } = workerData as { root: string };
await mkdir(root, { recursive: true, mode: 0o700 });
// mkdir's mode only applies on creation. Existing roots also protect derived data.
if (process.platform !== "win32") await chmod(root, 0o700);
for (const directory of Object.values(electronStoragePaths(root))) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
