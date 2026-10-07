import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { nodeFileSystem, Volume } from "../../../src/sdk/internal/volume.js";

it("a late temp open whose raw close stalls still attempts bounded discard and retries after actual close", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-late-close-"));
  const file = path.join(root, "stage.tmp");
  let releaseOpen!: () => void;
  let releaseClose!: () => void;
  let opened!: () => void;
  let closing!: () => void;
  let discarded!: () => void;
  let cleanupFinished!: () => void;
  const openSeen = new Promise<void>((resolve) => { opened = resolve; });
  const closeSeen = new Promise<void>((resolve) => { closing = resolve; });
  const discardSeen = new Promise<void>((resolve) => { discarded = resolve; });
  const cleanupSeen = new Promise<void>((resolve) => { cleanupFinished = resolve; });
  const openHeld = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const closeHeld = new Promise<void>((resolve) => { releaseClose = resolve; });
  let discards = 0;
  let physicallyClosed = false;
  const owner = new Volume({
    ...nodeFileSystem,
    open: async (...args) => {
      opened();
      await openHeld;
      const handle = await nodeFileSystem.open(...args);
      return { ...handle, close: async () => { closing(); await closeHeld; await handle.close(); physicallyClosed = true; } };
    },
    rm: async (path) => {
      try { await nodeFileSystem.rm(path); } finally {
        discards++; discarded();
        if (physicallyClosed) cleanupFinished();
      }
    },
  }, 50);
  const settleCleanup = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cleanupSeen, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("physical temp cleanup did not settle")), 1_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  let work: ReturnType<Volume["createTemp"]> | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    work = owner.createTemp(file);
    const failed = expect(work).rejects.toMatchObject({ name: "StallError" });
    await openSeen;
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    releaseOpen();
    await closeSeen;
    expect(existsSync(file)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    await discardSeen;
    expect(discards).toBe(1);
    releaseClose();
    vi.useRealTimers();
    await settleCleanup();
    expect(discards).toBe(2);
    expect(existsSync(file)).toBe(false);
  } finally {
    releaseOpen(); releaseClose();
    vi.useRealTimers();
    if (work) {
      // Even an early assertion failure must join physical descriptor cleanup.
      await work.then(async (handle) => { await handle.release(); await owner.discard(file); }, () => {});
      await settleCleanup();
    }
    await rm(root, { recursive: true, force: true });
  }
});
