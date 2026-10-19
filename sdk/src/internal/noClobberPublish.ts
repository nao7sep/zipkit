/** Portable no-clobber publication for a completed same-directory temp file. */

import type { Volume } from "./volume.ts";

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
  /** Own failed-claim cleanup through physical settlement, even after timeout. */
  discard(): Promise<void>;
}

export interface PublishOperations {
  link(tempPath: string, output: string): Promise<void>;
  openRead(path: string): Promise<PublishSource>;
  openExclusive(path: string): Promise<PublishDestination>;
  pathIdentity(path: string): Promise<string | null>;
  unlink(tempPath: string): Promise<void>;
  syncPublished(output: string): Promise<void>;
}

/** The publication operations over the run's bounded {@link Volume}: the link
 *  is a commit call, the copy fallback is ordinary work, and the identity check
 *  and claim removal are cleanup. A failed copy keeps its claim owner through
 *  actual settlement, even after the caller's cleanup wait expires. */
export function volumePublishOperations(volume: Volume, durable = false): PublishOperations {
  return {
    link: (tempPath, output) => volume.publishLink(tempPath, output, durable),
    openRead: async (path) => {
      const file = await volume.open(path, "r");
      return {
        read: async (buffer, offset, length, position) => ({
          bytesRead: await file.read(buffer, offset, length, position),
        }),
        close: () => file.close(),
      };
    },
    openExclusive: async (path) => {
      const file = await volume.claimExclusive(path);
      return {
        write: async (buffer, offset, length) => {
          await file.writeAll(buffer.subarray(offset, offset + length), null);
          return { bytesWritten: length };
        },
        sync: () => file.sync(),
        close: () => file.close(),
        identity: () => file.identity(),
        discard: () => file.discardClaim(),
      };
    },
    pathIdentity: (path) => volume.identity(path),
    unlink: (path) => volume.unlink(path),
    syncPublished: async (path) => { if (durable) await volume.syncPublished(path); },
  };
}

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
  try {
    signal?.throwIfAborted();
    destination = await operations.openExclusive(output);
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
    const claimIdentity = await destination.identity();
    signal?.throwIfAborted();
    if (await operations.pathIdentity(output) !== claimIdentity) throw destinationChanged(output);
  } catch (err) {
    await destination?.discard().catch(() => {});
    // Cleanup uncertainty does not turn cancellation/stall into an ordinary
    // existing-output conflict.
    throw err;
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
  signal: AbortSignal | undefined,
  operations: PublishOperations,
): Promise<void> {
  signal?.throwIfAborted();
  try {
    await operations.link(tempPath, output);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !LINK_UNSUPPORTED.has(code)) throw err;
    await copyExclusive(tempPath, output, signal, operations);
    // The complete copy is now public. A flush failure must leave it intact,
    // and cannot fall back to copying or run the partial-claim cleanup again.
    await operations.syncPublished(output);
  }

  try {
    await operations.unlink(tempPath);
  } catch {
    // Publication already committed. Temp cleanup cannot turn success into a
    // reported failure; the committed output remains authoritative.
  }
}
