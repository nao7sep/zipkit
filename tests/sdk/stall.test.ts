/**
 * Stalled volumes: every filesystem call the scan, write, and extract edges make
 * is bounded by the SDK's per-operation budget and answers to the run's signal.
 * A fake filesystem holds chosen calls forever (a dropped network share, a
 * removed drive); each edge must fail with a `StallError` naming the path within
 * the budget, or with an `AbortError` promptly on cancel, clean up its temp
 * output, and — when the held call is finally let through — publish nothing.
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
import { stallingFileSystem } from "../helpers/volume.js";

const BUDGET = 150;
/** Slack for timers and the event loop on a loaded CI machine. */
const SLACK = 1000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zipkit-stall-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Settle a promise that is expected to reject; report the error and how long it took. */
async function failure(run: Promise<unknown>): Promise<{ err: unknown; ms: number }> {
  const start = performance.now();
  try {
    await run;
  } catch (err) {
    return { err, ms: performance.now() - start };
  }
  throw new Error("expected the call to fail");
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
    const slow: FileSystemPort = {
      ...nodeFileSystem,
      open: async (p, flags) => {
        const handle = await nodeFileSystem.open(p, flags);
        return {
          ...handle,
          read: async (...args) => {
            await delay(BUDGET / 3);
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
  });
});

describe("scan on a stalled source", () => {
  it("fails within the budget with a StallError naming the directory", async () => {
    const proj = await makeTree();
    const sub = path.join(proj, "sub");
    const fs = stallingFileSystem((op, p) => op === "readdir" && p === sub);

    const { err, ms } = await failure(runScan(proj, new Volume(fs.port, BUDGET)));

    expect(err).toBeInstanceOf(StallError);
    expect(err).toMatchObject({ errorType: "stall", code: "io.stalled", operation: "readdir", path: sub });
    expect(ms).toBeGreaterThanOrEqual(BUDGET - 20);
    expect(ms).toBeLessThan(BUDGET + SLACK);
    fs.release();
  });

  it("fails promptly with an AbortError when cancelled during the stall", async () => {
    const proj = await makeTree();
    const fs = stallingFileSystem((op) => op === "readdir");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const { err, ms } = await failure(runScan(proj, new Volume(fs.port, 60_000, controller.signal), controller.signal));

    expect(err).toBeInstanceOf(AbortError);
    expect(ms).toBeLessThan(SLACK);
    fs.release();
  });
});

describe("write on a stalled volume", () => {
  async function planFor(proj: string, output: string) {
    return new ZipKit().plan({ inputs: [proj], output });
  }

  it("fails within the budget when a source read stalls, and the late read publishes nothing", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const source = path.join(proj, "f0.txt");
    const fs = stallingFileSystem((op, p) => op === "read" && p === source);

    const { err, ms } = await failure(
      writeArchive(plan, { logger: createLogger(), chunkSize: 65536, volume: new Volume(fs.port, BUDGET) }),
    );

    expect(err).toMatchObject({ errorType: "stall", operation: "read", path: source, committing: false });
    expect(ms).toBeLessThan(BUDGET + SLACK);
    expect(leftovers(dir, ["proj"])).toEqual([]); // no archive, no temp

    fs.release();
    await delay(50);
    expect(leftovers(dir, ["proj"])).toEqual([]);
  });

  it("fails within the budget when a destination write stalls, and removes the temp", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const fs = stallingFileSystem((op, p) => op === "write" && p.endsWith(".tmp"));

    const { err, ms } = await failure(
      writeArchive(plan, { logger: createLogger(), chunkSize: 65536, volume: new Volume(fs.port, BUDGET) }),
    );

    expect(err).toMatchObject({ errorType: "stall", operation: "write" });
    expect((err as StallError).path).toMatch(/out-.+\.tmp$/);
    expect(ms).toBeLessThan(BUDGET + SLACK);
    expect(leftovers(dir, ["proj"])).toEqual([]);

    fs.release();
    await delay(50);
    expect(leftovers(dir, ["proj"])).toEqual([]);
  });

  it("fails promptly with an AbortError when cancelled during a stalled read", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const fs = stallingFileSystem((op, p) => op === "read" && p.endsWith("f0.txt"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const { err, ms } = await failure(
      writeArchive(plan, {
        logger: createLogger(),
        chunkSize: 65536,
        signal: controller.signal,
        volume: new Volume(fs.port, 60_000, controller.signal),
      }),
    );

    expect(err).toBeInstanceOf(AbortError);
    expect(ms).toBeLessThan(SLACK);
    expect(leftovers(dir, ["proj"])).toEqual([]);
    fs.release();
  });

  it("lets a started publication run to its budget despite a cancel, and says it may still land", async () => {
    const proj = await makeTree();
    const output = path.join(dir, "out.zip");
    const plan = await planFor(proj, output);
    const fs = stallingFileSystem((op, p) => op === "link" && p === output);
    const controller = new AbortController();
    const volume = new Volume(fs.port, BUDGET, controller.signal);
    const run = failure(
      writeArchive(plan, { logger: createLogger(), chunkSize: 65536, signal: controller.signal, volume }),
    );
    await vi.waitFor(() => expect(fs.stalled).not.toHaveLength(0));
    controller.abort();

    const { err } = await run;

    expect(err).toMatchObject({ errorType: "stall", operation: "publish", path: output, committing: true });
    expect((err as StallError).message).toContain("may still complete");
    fs.release();
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

  it("fails within the budget when the archive stops responding", async () => {
    const archive = await archiveOf(2);
    const dest = path.join(dir, "out");
    const fs = stallingFileSystem((op, p) => op === "read" && p === archive);

    const { err, ms } = await failure(runExtract(archive, dest, new Volume(fs.port, BUDGET)));

    expect(err).toMatchObject({ errorType: "stall", operation: "read", path: archive });
    expect(ms).toBeLessThan(BUDGET + SLACK);
    fs.release();
  });

  it("stops every concurrent entry once the destination stalls, leaves no temp, and publishes nothing late", async () => {
    // Forty entries four at a time: were each entry to wait out its own budget
    // the run would take ten budgets; the first stall must end them all.
    const budget = 300;
    const archive = await archiveOf(40);
    const dest = path.join(dir, "out");
    const fs = stallingFileSystem((op, p) => op === "write" && path.basename(p).startsWith(".zk-"));

    const { err, ms } = await failure(runExtract(archive, dest, new Volume(fs.port, budget)));

    expect(err).toMatchObject({ errorType: "stall", operation: "write" });
    expect(ms).toBeLessThan(budget * 3);
    const files = (): string[] =>
      existsSync(dest) ? readdirSync(dest, { recursive: true }).map(String).filter((n) => n.endsWith(".txt") || n.includes(".zk-")) : [];
    expect(files()).toEqual([]);

    fs.release();
    await delay(50);
    expect(files()).toEqual([]);
  });

  it("fails promptly with an AbortError when cancelled during a stalled write", async () => {
    const archive = await archiveOf(2);
    const dest = path.join(dir, "out");
    const fs = stallingFileSystem((op, p) => op === "write" && path.basename(p).startsWith(".zk-"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const { err, ms } = await failure(
      runExtract(archive, dest, new Volume(fs.port, 60_000, controller.signal), controller.signal),
    );

    expect(err).toBeInstanceOf(AbortError);
    expect(ms).toBeLessThan(SLACK);
    const staged = readdirSync(dest, { recursive: true }).map(String).filter((n) => n.includes(".zk-"));
    expect(staged).toEqual([]);
    fs.release();
  });
});
