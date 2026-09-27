/**
 * Volumes for tests: the real filesystem behind the SDK's bounded owner, and a
 * stalling filesystem whose chosen calls never settle until released — the
 * shape of a network share or removable drive that stopped responding.
 */

import { nodeFileSystem, Volume, type FileSystemPort, type VolumeFile } from "../../src/sdk/internal/volume.js";

/** The real filesystem with the default budget. */
export function realVolume(signal?: AbortSignal): Volume {
  return new Volume(nodeFileSystem, 30_000, signal);
}

/** Open a real file for reading through a bounded handle. */
export function openRead(path: string): Promise<VolumeFile> {
  return realVolume().open(path, "r");
}

export interface StallingFileSystem {
  port: FileSystemPort;
  /** `"<operation> <path>"` for every call held so far. */
  stalled: string[];
  /** Let every held call run now, late, against the real filesystem. */
  release(): void;
}

/**
 * The real filesystem, except that a call for which `shouldStall(operation,
 * path)` is true is held: it does not start until `release()`, and then runs
 * for real, so a test can prove its late completion changes nothing.
 */
export function stallingFileSystem(shouldStall: (operation: string, path: string) => boolean): StallingFileSystem {
  const held: Array<() => void> = [];
  const stalled: string[] = [];
  function gate<T>(operation: string, path: string, run: () => Promise<T>): Promise<T> {
    if (!shouldStall(operation, path)) return run();
    stalled.push(`${operation} ${path}`);
    return new Promise<T>((resolve, reject) => {
      held.push(() => void run().then(resolve, reject));
    });
  }
  const real = nodeFileSystem;
  const port: FileSystemPort = {
    open: async (path, flags) => {
      const handle = await gate("open", path, () => real.open(path, flags));
      return {
        read: (buffer, offset, length, position) =>
          gate("read", path, () => handle.read(buffer, offset, length, position)),
        write: (buffer, offset, length, position) =>
          gate("write", path, () => handle.write(buffer, offset, length, position)),
        sync: () => gate("sync", path, () => handle.sync()),
        stat: () => gate("fstat", path, () => handle.stat()),
        close: () => handle.close(),
      };
    },
    stat: (path) => gate("stat", path, () => real.stat(path)),
    lstat: (path) => gate("lstat", path, () => real.lstat(path)),
    realpath: (path) => gate("realpath", path, () => real.realpath(path)),
    readlink: (path) => gate("readlink", path, () => real.readlink(path)),
    readdir: (path) => gate("readdir", path, () => real.readdir(path)),
    mkdir: (path, recursive) => gate("mkdir", path, () => real.mkdir(path, recursive)),
    rename: (from, to) => gate("rename", to, () => real.rename(from, to)),
    link: (existing, created) => gate("link", created, () => real.link(existing, created)),
    symlink: (target, path) => gate("symlink", path, () => real.symlink(target, path)),
    unlink: (path) => gate("unlink", path, () => real.unlink(path)),
    rm: (path) => gate("rm", path, () => real.rm(path)),
    utimes: (path, atime, mtime) => gate("utimes", path, () => real.utimes(path, atime, mtime)),
  };
  return {
    port,
    stalled,
    release: () => {
      for (const run of held.splice(0)) run();
    },
  };
}
