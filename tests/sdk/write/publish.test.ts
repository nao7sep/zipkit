import { describe, expect, it, vi } from "vitest";
import {
  publishNoOverwrite,
  type PublishDestination,
  type PublishOperations,
  type PublishSource,
} from "../../../src/sdk/internal/noClobberPublish.js";

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function memoryOperations(
  sourceBytes: Buffer,
  overrides: Partial<PublishOperations> = {},
): { operations: PublishOperations; published: Buffer[]; readLengths: number[] } {
  const published: Buffer[] = [];
  const readLengths: number[] = [];
  const source: PublishSource = {
    read: vi.fn(async (buffer, offset, length, position) => {
      readLengths.push(length);
      const bytesRead = Math.min(length, Math.max(0, sourceBytes.length - position));
      sourceBytes.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const destination: PublishDestination = {
    write: vi.fn(async (buffer, offset, length) => {
      published.push(Buffer.from(buffer.subarray(offset, offset + length)));
      return { bytesWritten: length };
    }),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    published,
    readLengths,
    operations: {
      link: vi.fn().mockResolvedValue(undefined),
      openRead: vi.fn().mockResolvedValue(source),
      openExclusive: vi.fn().mockResolvedValue(destination),
      unlink: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

describe("portable no-overwrite publication", () => {
  it("falls back to a bounded exclusive copy when the filesystem rejects hard links", async () => {
    const bytes = Buffer.alloc(600_000, 0x5a);
    const fixture = memoryOperations(bytes, { link: vi.fn().mockRejectedValue(failure("EPERM")) });

    await publishNoOverwrite("temp", "out", undefined, fixture.operations);

    expect(fixture.operations.openExclusive).toHaveBeenCalledWith("out");
    expect(Buffer.concat(fixture.published)).toEqual(bytes);
    expect(Math.max(...fixture.readLengths)).toBeLessThanOrEqual(256 * 1024);
    expect(fixture.operations.unlink).toHaveBeenCalledWith("temp");
  });

  it("preserves a concurrent destination winner in the fallback path", async () => {
    const exists = failure("EEXIST");
    const fixture = memoryOperations(Buffer.from("content"), {
      link: vi.fn().mockRejectedValue(failure("ENOTSUP")),
      openExclusive: vi.fn().mockRejectedValue(exists),
    });

    await expect(
      publishNoOverwrite("temp", "out", undefined, fixture.operations),
    ).rejects.toBe(exists);
    expect(fixture.operations.unlink).not.toHaveBeenCalled();
  });

  it("removes its exclusively claimed partial output when cancellation interrupts the copy", async () => {
    const controller = new AbortController();
    const fixture = memoryOperations(Buffer.alloc(600_000), {
      link: vi.fn().mockRejectedValue(failure("ENOTSUP")),
    });
    const source = await fixture.operations.openRead("unused");
    vi.mocked(fixture.operations.openRead).mockResolvedValue({
      ...source,
      read: vi.fn(async (buffer, offset, length, position) => {
        const result = await source.read(buffer, offset, length, position);
        controller.abort();
        return result;
      }),
    });

    await expect(
      publishNoOverwrite("temp", "out", controller.signal, fixture.operations),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(fixture.operations.unlink).toHaveBeenCalledWith("out");
    expect(fixture.operations.unlink).not.toHaveBeenCalledWith("temp");
    expect(fixture.published).toHaveLength(0);
  });

  it("removes its exclusively claimed partial output when a later write fails", async () => {
    const writeFailure = failure("EIO");
    const fixture = memoryOperations(Buffer.alloc(600_000), {
      link: vi.fn().mockRejectedValue(failure("ENOTSUP")),
    });
    const destination = await fixture.operations.openExclusive("unused");
    vi.mocked(fixture.operations.openExclusive).mockResolvedValue({
      ...destination,
      write: vi.fn().mockRejectedValue(writeFailure),
    });

    await expect(
      publishNoOverwrite("temp", "out", undefined, fixture.operations),
    ).rejects.toBe(writeFailure);
    expect(fixture.operations.unlink).toHaveBeenCalledWith("out");
    expect(fixture.operations.unlink).not.toHaveBeenCalledWith("temp");
  });

  it("does not mask a real hard-link I/O failure with a copy attempt", async () => {
    const io = failure("EIO");
    const fixture = memoryOperations(Buffer.from("content"), {
      link: vi.fn().mockRejectedValue(io),
    });

    await expect(
      publishNoOverwrite("temp", "out", undefined, fixture.operations),
    ).rejects.toBe(io);
    expect(fixture.operations.openExclusive).not.toHaveBeenCalled();
  });
});
