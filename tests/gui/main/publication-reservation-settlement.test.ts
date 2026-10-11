import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createArchiveEffects, fileResources } from "../../../src/gui/main/archive-effects.js";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { nullLog } from "../../../src/gui/main/log.js";
import { createQueueEngine, type EngineDeps, type QueueEngine } from "../../../src/gui/main/queue-engine.js";
import { buildSpec, DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { AbortError, StallError, ZipKit } from "../../../src/sdk/index.js";
import { nodeFileSystem, Volume, type FileSystemPort } from "../../../src/sdk/internal/volume.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function run(engine: QueueEngine, id: string): void {
  const job = engine.snapshot().find((item) => item.id === id)!;
  engine.run(id, { intent: job.intent, inputs: [...job.inputs] });
}

const cases = [
  { name: "a timed-out fallback copy", phase: "write", cancel: false },
  { name: "a cancelled fallback copy", phase: "write", cancel: true },
  { name: "a late exclusive output open", phase: "open", cancel: false },
] as const;

it.each(cases)("reserves publication through full cleanup after $name", async ({ phase, cancel }) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-publication-settlement-"));
  const output = path.join(root, "archive.zip");
  const a = path.join(root, "a.txt"), b = path.join(root, "b.txt");
  const faultStarted = deferred(), releaseFault = deferred();
  const unlinkStarted = deferred(), releaseUnlink = deferred();
  const firstFailed = deferred();
  const zip = new ZipKit({ sessionLog: false });
  let firstVolume: Volume | undefined;
  let physical: Promise<void> | undefined;
  let physicallySettled = false, oldClaimRemoved = false;
  let ids = 0, writesStarted = 0;
  const writeErrors: unknown[] = [];

  // Only the first writer uses this port. The real SDK takes its unsupported
  // hard-link branch into noClobberPublish's exclusive-copy publication.
  const port: FileSystemPort = {
    ...nodeFileSystem,
    link: async () => { throw Object.assign(new Error("hard links unsupported"), { code: "EOPNOTSUPP" }); },
    open: async (file, flags, mode) => {
      if (file !== output || flags !== "wx") return nodeFileSystem.open(file, flags, mode);
      if (phase === "open") {
        faultStarted.resolve();
        await releaseFault.promise;
      }
      const handle = await nodeFileSystem.open(file, flags, mode);
      return {
        ...handle,
        write: async (...args) => {
          if (phase === "write") {
            faultStarted.resolve();
            await releaseFault.promise;
          }
          return handle.write(...args);
        },
      };
    },
    unlink: async (file) => {
      if (file === output) {
        // The old cleanup has already checked its inode. A new publication
        // here would be deleted when this issued native unlink finally lands.
        unlinkStarted.resolve();
        await releaseUnlink.promise;
      }
      await nodeFileSystem.unlink(file);
      if (file === output) oldClaimRemoved = true;
    },
  };
  const volume = vi.spyOn(zip, "volume");
  const deps: EngineDeps = {
    admission: new CommandAdmission(), effects: createArchiveEffects(),
    resources: (files, signal) => fileResources(files, zip.volume(signal)),
    plan: (inputs, options, signal, onProgress) =>
      zip.plan({ ...buildSpec(inputs, options), output }, { signal, onProgress }),
    write: async (plan, signal, onProgress, onPhysicalSettlement) => {
      const first = ++writesStarted === 1;
      if (first) {
        firstVolume = new Volume(port, 1_000, signal);
        volume.mockReturnValueOnce(firstVolume);
      }
      try {
        return (await zip.write(plan, {
          signal, onProgress,
          onPhysicalSettlement: (settlement) => {
            if (first) {
              physical = settlement;
              void settlement.then(() => { physicallySettled = true; });
            }
            onPhysicalSettlement(settlement);
          },
        })).bytes;
      } catch (error) {
        writeErrors.push(error);
        throw error;
      }
    },
    verify: async (archive, signal, onProgress) =>
      (await zip.extract({ archive, dryRun: true, checkMetadata: true }, { signal, onProgress })).reportOk,
    recheck: (archive, inputs, options, signal, onProgress) =>
      zip.compareSources({ ...buildSpec(inputs, options), output: archive }, archive, { signal, onProgress }),
    classify: async (files) => files.map((file) => ({ path: file, kind: "file" as const })),
    trash: async () => { throw new Error("save jobs must never call Trash"); },
    outputInsideInputs: async () => false,
    emit: (jobs) => { if (jobs[0]?.state === "failed") firstFailed.resolve(); },
    progress: () => () => {}, newId: () => `job-${++ids}`, log: nullLog,
  };
  const engine = createQueueEngine(deps);
  const state = (id: string, expected: string) => vi.waitFor(
    () => expect(engine.snapshot().find((job) => job.id === id)?.state).toBe(expected),
    { interval: 1 },
  );

  try {
    await writeFile(a, "old copy"); await writeFile(b, "NEW WINNER");
    const first = engine.add([a], DEFAULT_OPTIONS, "save");
    await state(first, "ready");

    // Native I/O settles normally without advancing the clock. Advance only
    // after the held call starts, so the failure and cleanup budgets are exact.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    run(engine, first);
    await faultStarted.promise;
    if (cancel) engine.cancel(first);
    await vi.advanceTimersByTimeAsync(1_000);
    if (!cancel && phase === "write") await vi.advanceTimersByTimeAsync(1_000);
    await firstFailed.promise;
    vi.useRealTimers();
    expect(writeErrors[0]).toBeInstanceOf(cancel ? AbortError : StallError);
    expect(physical).toBeDefined();
    expect(physicallySettled).toBe(false);

    releaseFault.resolve();
    await unlinkStarted.promise;
    expect(physicallySettled).toBe(false);
    const oldBytes = await readFile(output);
    const second = engine.add([b], { ...DEFAULT_OPTIONS, overwrite: true }, "save");
    await state(second, "ready");
    run(engine, second);
    await state(second, "failed");
    expect(writesStarted).toBe(1);
    expect(await readFile(output)).toEqual(oldBytes);

    releaseUnlink.resolve();
    await physical;
    expect(physicallySettled).toBe(true);
    expect(oldClaimRemoved).toBe(true);
    run(engine, second);
    await state(second, "done");
    expect(writesStarted).toBe(2);
    const winner = await readFile(output);
    expect((await zip.extract({ archive: output, dryRun: true, checkMetadata: true })).reportOk).toBe(true);
    expect(await readFile(output)).toEqual(winner);
    expect(await readFile(b, "utf8")).toBe("NEW WINNER");
  } finally {
    vi.useRealTimers();
    releaseFault.resolve(); releaseUnlink.resolve();
    await engine.shutdown();
    // Join the port even if the SDK notification itself is the regression.
    await firstVolume?.whenSettled();
    await physical;
    volume.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
