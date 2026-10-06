/**
 * The SDK's one file-access boundary. Every filesystem call the scan, write,
 * and extract edges make on a user volume goes through a {@link Volume}, which
 * is where that call's wait is bounded.
 *
 * A filesystem call has no timeout or cancel of its own, and a volume that
 * stalls (a network share that dropped, a removable drive that went away) can
 * leave one pending forever. Node already runs these calls on its libuv
 * threadpool, off the JS thread, so the owner can abandon a stuck one: it races
 * each call against a per-operation budget and the verb's `AbortSignal`, and
 * whichever wins first decides what the verb sees. The abandoned call cannot be
 * killed; its eventual outcome is swallowed, an abandoned `open` has its
 * handle closed when it arrives, and an abandoned temp-file create also has its
 * file removed.
 *
 * Three modes, one per call site kind:
 *
 * - `work` — ordinary reads and writes. Refused once the verb is cancelled or
 *   the volume has already stalled, abandoned on cancel or timeout. A timeout
 *   marks the whole volume stalled, so sibling work (extraction runs entries
 *   concurrently) stops at its next call instead of each waiting its own budget.
 * - `commit` — publication of a finished file (a rename or hard link into the
 *   destination). Refused before it starts under the same rules as `work`, but
 *   once started a cancel no longer abandons it: publication is the commit point,
 *   and abandoning it would leave its outcome unknown. Only the budget does, and
 *   the resulting {@link StallError} says the file may still appear.
 * - `cleanup` — closing handles and removing this run's own temp files after a
 *   failure. Always attempted, bounded by the budget, never stopped by the
 *   cancel or an earlier stall that triggered it.
 *
 * A file handle keeps its descriptor until every call on it settles (Node's
 * `FileHandle.close()` waits for pending operations), so an abandoned read or
 * write can never land on a recycled descriptor that now belongs to another
 * file; releasing a handle with an abandoned call on it closes it in the
 * background instead of waiting.
 */

import type { BigIntStats } from "node:fs";
import * as fsp from "node:fs/promises";
import { AbortError, StallError, toAbortError } from "../errors.js";

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
 *  fake in tests. It carries no timing policy; the {@link Volume} adds that. */
export interface FileSystemPort {
  open(path: string, flags: string): Promise<FileHandlePort>;
  stat(path: string): Promise<BigIntStats>;
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, created: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export const nodeFileSystem: FileSystemPort = {
  open: async (path, flags) => {
    const handle = await fsp.open(path, flags);
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
  mkdir: async (path, recursive) => {
    await fsp.mkdir(path, { recursive });
  },
  rename: (from, to) => fsp.rename(from, to),
  link: (existing, created) => fsp.link(existing, created),
  symlink: (target, path) => fsp.symlink(target, path),
  unlink: (path) => fsp.unlink(path),
  rm: (path) => fsp.rm(path, { force: true }),
  utimes: (path, atime, mtime) => fsp.utimes(path, atime, mtime),
  chmod: (path, mode) => fsp.chmod(path, mode),
};

type Mode = "work" | "commit" | "cleanup";

interface RunOptions<T> {
  /** Called synchronously when the owner stops waiting on the call. */
  onAbandon?: () => void;
  /** Receives the call's value if it arrives after the owner stopped waiting. */
  onLateValue?: (value: T) => void;
}

/**
 * The bounded owner of one verb run's file access. Built per run with the
 * run's budget and signal; see the module comment for the modes.
 */
export class Volume {
  readonly #port: FileSystemPort;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  /** The first stall this run hit; later work and commit calls fail with it. */
  #stall: StallError | undefined;

  constructor(port: FileSystemPort, timeoutMs: number, signal?: AbortSignal) {
    this.#port = port;
    this.#timeoutMs = timeoutMs;
    this.#signal = signal;
  }

  stat(path: string): Promise<BigIntStats> {
    return this.#run("work", "stat", path, () => this.#port.stat(path));
  }

  lstat(path: string): Promise<BigIntStats> {
    return this.#run("work", "lstat", path, () => this.#port.lstat(path));
  }

  realpath(path: string): Promise<string> {
    return this.#run("work", "realpath", path, () => this.#port.realpath(path));
  }

  readlink(path: string): Promise<string> {
    return this.#run("work", "readlink", path, () => this.#port.readlink(path));
  }

  readdir(path: string): Promise<DirEntry[]> {
    return this.#run("work", "readdir", path, () => this.#port.readdir(path));
  }

  mkdir(path: string, recursive = false): Promise<void> {
    return this.#run("work", "mkdir", path, () => this.#port.mkdir(path, recursive));
  }

  symlink(target: string, path: string): Promise<void> {
    return this.#run("work", "symlink", path, () => this.#port.symlink(target, path));
  }

  /** Remove a path as part of the work (not a cleanup of this run's own temp). */
  remove(path: string): Promise<void> {
    return this.#run("work", "remove", path, () => this.#port.rm(path));
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.#run("work", "utimes", path, () => this.#port.utimes(path, atime, mtime));
  }

  /**
   * Give a finished temp the permission mode of the `target` it will replace,
   * so the replace keeps it (content-lifecycle conventions). Best-effort: an
   * absent target, or a volume that cannot hold the mode, changes nothing; a
   * stall or a cancel still ends the run.
   */
  async keepMode(target: string, temp: string): Promise<void> {
    try {
      const mode = Number((await this.stat(target)).mode) & 0o7777;
      await this.#run("work", "chmod", temp, () => this.#port.chmod(temp, mode));
    } catch (err) {
      if (err instanceof StallError || err instanceof AbortError) throw err;
    }
  }

  /** Publish a finished temp file by renaming it over `to`. */
  publishRename(from: string, to: string): Promise<void> {
    return this.#run("commit", "publish", to, () => this.#port.rename(from, to));
  }

  /** Publish a finished temp file by hard-linking it at `to`. */
  publishLink(existing: string, to: string): Promise<void> {
    return this.#run("commit", "publish", to, () => this.#port.link(existing, to));
  }

  /** The identity (`dev:ino`) of a path, or null when it is absent. A cleanup
   *  call: it decides whether a failed publication removes its own claim. */
  async identity(path: string): Promise<string | null> {
    try {
      const st = await this.#run("cleanup", "lstat", path, () => this.#port.lstat(path));
      return `${st.dev}:${st.ino}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Unlink a path this run created, as cleanup. Errors propagate. */
  unlink(path: string): Promise<void> {
    return this.#run("cleanup", "unlink", path, () => this.#port.unlink(path));
  }

  /** Remove a temp file this run created, best-effort: bounded, never stopped
   *  by the cancel, and silent on failure. */
  async discard(path: string): Promise<void> {
    try {
      await this.#run("cleanup", "remove", path, () => this.#port.rm(path));
    } catch {
      /* a temp that cannot be removed stays visible under its `.tmp` name */
    }
  }

  async open(path: string, flags: string): Promise<VolumeFile> {
    const handle = await this.#run("work", "open", path, () => this.#port.open(path, flags), {
      onLateValue: (late) => void late.close().catch(() => {}),
    });
    return new VolumeFile(this, handle, path);
  }

  /**
   * Create this run's own temp file at a fresh, unique path, exclusively. An
   * abandoned create may still make the file when it lands, after the caller
   * has given up and cleaned up; the file is then closed and removed, so a
   * cancelled or stalled run never leaves its temp behind.
   */
  async createTemp(path: string): Promise<VolumeFile> {
    const handle = await this.#run("work", "open", path, () => this.#port.open(path, "wx"), {
      onLateValue: (late) => void late.close().catch(() => {}).then(() => this.discard(path)),
    });
    return new VolumeFile(this, handle, path);
  }

  /** @internal Run one call on an open handle; used by {@link VolumeFile}. */
  runOnHandle<T>(mode: Mode, operation: string, path: string, start: () => Promise<T>, onAbandon: () => void): Promise<T> {
    return this.#run(mode, operation, path, start, { onAbandon });
  }

  #run<T>(mode: Mode, operation: string, path: string, start: () => Promise<T>, options: RunOptions<T> = {}): Promise<T> {
    const signal = this.#signal;
    if (mode !== "cleanup") {
      if (this.#stall) return Promise.reject(this.#stall);
      if (signal?.aborted) return Promise.reject(toAbortError(signal.reason));
    }
    let pending: Promise<T>;
    try {
      pending = start();
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const abandon = (err: Error): void =>
        finish(() => {
          options.onAbandon?.();
          pending.then((value) => options.onLateValue?.(value), () => {});
          reject(err);
        });
      const timer = setTimeout(() => {
        const stall = new StallError(operation, path, this.#timeoutMs, mode === "commit");
        if (mode !== "cleanup") this.#stall ??= stall;
        abandon(stall);
      }, this.#timeoutMs);
      const onAbort = (): void => abandon(toAbortError(signal?.reason));
      if (mode === "work") signal?.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => finish(() => resolve(value)),
        (err: unknown) => finish(() => reject(err)),
      );
    });
  }
}

/** An open file whose every call is bounded by its {@link Volume}. */
export class VolumeFile {
  readonly #volume: Volume;
  readonly #handle: FileHandlePort;
  readonly #path: string;
  /** Set when a call on this handle was abandoned and may still be running. */
  #abandoned = false;

  constructor(volume: Volume, handle: FileHandlePort, path: string) {
    this.#volume = volume;
    this.#handle = handle;
    this.#path = path;
  }

  #run<T>(mode: Mode, operation: string, start: () => Promise<T>): Promise<T> {
    return this.#volume.runOnHandle(mode, operation, this.#path, start, () => {
      this.#abandoned = true;
    });
  }

  /** One positioned read; resolves to the byte count (0 at end of file). */
  async read(buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
    const { bytesRead } = await this.#run("work", "read", () => this.#handle.read(buffer, offset, length, position));
    return bytesRead;
  }

  /** Write all of `buffer`, at `position` or (null) at the current position. */
  async writeAll(buffer: Buffer, position: number | null): Promise<void> {
    let written = 0;
    while (written < buffer.length) {
      const at = position === null ? null : position + written;
      const { bytesWritten } = await this.#run("work", "write", () =>
        this.#handle.write(buffer, written, buffer.length - written, at),
      );
      if (bytesWritten === 0) throw new Error(`write made no progress: ${this.#path}`);
      written += bytesWritten;
    }
  }

  async sync(): Promise<void> {
    await this.#run("work", "sync", () => this.#handle.sync());
  }

  stat(): Promise<BigIntStats> {
    return this.#run("work", "stat", () => this.#handle.stat());
  }

  /** The handle's identity (`dev:ino`). A cleanup call, like
   *  {@link Volume.identity}: it decides whether a failed publication removes
   *  its own claim, so a cancel does not stop it. */
  async identity(): Promise<string> {
    const st = await this.#run("cleanup", "fstat", () => this.#handle.stat());
    return `${st.dev}:${st.ino}`;
  }

  /**
   * Close the handle; bounded, and errors propagate. When a call on this handle
   * was abandoned, the close is left to run in the background: it completes
   * only once that call settles, and waiting for it here would just wait out
   * the same stall again.
   */
  async close(): Promise<void> {
    if (this.#abandoned) {
      void this.#handle.close().catch(() => {});
      return;
    }
    await this.#run("cleanup", "close", () => this.#handle.close());
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
