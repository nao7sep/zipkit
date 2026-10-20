import { describe, expect, it, vi } from "vitest";
import { publishNoOverwrite, type PublishOperations } from "../../src/internal/noClobberPublish.ts";

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function operations(overrides: Partial<PublishOperations> = {}): PublishOperations {
  return {
    link: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("no-overwrite publication", () => {
  it("links the temp into place and removes the temp's own name", async () => {
    const ops = operations();
    expect(await publishNoOverwrite("temp", "out", undefined, ops)).toBe("published");
    expect(ops.link).toHaveBeenCalledWith("temp", "out");
    expect(ops.unlink).toHaveBeenCalledWith("temp");
    expect(ops.rename).not.toHaveBeenCalled();
  });

  it("reports a taken name, leaving the temp for the caller", async () => {
    const ops = operations({ link: vi.fn().mockRejectedValue(failure("EEXIST")) });
    expect(await publishNoOverwrite("temp", "out", undefined, ops)).toBe("exists");
    expect(ops.unlink).not.toHaveBeenCalled();
    expect(ops.rename).not.toHaveBeenCalled();
  });

  it.each(["ENOTSUP", "EPERM", "EOPNOTSUPP", "ENOSYS"])("without hard links (%s), renames the staged temp in once the name is free", async (code) => {
    const ops = operations({ link: vi.fn().mockRejectedValue(failure(code)) });
    expect(await publishNoOverwrite("temp", "out", undefined, ops)).toBe("published");
    expect(ops.exists).toHaveBeenCalledWith("out");
    expect(ops.rename).toHaveBeenCalledWith("temp", "out");
    expect(ops.unlink).not.toHaveBeenCalled();
  });

  it("without hard links, reports a taken name instead of renaming over it", async () => {
    const ops = operations({ link: vi.fn().mockRejectedValue(failure("ENOTSUP")), exists: vi.fn().mockResolvedValue(true) });
    expect(await publishNoOverwrite("temp", "out", undefined, ops)).toBe("exists");
    expect(ops.rename).not.toHaveBeenCalled();
  });

  it("does not mask a real link failure with a rename", async () => {
    const io = failure("EIO");
    const ops = operations({ link: vi.fn().mockRejectedValue(io) });
    await expect(publishNoOverwrite("temp", "out", undefined, ops)).rejects.toBe(io);
    expect(ops.rename).not.toHaveBeenCalled();
  });

  it("stops before the rename when cancelled during the name check", async () => {
    const controller = new AbortController();
    const ops = operations({
      link: vi.fn().mockRejectedValue(failure("ENOTSUP")),
      exists: vi.fn(async () => { controller.abort(); return false; }),
    });
    await expect(publishNoOverwrite("temp", "out", controller.signal, ops)).rejects.toMatchObject({ code: "operation.cancelled" });
    expect(ops.rename).not.toHaveBeenCalled();
  });

  it("keeps a published archive when the temp's removal fails", async () => {
    const ops = operations({ unlink: vi.fn().mockRejectedValue(failure("EIO")) });
    expect(await publishNoOverwrite("temp", "out", undefined, ops)).toBe("published");
  });
});
