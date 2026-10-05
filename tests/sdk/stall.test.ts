/**
 * Stalled volumes: every filesystem call the scan, write, and extract edges make
 * is bounded by the SDK's per-operation budget and answers to the run's signal.
 * A fake filesystem holds chosen calls forever (a dropped network share, a
 * removed drive); each edge must fail with a `StallError` naming the path once
 * the budget elapses, or with an `AbortError` on cancel, clean up its temp
 * output, and — when the held call is finally let through — publish nothing.
 *
 * Time is fake and only the test moves it, so no real call is ever expired by a
 * slow machine. A test advances the clock only while no unheld call is in
 * flight (`untilHeld`), so the only budgets that can expire are the held calls'.
 * Cancels are sent once the run is held, never on a timer.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pLimit from "p-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbortError, PolicyError, StallError, ZipKit } from "../../src/sdk/index.js";
import { extractArchive } from "../../src/sdk/extract/extract.js";
import { matcherFor } from "../../src/sdk/filter/match.js";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../src/sdk/internal/volume.js";
import { createLogger } from "../../src/sdk/log/logger.js";
import { resolvePolicy } from "../../src/sdk/policy.js";
import { scan } from "../../src/sdk/scan/scan.js";
import { writeArchive } from "../../src/sdk/write/write.js";
import { stallingFileSystem, type StallingFileSystem } from "../helpers/volume.js";

const BUDGET = 150;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-stall-"));
  // Only the timers: real I/O, setImmediate and the clock stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

/** One turn of the event loop, after pending I/O callbacks and microtasks. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Wait until `count` calls are held and no other call is in flight. */
async function untilHeld(fs: StallingFileSystem, count = 1): Promise<void> {
  while (fs.stalled.length < count || fs.inFlight > 0) await tick();
}

/** A promise expected to reject, with its settlement observable before awaiting. */
function expectFailure(run: Promise<unknown>): { settled: () => boolean; error: Promise<unknown> } {
  let settled = false;
  const error = run.then(
    () => {
      settled = true;
      throw new Error("expected the call to fail");
    },
    (err: unknown) => {
      settled = true;
      return err;
    },
  );
  return { settled: () => settled, error };
}

async function makeTree(files = 2): Promise<string> {
  const proj = path.join(dir, "proj");
  await mkdir(path.join(proj, "sub"), { recursive: true });
  for (let i = 0; i < files; i++) await writeFile(path.join(proj, `f${i}.txt`), `content ${i}`);
  await writeFile(path.join(proj, "sub", "b.txt"), "world");
  return proj;
}

function runScan(proj: string, volume: Volume, signal?: AbortSignal) {
  const policy = resolvePolicy(undefined, {});
  return scan({ inputs: [proj] }, policy, {
    matcher: matcherFor(policy),
    limit: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    logger: createLogger(),
    signal,
    volume,
  });
}

/** Files left in a directory that are not the given names (temps, partials). */
function leftovers(where: string, expected: string[] = []): string[] {
  return readdirSync(where).filter((name) => !expected.includes(name));
}

describe("the time budget", () => {
  it("is validated at the SDK boundary", () => {
    expect(() => new ZipKit({ ioTimeoutMs: 0 })).toThrow(PolicyError);
    expect(() => new ZipKit({ ioTimeoutMs: 1.5 })).toThrow(PolicyError);
    expect(() => new ZipKit({ ioTimeoutMs: 2 ** 31 })).toThrow(PolicyError);
    expect(() => new ZipKit({ ioTimeoutMs: 5_000 })).not.toThrow();
  });

  it("bounds each operation, not the whole run: a slow but moving volume finishes", async () => {
    const proj = path.join(dir, "slow");
    await mkdir(proj);
    await writeFile(path.join(proj, "big.bin"), Buffer.alloc(8 * 1024, 7));
    const plan = await new ZipKit().plan({ inputs: [proj], output: path.join(dir, "slow.zip") });
    // Every read takes a third of the budget; the file takes eight reads, so the
    // run as a whole outlasts the budget several times over.
    let elapsed = 0;
    const slow: FileSystemPort = {
      ...nodeFileSystem,
      open: async (p, flags) => {
        const handle = await nodeFileSystem.open(p, flags);
        return {
          ...handle,
          read: async (...args) => {
            await Promise.resolve(); // past the Volume arming this read's budget
            vi.advanceTimersByTime(BUDGET / 3);
            elapsed += BUDGET / 3;
            return handle.read(...args);
          },
          write: (...args) => handle.write(...args),
          sync: () => handle.sync(),
          stat: () => handle.stat(),
          close: () => handle.close(),
        };
      },
    };
    const result = await writeArchive(plan, {
      logger: createLogger(),
      chunkSize: 1024,
      volume: new Volume(slow, BUDGET),
    });
    expect(result.written).toBe(true);
    expect(existsSync(path.join(dir, "slow.zip"))).toBe(true);
    expect(elapsed).toBeGreaterThan(2 * BUDGET);
  });
});

describe("scan on a stalled source", () => {
  it("fails when the budget elapses with a StallError naming the directory", async () => {
    const proj = await makeTree();
    const sub = path.join(proj, "sub");
    const fs = stallingFileSystem((op, p) => op === "readdir" && p === sub);

    const run = expectFailure(runScan(proj, new Volume(fs.port, BUDGET)));
    await untilHeld(fs);
    vi.advanceTimersByTime(BUDGET - 1);
    await tick();
    expect(run.settled()).toBe(false);
    vi.advanceTimersByTime(1);
    const err = await run.error;

    expect(err).toBeInstanceOf(StallError);
    expect(err).toMatchObject({ errorType: "stall", code: "io.stalled", operation: "readdir", path: sub });
    await fs.release();
  });

  it("fails with an AbortError when cancelled during the stall", async () => {
    const proj = await makeTree();
    const fs = stallingFileSystem((op) => op === "readdir");
    const controller = new AbortController();

    const run = expectFailure(runScan(proj, new Volume(fs.port, 60_000, controller.signal), controller.signal));
    await untilHeld(fs);
    controller.abort();

    expect(await run.error).toBeInstanceOf(AbortError);
    await fs.release();
  });
});

describe("write on a stalled volume", () => {
  async function planFor(proj: string, output: string) {
    return new ZipKit().plan({ inputs: [proj], output });
  }

  it("fails when the budget elapses on a stalled source read, and the late read publishes nothing", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const source = path.join(proj, "f0.txt");
    const fs = stallingFileSystem((op, p) => op === "read" && p === source);

    const run = expectFailure(
      writeArchive(plan, { logger: createLogger(), chunkSize: 65536, volume: new Volume(fs.port, BUDGET) }),
    );
    await untilHeld(fs);
    vi.advanceTimersByTime(BUDGET);
    const err = await run.error;

    expect(err).toMatchObject({ errorType: "stall", operation: "read", path: source, committing: false });
    expect(leftovers(dir, ["proj"])).toEqual([]); // no archive, no temp

    await fs.release();
    await tick();
    expect(leftovers(dir, ["proj"])).toEqual([]);
  });

  it("fails when the budget elapses on a stalled destination write, and removes the temp", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const fs = stallingFileSystem((op, p) => op === "write" && p.endsWith(".tmp"));

    const run = expectFailure(
      writeArchive(plan, { logger: createLogger(), chunkSize: 65536, volume: new Volume(fs.port, BUDGET) }),
    );
    await untilHeld(fs);
    vi.advanceTimersByTime(BUDGET);
    const err = await run.error;

    expect(err).toMatchObject({ errorType: "stall", operation: "write" });
    expect((err as StallError).path).toMatch(/out-.+\.tmp$/);
    expect(leftovers(dir, ["proj"])).toEqual([]);

    await fs.release();
    await tick();
    expect(leftovers(dir, ["proj"])).toEqual([]);
  });

  it("fails with an AbortError when cancelled during a stalled read", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const fs = stallingFileSystem((op, p) => op === "read" && p.endsWith("f0.txt"));
    const controller = new AbortController();

    const run = expectFailure(
      writeArchive(plan, {
        logger: createLogger(),
        chunkSize: 65536,
        signal: controller.signal,
        volume: new Volume(fs.port, 60_000, controller.signal),
      }),
    );
    await untilHeld(fs);
    controller.abort();

    expect(await run.error).toBeInstanceOf(AbortError);
    expect(leftovers(dir, ["proj"])).toEqual([]);
    await fs.release();
  });

  it("leaves no temp when cancelled while the archive temp is being created", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const fs = stallingFileSystem((op, p) => op === "open" && p.endsWith(".tmp"));
    const controller = new AbortController();

    const run = expectFailure(
      writeArchive(plan, {
        logger: createLogger(),
        chunkSize: 65536,
        signal: controller.signal,
        volume: new Volume(fs.port, 60_000, controller.signal),
      }),
    );
    await untilHeld(fs);
    controller.abort();
    expect(await run.error).toBeInstanceOf(AbortError);

    // The abandoned create lands now and makes the file; the Volume removes it.
    await fs.release();
    while (leftovers(dir, ["proj"]).length > 0) await tick();
  });

  it("lets a started publication run to its budget despite a cancel, and says it may still land", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const fs = stallingFileSystem((op, p) => op === "link" && p === output);
    const controller = new AbortController();
    const volume = new Volume(fs.port, BUDGET, controller.signal);

    const run = expectFailure(
      writeArchive(plan, { logger: createLogger(), chunkSize: 65536, signal: controller.signal, volume }),
    );
    await untilHeld(fs);
    controller.abort();
    await tick();
    expect(run.settled()).toBe(false);
    vi.advanceTimersByTime(BUDGET);
    const err = await run.error;

    expect(err).toMatchObject({ errorType: "stall", operation: "publish", path: output, committing: true });
    expect((err as StallError).message).toContain("may still complete");
    await fs.release();
  });
});

describe("extract on a stalled volume", () => {
  async function archiveOf(files: number): Promise<string> {
    const proj = await makeTree(files);
    const archive = path.join(dir, "in.zip");
    await new ZipKit().create({ inputs: [proj], output: archive });
    return archive;
  }

  function runExtract(archive: string, dest: string, volume: Volume, signal?: AbortSignal) {
    return extractArchive(
      { archive, dest },
      { limit: pLimit(4), logger: createLogger(), chunkSize: 65536, signal, volume },
    );
  }

  /** Extracted files and staged temps under `dest`. */
  function written(dest: string): string[] {
    return existsSync(dest)
      ? readdirSync(dest, { recursive: true })
          .map(String)
          .filter((n) => n.endsWith(".txt") || n.includes(".zk-"))
      : [];
  }

  it("fails when the budget elapses while the archive stops responding", async () => {
    const archive = await archiveOf(2);
    const dest = path.join(dir, "out");
    const fs = stallingFileSystem((op, p) => op === "read" && p === archive);

    const run = expectFailure(runExtract(archive, dest, new Volume(fs.port, BUDGET)));
    await untilHeld(fs);
    vi.advanceTimersByTime(BUDGET);

    expect(await run.error).toMatchObject({ errorType: "stall", operation: "read", path: archive });
    await fs.release();
  });

  it("stops every concurrent entry once the destination stalls, leaves no temp, and publishes nothing late", async () => {
    // Forty entries four at a time: were each entry to wait out its own budget
    // the run would take ten budgets; one elapsed budget must end them all.
    const archive = await archiveOf(40);
    const dest = path.join(dir, "out");
    const fs = stallingFileSystem((op, p) => op === "write" && path.basename(p).startsWith(".zk-"));

    const run = expectFailure(runExtract(archive, dest, new Volume(fs.port, BUDGET)));
    await untilHeld(fs);
    vi.advanceTimersByTime(BUDGET);
    const err = await run.error;

    expect(err).toMatchObject({ errorType: "stall", operation: "write" });
    expect(written(dest)).toEqual([]);

    await fs.release();
    await tick();
    expect(written(dest)).toEqual([]);
  });

  it("fails with an AbortError when cancelled during a stalled write", async () => {
    const archive = await archiveOf(2);
    const dest = path.join(dir, "out");
    const fs = stallingFileSystem((op, p) => op === "write" && path.basename(p).startsWith(".zk-"));
    const controller = new AbortController();

    const run = expectFailure(
      runExtract(archive, dest, new Volume(fs.port, 60_000, controller.signal), controller.signal),
    );
    await untilHeld(fs);
    controller.abort();

    expect(await run.error).toBeInstanceOf(AbortError);
    expect(written(dest)).toEqual([]);
    await fs.release();
  });

  it("leaves no temp when cancelled while an entry's temp is being created", async () => {
    const archive = await archiveOf(2);
    const dest = path.join(dir, "out");
    const fs = stallingFileSystem((op, p) => op === "open" && path.basename(p).startsWith(".zk-"));
    const controller = new AbortController();

    const run = expectFailure(
      runExtract(archive, dest, new Volume(fs.port, 60_000, controller.signal), controller.signal),
    );
    await untilHeld(fs);
    controller.abort();
    expect(await run.error).toBeInstanceOf(AbortError);

    // The abandoned creates land now and make their files; the Volume removes them.
    await fs.release();
    while (written(dest).length > 0) await tick();
  });
});
