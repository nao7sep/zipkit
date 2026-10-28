/** Volumes for tests: the real filesystem behind the SDK's file access. */

import { nodeFileSystem, Volume, type FileSystemPort, type VolumeFile } from "../../src/internal/volume.ts";

/** The real filesystem. */
export function realVolume(signal?: AbortSignal): Volume {
  return new Volume(nodeFileSystem, signal);
}

/** Open a real file for reading through a volume handle. */
export function openRead(path: string): Promise<VolumeFile> {
  return realVolume().open(path, "r");
}

type PortHandle = Awaited<ReturnType<FileSystemPort["open"]>>;

/**
 * The real filesystem, except that the handle opened for `path` is passed
 * through `wrap`, so a test can make that one file report another stat or
 * return other bytes than the disk holds.
 */
export function fileSystemWith(path: string, wrap: (handle: PortHandle) => PortHandle): FileSystemPort {
  return {
    ...nodeFileSystem,
    open: async (p, flags, mode) => {
      const handle = await nodeFileSystem.open(p, flags, mode);
      return p === path ? wrap(handle) : handle;
    },
  };
}
