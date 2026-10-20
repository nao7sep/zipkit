import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createPathClaims } from "zipkitsdk";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { nullLog } from "../../../src/gui/main/log.js";
import { createQueueEngine, type EngineDeps, type QueueEngine } from "../../../src/gui/main/queue-engine.js";
import { buildSpec, DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { ZipKit } from "zipkitsdk";
import { nodeFileSystem, Volume, type FileSystemPort } from "zipkitsdk/testing";
import { SAVE } from "../../helpers/intents.js";
import { realPathState } from "../../helpers/archiveState.js";

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
  { name: "a stalled publication on a file system without hard links", phase: "publish", cancel: false },
  { name: "a cancelled temp file create that lands late", phase: "open", cancel: true },
] as const;

it.each(cases)("reserves publication through full cleanup after $name", async ({ phase, cancel }) => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-publication-settlement-"));
  const output = path.join(root, "archive.zip");
  const a = path.join(root, "a.txt"), b = path.join(root, "b.txt");
  const faultStarted = deferred(), releaseFault = deferred();
  const firstFailed = deferred();
  const zip = new ZipKit();
  let firstVolume: Volume | undefined;
  let physical: Promise<void> | undefined;
  let physicallySettled = false;
  let ids = 0, writesStarted = 0;
  const writeErrors: unknown[] = [];

  // Only the first writer uses this port. Without hard links the SDK publishes
  // by renaming its staged temp file in; the held call lands after the job
  // stopped waiting for it.
  const port: FileSystemPort = {
    ...nodeFileSystem,
    link: async () => { throw Object.assign(new Error("hard links unsupported"), { code: "EOPNOTSUPP" }); },
    rename: async (from, to) => {
      if (phase === "publish" && to === output) {
        faultStarted.resolve();
        await releaseFault.promise;
      }
      return nodeFileSystem.rename(from, to);
    },
    open: async (file, flags, mode) => {
      if (phase === "open" && file.endsWith(".tmp") && flags === "wx") {
        faultStarted.resolve();
        await releaseFault.promise;
      }
      return nodeFileSystem.open(file, flags, mode);
    },
  };
  const volume = vi.spyOn(zip, "volume");
  const deps: EngineDeps = {
    admission: new CommandAdmission(), effects: createPathClaims(),
    resources: (files, signal) => zip.pathResources(files, { signal: signal }),
    plan: (inputs, options, signal, onEvent) =>
      zip.plan({ ...buildSpec(inputs, options), output }, { signal, onEvent }),
    write: async (plan, signal, onEvent, onPhysicalSettlement) => {
      const first = ++writesStarted === 1;
      if (first) {
        firstVolume = new Volume(port, 1_000, signal);
        volume.mockReturnValueOnce(firstVolume);
      }
      try {
        const written = await zip.write(plan, {
          signal, onEvent,
          onPhysicalSettlement: (settlement) => {
            if (first) {
              physical = settlement;
              void settlement.then(() => { physicallySettled = true; });
            }
            onPhysicalSettlement(settlement);
          },
        });
        return written.mode === "write" ? written.bytes : null;
      } catch (error) {
        writeErrors.push(error);
        throw error;
      }
    },
    verify: async (archive, signal, onEvent) =>
      (await zip.verify({ archive, manifest: true }, { signal, onEvent })).ok,
    checkRemoval: (archive, inputs, removed, options, signal, onEvent) =>
      zip.checkRemoval({ spec: buildSpec(inputs, options), archive, removed }, { signal, onEvent }),
    pathKinds: async (files) => files.map((file) => ({ path: file, kind: "file" as const })),
    trash: async () => { throw new Error("save jobs must never call Trash"); },
    deleteOriginals: async (paths: string[]) => ({ moved: paths, failed: [], unconfirmed: [] }),
    pathState: realPathState,
    inspect: async (archive, signal, onEvent, manifestName) => {
      const data = await zip.verify(manifestName === null ? { archive } : { archive, manifest: true, manifestName }, { signal, onEvent });
      return { ok: data.ok, summary: data.summary, missing: data.missing, extra: data.extra };
    },
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
    const first = engine.add([a], DEFAULT_OPTIONS, SAVE);
    await state(first, "ready");

    // Native I/O settles normally without advancing the clock. Advance only
    // after the held call starts, so the budget expires exactly.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    run(engine, first);
    await faultStarted.promise;
    if (cancel) engine.cancel(first);
    await vi.advanceTimersByTimeAsync(1_000);
    await firstFailed.promise;
    vi.useRealTimers();
    expect(writeErrors[0]).toMatchObject(cancel ? { code: "operation.cancelled" } : { code: "io.stalled", effect: "unknown" });
    expect(physical).toBeDefined();
    expect(physicallySettled).toBe(false);

    // While the held call may still land, another job cannot take the output.
    const second = engine.add([b], { ...DEFAULT_OPTIONS, overwrite: true }, SAVE);
    await state(second, "ready");
    run(engine, second);
    await state(second, "failed");
    expect(writesStarted).toBe(1);

    releaseFault.resolve();
    await physical;
    expect(physicallySettled).toBe(true);
    // Nothing partial is left: no temp file, and an output only if a late
    // publication landed it whole before the write's cleanup took the temp.
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (existsSync(output)) expect((await zip.verify({ archive: output, manifest: true })).ok).toBe(true);

    run(engine, second);
    await state(second, "done");
    expect(writesStarted).toBe(2);
    expect((await zip.verify({ archive: output, manifest: true })).ok).toBe(true);
    expect((await readFile(output)).includes("b.txt")).toBe(true);
    expect((await readFile(output)).includes("a.txt")).toBe(false);
    } finally {
    vi.useRealTimers();
    releaseFault.resolve();
    await engine.shutdown();
    // Join the port even if the SDK notification itself is the regression.
    await firstVolume?.whenSettled();
    await physical;
    volume.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
