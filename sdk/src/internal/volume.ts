/**
 * The SDK's one file-access boundary. Every filesystem call the scan, write,
 * and verify edges make on a user volume goes through a {@link Volume}.
 *
 * Each call is Node's asynchronous file API, run on libuv's threadpool off the
 * JS thread, and is awaited to its end: a local or removable volume gets no
 * timeout (transaction conventions), and a stalled one is left to the user to
 * reconnect or to quit. The verb's `AbortSignal` is honoured between calls:
 *
 * - `work` — ordinary reads and writes, and the publication of a finished
 *   file (a rename or hard link into the destination). None starts once the
 *   verb is cancelled.
 * - `cleanup` — closing handles and removing this run's own temp files after a
 *   failure. Always attempted, never stopped by the cancel that triggered it.
 */

import type { BigIntStats } from "node:fs";
import * as fsp from "node:fs/promises";
import { toAbortError } from "../errors.ts";

/** A directory entry as the walker needs it. */
export interface DirEntry {
  name: string;
  isDirectory(): boolean;
}

/** An open file on the raw port. Positions are absolute; `null` appends at the
 *  handle's current position. */
export interface FileHandlePort {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  write(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  stat(): Promise<BigIntStats>;
  close(): Promise<void>;
}

/** The raw filesystem the SDK runs on: Node's `fs/promises` in production, a
 *  fake in tests. */
export interface FileSystemPort {
  open(path: string, flags: string, mode?: number): Promise<FileHandlePort>;
  stat(path: string): Promise<BigIntStats>;
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<DirEntry[]>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, created: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Create a folder and any missing parents; one that exists is left as it is. */
  mkdir(path: string): Promise<void>;
}

/** Only explicit filesystem capability failures permit omitting ordinary modes. */
export function isModeUnsupported(error: unknown): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

export const nodeFileSystem: FileSystemPort = {
  open: async (path, flags, mode) => {
    const handle = await fsp.open(path, flags, mode);
    return {
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
      sync: () => handle.sync(),
      stat: () => handle.stat({ bigint: true }),
      close: () => handle.close(),
    };
  },
  stat: (path) => fsp.stat(path, { bigint: true }),
  lstat: (path) => fsp.lstat(path, { bigint: true }),
  realpath: (path) => fsp.realpath(path),
  readlink: (path) => fsp.readlink(path),
  readdir: (path) => fsp.readdir(path, { withFileTypes: true }),
  rename: (from, to) => fsp.rename(from, to),
  link: (existing, created) => fsp.link(existing, created),
  unlink: (path) => fsp.unlink(path),
  rm: (path) => fsp.rm(path, { force: true }),
  chmod: (path, mode) => fsp.chmod(path, mode),
  mkdir: async (path) => { await fsp.mkdir(path, { recursive: true }); },
};

type Mode = "work" | "cleanup";

/**
 * One verb run's file access, built per run with the run's signal; see the
 * module comment for the modes.
 */
export class Volume {
  readonly #port: FileSystemPort;
  readonly #signal: AbortSignal | undefined;

  constructor(port: FileSystemPort, signal?: AbortSignal) {
    this.#port = port;
    this.#signal = signal;
  }

  stat(path: string): Promise<BigIntStats> {
    return this.#run("work", () => this.#port.stat(path));
  }

  lstat(path: string): Promise<BigIntStats> {
    return this.#run("work", () => this.#port.lstat(path));
  }

  realpath(path: string): Promise<string> {
    return this.#run("work", () => this.#port.realpath(path));
  }

  readlink(path: string): Promise<string> {
    return this.#run("work", () => this.#port.readlink(path));
  }

  readdir(path: string): Promise<DirEntry[]> {
    return this.#run("work", () => this.#port.readdir(path));
  }

  /** Create a folder with any missing parents, as ordinary work. */
  mkdir(path: string): Promise<void> {
    return this.#run("work", () => this.#port.mkdir(path));
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.#run("work", () => this.#port.chmod(path, mode));
  }

  /**
   * Give a finished temp the permission mode of the `target` it will replace,
   * so the replace keeps it (content-lifecycle conventions), and say whether a
   * target was found. Only an explicit unsupported-mode error is tolerated;
   * read and permission failures stop publication.
   */
  async keepMode(target: string, temp: string): Promise<boolean> {
    let mode: number;
    try {
      mode = Number((await this.stat(target)).mode) & 0o7777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    try {
      await this.chmod(temp, mode);
    } catch (err) {
      if (!isModeUnsupported(err)) throw err;
    }
    return true;
  }

  /** Give a completed new output the runtime's ordinary creation mode. */
  async prepareNewMode(path: string, mode = 0o666 & ~process.umask()): Promise<void> {
    try {
      await this.chmod(path, mode);
    } catch (error) {
      if (!isModeUnsupported(error)) throw error;
    }
  }

  /** Publish a finished temp file by renaming it over `to`. */
  publishRename(from: string, to: string): Promise<void> {
    return this.#run("work", () => this.#port.rename(from, to));
  }

  /** Publish a finished temp file by hard-linking it at `to`. */
  publishLink(existing: string, to: string): Promise<void> {
    return this.#run("work", () => this.#port.link(existing, to));
  }

  /** Unlink a path this run created, as cleanup. Errors propagate. */
  unlink(path: string): Promise<void> {
    return this.#run("cleanup", () => this.#port.unlink(path));
  }

  /** Remove a temp file this run created, best-effort: never stopped by the
   *  cancel, and silent on failure. Whether it is gone afterwards; one
   *  that cannot be removed stays visible under its `.tmp` name. */
  async discard(path: string): Promise<boolean> {
    try {
      await this.#run("cleanup", () => this.#port.rm(path));
      return true;
    } catch (err) {
      return (err as { code?: unknown }).code === "ENOENT";
    }
  }

  async open(path: string, flags: string): Promise<VolumeFile> {
    const handle = await this.#run("work", () => this.#port.open(path, flags));
    return new VolumeFile(this, handle, path);
  }

  /** Create this run's own temp file at a fresh, unique path, exclusively. */
  async createTemp(path: string): Promise<VolumeFile> {
    const handle = await this.#run("work", () => this.#port.open(path, "wx", 0o600));
    return new VolumeFile(this, handle, path);
  }

  /** @internal Run one call on an open handle; used by {@link VolumeFile}. */
  runOnHandle<T>(mode: Mode, start: () => Promise<T>): Promise<T> {
    return this.#run(mode, start);
  }

  #run<T>(mode: Mode, start: () => Promise<T>): Promise<T> {
    const signal = this.#signal;
    if (mode !== "cleanup" && signal?.aborted) return Promise.reject(toAbortError(signal.reason));
    return start();
  }
}

/** An open file whose every call goes through its {@link Volume}. */
export class VolumeFile {
  readonly #volume: Volume;
  readonly #handle: FileHandlePort;
  readonly #path: string;

  constructor(volume: Volume, handle: FileHandlePort, path: string) {
    this.#volume = volume;
    this.#handle = handle;
    this.#path = path;
  }

  #run<T>(mode: Mode, start: () => Promise<T>): Promise<T> {
    return this.#volume.runOnHandle(mode, start);
  }

  /** One positioned read; resolves to the byte count (0 at end of file). */
  async read(buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
    const { bytesRead } = await this.#run("work", () => this.#handle.read(buffer, offset, length, position));
    return bytesRead;
  }

  /** Write all of `buffer`, at `position` or (null) at the current position. */
  async writeAll(buffer: Buffer, position: number | null): Promise<void> {
    let written = 0;
    while (written < buffer.length) {
      const at = position === null ? null : position + written;
      const { bytesWritten } = await this.#run("work", () =>
        this.#handle.write(buffer, written, buffer.length - written, at),
      );
      if (bytesWritten === 0) throw new Error(`write made no progress: ${this.#path}`);
      written += bytesWritten;
    }
  }

  async sync(): Promise<void> {
    await this.#run("work", () => this.#handle.sync());
  }

  stat(): Promise<BigIntStats> {
    return this.#run("work", () => this.#handle.stat());
  }

  /** Close the handle; errors propagate. */
  async close(): Promise<void> {
    await this.#run("cleanup", () => this.#handle.close());
  }

  /** Close after a failure, best-effort and silent. */
  async release(): Promise<void> {
    try {
      await this.close();
    } catch {
      /* the descriptor may already be gone */
    }
  }
}
