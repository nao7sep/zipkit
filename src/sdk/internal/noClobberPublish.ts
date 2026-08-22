/** Portable no-clobber publication for a completed same-directory temp file. */

import { link, lstat, open, unlink } from "node:fs/promises";

const LINK_UNSUPPORTED = new Set(["EACCES", "EMLINK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);

export interface PublishSource {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface PublishDestination {
  write(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
  identity(): Promise<string>;
}

export interface PublishOperations {
  link(tempPath: string, output: string): Promise<void>;
  openRead(path: string): Promise<PublishSource>;
  openExclusive(path: string): Promise<PublishDestination>;
  pathIdentity(path: string): Promise<string | null>;
  unlink(tempPath: string): Promise<void>;
}

const realOperations: PublishOperations = {
  link,
  openRead: (path) => open(path, "r"),
  openExclusive: async (path) => {
    const handle = await open(path, "wx");
    return {
      write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
      sync: () => handle.sync(),
      close: () => handle.close(),
      identity: async () => {
        const stat = await handle.stat({ bigint: true });
        return `${stat.dev}:${stat.ino}`;
      },
    };
  },
  pathIdentity: async (path) => {
    try {
      const stat = await lstat(path, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  unlink,
};

const COPY_CHUNK_BYTES = 256 * 1024;

async function copyExclusive(
  tempPath: string,
  output: string,
  signal: AbortSignal | undefined,
  operations: PublishOperations,
): Promise<void> {
  signal?.throwIfAborted();
  const source = await operations.openRead(tempPath);
  let destination: PublishDestination | null = null;
  let claimIdentity: string | null = null;
  let committed = false;
  try {
    signal?.throwIfAborted();
    destination = await operations.openExclusive(output);
    claimIdentity = await destination.identity();
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let readPosition = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, readPosition);
      if (bytesRead === 0) break;
      readPosition += bytesRead;

      let written = 0;
      while (written < bytesRead) {
        signal?.throwIfAborted();
        const result = await destination.write(buffer, written, bytesRead - written, null);
        if (result.bytesWritten === 0) throw new Error(`Could not publish ${output}: write made no progress`);
        written += result.bytesWritten;
      }
    }
    signal?.throwIfAborted();
    await destination.sync();
    signal?.throwIfAborted();
    await destination.close();
    destination = null;
    signal?.throwIfAborted();
    if (await operations.pathIdentity(output) !== claimIdentity) throw destinationChanged(output);
    committed = true;
  } catch (err) {
    if (destination) await destination.close().catch(() => {});
    let failure = err;
    if (claimIdentity !== null && !committed) {
      const currentIdentity = await operations.pathIdentity(output).catch(() => null);
      if (currentIdentity === claimIdentity) {
        await operations.unlink(output).catch(() => {});
      } else if (currentIdentity !== null) {
        failure = destinationChanged(output);
      }
    }
    throw failure;
  } finally {
    await source.close().catch(() => {});
  }
}

function destinationChanged(output: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Destination changed during exclusive publication: ${output}`), {
    code: "EEXIST",
  });
}

/**
 * Publish without replacing an existing destination. Hard linking is the atomic
 * same-inode path. Filesystems without hard-link support fall back to an
 * exclusive, bounded, signal-aware copy: the target name is still claimed with
 * O_EXCL semantics, so a concurrent winner is preserved rather than overwritten.
 * A failed or cancelled copy removes only its own partial claim. The completed
 * temp remains the recovery source until either publication path succeeds.
 */
export async function publishNoOverwrite(
  tempPath: string,
  output: string,
  signal?: AbortSignal,
  operations: PublishOperations = realOperations,
): Promise<void> {
  signal?.throwIfAborted();
  try {
    await operations.link(tempPath, output);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !LINK_UNSUPPORTED.has(code)) throw err;
    await copyExclusive(tempPath, output, signal, operations);
  }

  try {
    await operations.unlink(tempPath);
  } catch {
    // Publication already committed. Temp cleanup cannot turn success into a
    // reported failure; the committed output remains authoritative.
  }
}
