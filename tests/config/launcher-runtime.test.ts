import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// The launcher helper is plain ESM because both shell families execute it directly.
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { claimRuntime, isRuntimeOwner, ownsProcess, releaseRuntime, stopRuntime, REPO_ROOT } from "../../scripts/launcher-runtime.mjs";

describe("launcher process identity", () => {
  const identity = { kind: "electron", label: "ZipKit", executable: "ZipKit" };

  it("owns only this repository's ZipKit runtime", () => {
    expect(ownsProcess({
      pid: 10,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 11,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/release/mac-arm64/ZipKit.app/Contents/MacOS/ZipKit`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 12,
      parentPid: 1,
      executablePath: `${REPO_ROOT}\\release\\win-unpacked\\ZipKit.exe`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 13,
      parentPid: 1,
      executablePath: "/another/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      commandLine: "",
    }, identity)).toBe(false);
  });

  it("does not let a stale launcher generation clean up its replacement", async () => {
    const first = `first-${randomUUID()}`;
    const second = `second-${randomUUID()}`;
    try {
      await claimRuntime(first);
      await claimRuntime(second);
      expect(await isRuntimeOwner(first)).toBe(false);
      expect(await isRuntimeOwner(second)).toBe(true);
    } finally {
      await releaseRuntime(second);
    }
  });
});


describe("Windows launcher stop", () => {
  const identity = { kind: "electron", label: "ZipKit", executable: "ZipKit" };
  const owned = (pid: number, parentPid = 1) => ({
    pid, parentPid, executablePath: `${REPO_ROOT}/release/win-unpacked/ZipKit.exe`, commandLine: "",
  });
  const foreign = (pid: number, parentPid = 1) => ({
    pid, parentPid, executablePath: "/another/app.exe", commandLine: "",
  });
  afterEach(() => vi.useRealTimers());

  it("targets the owned tree, excluding the caller and unrelated processes", async () => {
    const processes = vi.fn().mockResolvedValueOnce([
      owned(70001), foreign(70002, 70001), foreign(70003), owned(process.pid, 70004), owned(70004),
    ]).mockResolvedValue([foreign(70003)]);
    const run = vi.fn().mockResolvedValue({});
    await stopRuntime(identity, { platform: "win32", processes, run });
    expect(run.mock.calls).toEqual([["taskkill.exe", ["/PID", "70001", "/T"], { timeout: 5000 }]]);
  });

  it("does nothing when there is no owned runtime", async () => {
    const run = vi.fn();
    await stopRuntime(identity, { platform: "win32", processes: async () => [foreign(70003)], run });
    expect(run).not.toHaveBeenCalled();
  });

  it("forces only an initial root still owned after the grace period", async () => {
    vi.useFakeTimers();
    const initial = [owned(70001), owned(70002), foreign(70003, 70001)];
    // One old PID now belongs to another program; a newly launched ZipKit is
    // outside this stop request. Neither may receive the forced command.
    const current = [owned(70001), foreign(70002), foreign(70003, 70001), owned(70004)];
    const processes = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(current);
    const run = vi.fn().mockRejectedValue(new Error("process already exited"));
    const stopping = stopRuntime(identity, { platform: "win32", processes, run });
    await vi.runAllTimersAsync();
    await stopping;
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["/PID", "70001", "/T"], ["/PID", "70002", "/T"], ["/PID", "70001", "/T", "/F"],
    ]);
  });
});
