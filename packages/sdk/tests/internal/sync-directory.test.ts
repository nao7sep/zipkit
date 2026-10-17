import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncDirectory } from "../../src/internal/sync-directory.js";

const fs = vi.hoisted(() => ({ open: vi.fn(), sync: vi.fn(), close: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open: fs.open }));
beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  fs.open.mockReset().mockResolvedValue({ sync: fs.sync, close: fs.close });
  fs.sync.mockReset().mockResolvedValue(undefined);
  fs.close.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it.each(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"])("permits explicit %s directory-sync incapability and closes the descriptor", async (code) => {
  fs.sync.mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code }));
  await expect(syncDirectory("/directory")).resolves.toBeUndefined();
  expect(fs.close).toHaveBeenCalledOnce();
});
it.each(["EIO", "EACCES", "ENOSPC"])("propagates %s rather than claiming a successful metadata flush", async (code) => {
  const error = Object.assign(new Error("failed"), { code });
  fs.sync.mockRejectedValueOnce(error);
  await expect(syncDirectory("/directory")).rejects.toBe(error);
  expect(fs.close).toHaveBeenCalledOnce();
});
it("does not try to flush a Windows directory through Node's unsupported API", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  await syncDirectory("C:\\directory");
  expect(fs.open).not.toHaveBeenCalled();
});
it("propagates a descriptor close failure after a successful flush", async () => {
  const error = Object.assign(new Error("close failed"), { code: "EIO" });
  fs.close.mockRejectedValueOnce(error);
  await expect(syncDirectory("/directory")).rejects.toBe(error);
});
