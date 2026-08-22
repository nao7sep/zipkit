import { describe, expect, it, vi } from "vitest";
import {
  publishNoOverwrite,
  type PublishOperations,
} from "../../../src/sdk/internal/noClobberPublish.js";

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function operations(overrides: Partial<PublishOperations> = {}): PublishOperations {
  return {
    link: vi.fn().mockResolvedValue(undefined),
    copyExclusive: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("portable no-overwrite publication", () => {
  it("falls back to an exclusive copy when the filesystem rejects hard links", async () => {
    const ops = operations({ link: vi.fn().mockRejectedValue(failure("EPERM")) });

    await publishNoOverwrite("temp", "out", ops);

    expect(ops.copyExclusive).toHaveBeenCalledWith("temp", "out");
    expect(ops.unlink).toHaveBeenCalledWith("temp");
  });

  it("preserves a concurrent destination winner in the fallback path", async () => {
    const exists = failure("EEXIST");
    const ops = operations({
      link: vi.fn().mockRejectedValue(failure("ENOTSUP")),
      copyExclusive: vi.fn().mockRejectedValue(exists),
    });

    await expect(publishNoOverwrite("temp", "out", ops)).rejects.toBe(exists);
    expect(ops.unlink).not.toHaveBeenCalled();
  });

  it("does not mask a real hard-link I/O failure with a copy attempt", async () => {
    const io = failure("EIO");
    const ops = operations({ link: vi.fn().mockRejectedValue(io) });

    await expect(publishNoOverwrite("temp", "out", ops)).rejects.toBe(io);
    expect(ops.copyExclusive).not.toHaveBeenCalled();
  });
});
