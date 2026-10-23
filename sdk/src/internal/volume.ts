/**
 * The SDK's one file-access boundary. Every filesystem call the scan, write,
 * and verify edges make on a user volume goes through a {@link Volume}, which
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
 *   marks the whole volume stalled, so sibling work (verification reads entries
 *   concurrently) stops at its next call instead of each waiting its own budget.
 * - `commit` — publication of a finished file (a rename or hard link into the
 *   destination). Refused before it starts under the same rules as `work`, but
 *   once started a cancel no longer abandons it: publication is the commit point,
 *   and abandoning it would leave its outcome unknown. Only the budget does, and
 *   the resulting `io.stalled` error says the file may still appear.
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
import path from "node:path";
import { stallError, toAbortError, ZipKitError } from "../errors.ts";
import { syncDirectory } from "./sync-directory.ts";

/** A directory entry as the walker needs it. */
export interface DirEntry {
  name: string;
  isDirectory(): boolean;
}

/** An incremental directory reader; each read returns one entry or EOF. */
export interface DirectoryHandlePort {
  read(): Promise<DirEntry | null>;
  close(): Promise<void>;
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
  open(path: string, flags: string, mode?: number): Promise<FileHandlePort>;
  stat(path: string): Promise<BigIntStats>;
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<DirEntry[]>;
  openDirectory(path: string): Promise<DirectoryHandlePort>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, created: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Create a folder and any missing parents; one that exists is left as it is. */
  mkdir(path: string): Promise<string | undefined | void>;
  syncDirectory(path: string): Promise<void>;
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
  openDirectory: (path) => fsp.opendir(path),
  rename: (from, to) => fsp.rename(from, to),
  link: (existing, created) => fsp.link(existing, created),
  unlink: (path) => fsp.unlink(path),
  rm: (path) => fsp.rm(path, { force: true }),
  chmod: (path, mode) => fsp.chmod(path, mode),
  mkdir: (path) => fsp.mkdir(path, { recursive: true }),
  syncDirectory,
};

type Mode = "work" | "commit" | "cleanup";

interface RunOptions<T> {
  /** Called synchronously when the owner stops waiting on the call. */
  onAbandon?: () => void;
  /** Receives the call's value if it arrives after the owner stopped waiting. */
  onLateValue?: (value: T) => void | Promise<unknown>;
}

/**
 * The bounded owner of one verb run's file access. Built per run with the
 * run's budget and signal; see the module comment for the modes.
 */
export class Volume {
  readonly #physical = new Set<Promise<unknown>>();
  readonly #createdParents = new Map<string, string>();
  readonly #port: FileSystemPort;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  /** The first stall this run hit; later work and commit calls fail with it. */
  #stall: ZipKitError<"io.stalled"> | undefined;

  constructor(port: FileSystemPort, timeoutMs: number, signal?: AbortSignal) {
    this.#port = port;
    this.#timeoutMs = timeoutMs;
    this.#signal = signal;
  }
  /** @internal Retain a raw pipeline, including cleanup beyond a bounded wait. */
  trackPhysical<T>(work: Promise<T>): Promise<T> {
    this.#physical.add(work);
    void work.then(() => this.#physical.delete(work), () => this.#physical.delete(work));
    return work;
  }
  /** The run is physically settled only after its late continuations finish. */
  async whenSettled(): Promise<void> {
    while (this.#physical.size > 0) await Promise.allSettled([...this.#physical]);
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

  /** Stream directory metadata without retaining a whole directory listing. */
  async *directoryEntries(path: string): AsyncGenerator<DirEntry> {
    const handle = await this.#run("work", "readdir", path, () => this.#port.openDirectory(path), {
      onLateValue: (late) => late.close(),
    });
    let pendingRead: Promise<DirEntry | null> | undefined;
    let failed = false;
    try {
      for (;;) {
        const entry = await this.#run("work", "readdir", path, () => {
          pendingRead = handle.read();
          return pendingRead;
        });
        if (entry === null) return;
        yield entry;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await this.#run("cleanup", "close", path, async () => {
          // Node's Dir.close refuses concurrent reads. Retain the actual read,
          // including after its caller timed out, until closing is safe.
          await pendingRead?.catch(() => {});
          await handle.close();
        });
      } catch (error) {
        // Preserve a read failure or cancellation; the physical close pipeline
        // stays owned by #run even when its cleanup wait expires.
        if (!failed) throw error;
      }
    }
  }

  /** Create a folder with any missing parents, as ordinary work. */
  async mkdir(directory: string): Promise<void> {
    await this.#run("work", "mkdir", directory, async () => {
      const first = await this.#port.mkdir(directory);
      if (first !== undefined) this.#createdParents.set(directory, path.dirname(first));
    });
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.#run("work", "chmod", path, () => this.#port.chmod(path, mode));
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
  publishRename(from: string, to: string, durable = false): Promise<void> {
    return this.#run("commit", "publish", to, async () => {
      await this.#port.rename(from, to);
      if (durable) await this.#syncPublication(to);
    });
  }

  /** Publish a finished temp file by hard-linking it at `to`. */
  publishLink(existing: string, to: string, durable = false): Promise<void> {
    return this.#run("commit", "publish", to, async () => {
      await this.#port.link(existing, to);
      if (durable) await this.#syncPublication(to);
    });
  }

  async #syncPublication(output: string): Promise<void> {
    try {
      let directory = path.dirname(output);
      const ancestor = this.#createdParents.get(directory);
      await this.#port.syncDirectory(directory);
      // Persist each newly created directory's link, up to its existing parent.
      while (ancestor !== undefined && directory !== ancestor) {
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
        await this.#port.syncDirectory(directory);
      }
    }
    catch (cause) {
      throw new ZipKitError("write.durability", `Archive published but its save could not be confirmed: ${output}`, { cause, subject: output, effect: "unknown" });
    }
  }

  /** Unlink a path this run created, as cleanup. Errors propagate. */
  unlink(path: string): Promise<void> {
    return this.#run("cleanup", "unlink", path, () => this.#port.unlink(path));
  }

  /** Remove a temp file this run created, best-effort: bounded, never stopped
   *  by the cancel, and silent on failure. Whether it is gone afterwards; one
   *  that cannot be removed stays visible under its `.tmp` name. */
  async discard(path: string): Promise<boolean> {
    try {
      await this.#run("cleanup", "remove", path, () => this.#port.rm(path));
      return true;
    } catch (err) {
      return (err as { code?: unknown }).code === "ENOENT";
    }
  }

  async open(path: string, flags: string): Promise<VolumeFile> {
    const handle = await this.#run("work", "open", path, () => this.#port.open(path, flags), {
      onLateValue: (late) => late.close(),
    });
    return new VolumeFile(this, handle, path);
  }

  /**
   * Create this run's own temp file at a fresh, unique path, exclusively. An
   * abandoned create may still make the file when it lands, after the caller
   * has given up and cleaned up; the file is then closed and removed, so a
   * cancellation retains ownership through attempted late cleanup. A failed
   * close or removal can leave the temp behind rather than guessing it is gone.
   */
  async createTemp(path: string): Promise<VolumeFile> {
    const handle = await this.#run("work", "open", path, () => this.#port.open(path, "wx", 0o600), {
      onLateValue: async (late) => { await late.close(); await this.#port.rm(path); },
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
    let abandoned = false;
    // Keep one physical token across a late result and its cleanup continuation.
    void this.trackPhysical(pending.then((value) => abandoned ? options.onLateValue?.(value) : undefined, () => {}));
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
          abandoned = true;
          reject(err);
        });
      const timer = setTimeout(() => {
        const stall = stallError(operation, path, this.#timeoutMs, mode === "commit");
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

  /**
   * Close the handle; bounded, and errors propagate. When a call on this handle
   * was abandoned, the close is left to run in the background: it completes
   * only once that call settles, and waiting for it here would just wait out
   * the same stall again.
   */
  async close(): Promise<void> {
    if (this.#abandoned) {
      void this.#volume.trackPhysical(this.#handle.close()).catch(() => {});
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
