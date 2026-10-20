/**
 * Tests for the queue runner. The engine is exercised through its real state
 * machine with injected fakes for the SDK verbs / Trash / id minting — no
 * Electron, no module mocking. These pin the behaviors that matter: the
 * background-plan -> ready transition, per-job run with sequential execution,
 * fresh re-plan at run, the all-or-nothing destructive sequence (originals kept
 * on any failure), failure isolation, cancel, and remove-archive-then-retry.
 */

import { describe, expect, it, vi } from "vitest";
import { createQueueEngine, type AppRemovalCheck, type EngineDeps, type QueueEngine } from "../../../src/gui/main/queue-engine.js";
import { createPathClaims, ZipKitError, type SourceComparison, type VerifyReport } from "zipkitsdk";
import { CommandAdmission } from "../../../src/gui/main/command-admission.js";
import { nullLog } from "../../../src/gui/main/log.js";
import type { LogEvent, PlanData } from "../../../src/gui/shared/api.js";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { createTranslator, type Message } from "../../../src/gui/shared/i18n/translate.js";
import { DELETE, SAVE, TRASH } from "../../helpers/intents.js";

const en = createTranslator("en");
/** A job or action message as the English reader sees it. */
const say = (message: Message | undefined): string => (message ? en.text(message) : "");

function run(engine: QueueEngine, id: string): void {
  const job = engine.snapshot().find((job) => job.id === id)!;
  engine.run(id, { intent: job.intent, inputs: [...job.inputs] });
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait for the engine to reach a state. Each step settles within a few turns of
 *  the event loop, so the check is polled every millisecond rather than at
 *  waitFor's default 50 ms, which would idle most of each test. */
const until = <T>(check: () => T | Promise<T>): Promise<T> => vi.waitFor(check, { interval: 1 });

/** A plan that is writable unless its first input is the literal "bad". */
function planData(writable: boolean, output = "/tmp/out.zip"): PlanData {
  return {
    mode: "plan",
    output,
    writable,
    summary: { total: 1, included: 1, excluded: 0, renamed: 0, warnings: 0, errors: writable ? 0 : 1, zip64: false, sourceBytes: 0 },
    findings: [],
    entries: [],
    instructions: { output: "/out.zip", writable: true, zip64: false, policy: {} as never, overwrite: false, timeZone: "UTC", entries: [] },
  };
}

const FAILED_REPORT: VerifyReport = {
  summary: { total: 1, crc32Failed: 1, unreadable: 0, localMismatched: 0, sha256Mismatched: 0, manifestMismatched: 0 }, missing: [], extra: [], findings: [],
};

/** The SDK's removal check's own steps, faked one by one: the engine's fake
 *  `checkRemoval` runs them in the SDK's order, and like it, refuses at the
 *  first check that refuses or cannot finish. */
interface RemovalFakes {
  recheck(output: string, inputs: string[], options: typeof DEFAULT_OPTIONS, signal: AbortSignal, onEvent: (e: LogEvent) => void): Promise<SourceComparison>;
  outputInsideInputs(output: string, inputs: string[], signal: AbortSignal): Promise<boolean>;
}

function makeDeps(overrides: Partial<EngineDeps & RemovalFakes> = {}) {
  const calls = { plan: 0, write: 0, verify: 0, recheck: 0, trash: [] as string[][], deleted: [] as string[][], maxWriteInFlight: 0 };
  let writeInFlight = 0;
  let idN = 0;
  const deps: EngineDeps = {
    admission: new CommandAdmission(),
    effects: createPathClaims(),
    resources: async (paths) => paths.map((location) => ({ location, identity: location })),
    pathState: async (target) => ({ kind: "present" as const, fingerprint: `1:${target}:1:1` }),
    inspect: async () => ({ ok: true, summary: { total: 1, crc32Failed: 0, unreadable: 0, localMismatched: 0, sha256Mismatched: 0, manifestMismatched: 0 } as never, missing: [], extra: [] }),
    plan: async (inputs) => {
      calls.plan++;
      return planData(inputs[0] !== "bad");
    },
    write: async () => {
      calls.write++;
      writeInFlight++;
      calls.maxWriteInFlight = Math.max(calls.maxWriteInFlight, writeInFlight);
      await tick();
      writeInFlight--;
      return 123;
    },
    verify: async () => {
      calls.verify++;
      return true;
    },
    pathKinds: async (paths) => paths.map((path) => ({ path, kind: "file" as const })),
    trash: async (paths) => {
      calls.trash.push(paths);
      return { moved: paths, failed: [], unconfirmed: [] };
    },
    deleteOriginals: async (paths) => {
      calls.deleted.push(paths);
      return { moved: paths, failed: [], unconfirmed: [] };
    },
    emit: () => {},
    progress: () => () => {},
    newId: () => `job-${++idN}`,
    log: nullLog,
    checkRemoval: async (output, inputs, _removed, options, signal, onEvent): Promise<AppRemovalCheck> => {
      const seen = await deps.pathState(output, signal).catch(() => null);
      try {
        if (await fakes.outputInsideInputs(output, inputs, signal)) return { refusal: { reason: "inside" }, verified: null };
      } catch (error) { return { refusal: { reason: "error", step: "location", error }, verified: null }; }
      try {
        if (!(await deps.verify(output, signal, onEvent, "zipkit.json"))) return { refusal: { reason: "verify-failed", report: FAILED_REPORT }, verified: null };
      } catch (error) { return { refusal: { reason: "error", step: "verify", error }, verified: null }; }
      const verified = { fingerprint: seen?.kind === "present" ? seen.fingerprint : null };
      try {
        const comparison = await fakes.recheck(output, inputs, options, signal, onEvent);
        return { refusal: comparison.matches ? null : { reason: "changed", comparison }, verified };
      } catch (error) { return { refusal: { reason: "error", step: "recheck", error }, verified }; }
    },
    ...overrides,
  };
  const fakes: RemovalFakes = {
    recheck: async () => {
      calls.recheck++;
      return { matches: true, added: [], missing: [], changed: [], unlisted: [] };
    },
    outputInsideInputs: async () => false,
    ...overrides,
  };
  return { deps, calls };
}

describe("queue engine", () => {
  it("quit refuses new effects while draining already-issued edits, and resumes planning on Cancel", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      engine.beginQuit();
      expect(() => run(engine, id)).toThrow("shutting down");
      expect(() => engine.add(["/other"], DEFAULT_OPTIONS, SAVE)).toThrow("shutting down");
      expect(() => engine.removeArchive(id)).toThrow("shutting down");
      expect(() => engine.removeOriginals(id, "trash")).toThrow("shutting down");
      engine.update(id, { options: { ...DEFAULT_OPTIONS, fileName: "last-name" } });
      expect(engine.snapshot()[0]?.options.fileName).toBe("last-name");
      expect(calls.write).toBe(0);
      engine.resume();
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      expect(engine.snapshot()[0]?.options.fileName).toBe("last-name");
      expect(calls.write).toBe(0);
    } finally { await engine.shutdown(); }
  });
  it("captures option edits before the planning delay, survives cancelled quit, and ignores a stale plan", async () => {
    let finish!: () => void;
    let first = true;
    const { deps, calls } = makeDeps({ plan: async (_inputs, options) => {
      if (first) { first = false; await new Promise<void>((resolve) => { finish = resolve; }); }
      return planData(true, `/${options.fileName || "stale"}.zip`);
    } });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await until(() => expect(finish).toBeTypeOf("function"));
      engine.update(id, { options: { ...DEFAULT_OPTIONS, fileName: "latest", comment: "last keystroke" } });
      run(engine, id);
      finish();
      await tick();
      expect(engine.snapshot()[0]?.state).toBe("planning");
      expect(engine.snapshot()[0]?.output).toBeUndefined();
      expect(calls.write).toBe(0);
      await engine.shutdown();
      expect(engine.snapshot()[0]?.options).toMatchObject({ fileName: "latest", comment: "last keystroke" });
      engine.resume();
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      expect(engine.snapshot()[0]?.output).toBe("/latest.zip");
      expect(calls.write).toBe(0); // Cancel-quit does not restore old Create consent.
      run(engine, id);
      await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    } finally { finish?.(); await engine.shutdown(); }
  });

  it("retires a deferred plan on Cancel or removal", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      engine.update(id, { options: { ...DEFAULT_OPTIONS, fileName: "cancelled" } });
      engine.cancel(id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(engine.snapshot()[0]?.state).toBe("needs-attention");
      expect(calls.plan).toBe(1);
      engine.update(id, { options: { ...DEFAULT_OPTIONS, fileName: "removed" } });
      engine.remove(id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(calls.plan).toBe(1);
      expect(engine.snapshot()).toEqual([]);
    } finally { await engine.shutdown(); }
  });
  it("rejects a run whose projected consent differs from the authoritative intent or inputs", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    const scope = { intent: SAVE, inputs: ["/a"] };
    engine.update(id, { intent: TRASH });
    expect(() => engine.run(id, scope)).toThrow("confirmed");
    engine.addInputs(id, ["/b"]);
    expect(() => engine.run(id, { ...scope, intent: TRASH })).toThrow("confirmed");
    await tick();
    expect(calls.write).toBe(0);
    expect(calls.trash).toEqual([]);
  });

  it("closes mutation and run admission while quit awaits saves, then resumes cancelled planning", async () => {
    let finish!: () => void;
    let first = true;
    const { deps, calls } = makeDeps({ plan: async (_inputs, _options, signal) => {
      if (first) { first = false; await new Promise<void>((resolve) => { finish = resolve; }); }
      signal.throwIfAborted();
      return planData(true);
    } });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    await engine.shutdown();
    expect(() => run(engine, id)).toThrow("shutting down");
    expect(() => engine.update(id, { intent: TRASH })).toThrow("shutting down");
    expect(() => engine.addInputs(id, ["/b"])).toThrow("shutting down");
    expect(() => engine.add(["/new"], DEFAULT_OPTIONS, SAVE)).toThrow("shutting down");
    expect(() => engine.remove(id)).toThrow("shutting down");
    expect(engine.snapshot()[0]?.intent).toBe(SAVE);
    engine.resume();
    finish();
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.write).toBe(0);
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
  });
  it("does not turn an accepted planning save into an unconfirmed Trash request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { deps, calls } = makeDeps({ plan: async () => { await gate; return planData(true); } });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    run(engine, id);
    engine.update(id, { intent: TRASH });
    release();
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    await tick();
    expect(calls.write).toBe(0);
    expect(calls.trash).toEqual([]);
  });

  it("keeps at least one input when restored paths contain duplicates", async () => {
    const { deps } = makeDeps();
    const engine = createQueueEngine(deps);
    engine.restore([{ id: "saved", inputs: ["/same", "/same"], options: DEFAULT_OPTIONS }]);
    engine.removeInput("saved", "/same");
    expect(engine.snapshot()[0]?.inputs).toEqual(["/same", "/same"]);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
  });

  it("owns overlapping input edits and enforces the last input against its current list", async () => {
    const { deps } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/existing"], DEFAULT_OPTIONS, SAVE);
    expect(engine.addInputs(id, ["/a", "/a"]).accepted).toEqual(["/a"]);
    expect(engine.addInputs(id, ["/a", "/b"])).toEqual({ accepted: ["/b"], duplicates: 1 });
    engine.removeInput(id, "/a");
    engine.addInputs(id, ["/c"]);
    engine.removeInput(id, "/existing");
    engine.removeInput(id, "/b");
    engine.removeInput(id, "/c");
    expect(engine.snapshot()[0]?.inputs).toEqual(["/c"]);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(engine.snapshot()[0]?.entries).toEqual([{ path: "/c", kind: "file" }]);
  });

  it.each(["cancel", "remove", "shutdown", "edit"])("retires a planning Create on %s", async (action) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { deps, calls } = makeDeps({ plan: async () => { await gate; return planData(true); } });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    run(engine, id);
    if (action === "cancel") engine.cancel(id);
    if (action === "remove") engine.remove(id);
    if (action === "shutdown") await engine.shutdown();
    if (action === "edit") engine.update(id, { options: { ...DEFAULT_OPTIONS, fileName: "other" } });
    release();
    await tick();
    await tick();
    expect(calls.write).toBe(0);
  });

  it("keeps a planning Create request when another job finishes before that plan", async () => {
    let releaseWrite!: () => void;
    let releasePlan!: () => void;
    const writing = new Promise<void>((r) => { releaseWrite = r; });
    const planning = new Promise<void>((r) => { releasePlan = r; });
    const writes: string[] = [];
    const { deps } = makeDeps({
      plan: async (inputs, options) => {
        if (options.fileName === "changed") await planning;
        return planData(true, `${inputs[0]}.zip`);
      },
      write: async (plan) => {
        writes.push(plan.output!);
        if (plan.output === "/a.zip") await writing;
        return 1;
      },
    });
    const engine = createQueueEngine(deps);
    const a = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    const b = engine.add(["/b"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    run(engine, a);
    await until(() => expect(writes).toEqual(["/a.zip"]));
    engine.update(b, { options: { ...DEFAULT_OPTIONS, fileName: "changed" } });
    run(engine, b);
    releaseWrite();
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    releasePlan();
    await until(() => expect(engine.snapshot()[1]?.state).toBe("done"));
    expect(writes).toEqual(["/a.zip", "/b.zip"]);
  });

  it("names the stalled path when a write stops responding", async () => {
    const { deps } = makeDeps({
      write: async () => {
        throw new ZipKitError("io.stalled", "write did not respond", { subject: "/Volumes/NAS/out-x.tmp", details: { operation: "write", timeoutMs: 30_000 } });
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe(
      "The drive or network share holding /Volumes/NAS/out-x.tmp stopped responding. " +
        "The archive could not be written. Check the output location and available storage, then try again.",
    );
  });

  it("stops for attention, keeping the originals, when the SDK refuses a write because the output appeared since the plan", async () => {
    const { deps, calls } = makeDeps({ write: async () => null });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    expect(engine.snapshot()[0]).toMatchObject({ writable: false, archiveWritten: false });
    expect(say(engine.snapshot()[0]?.message)).toBe("The archive can no longer be written. This was found when the job was checked again at run time.");
    expect(calls.trash).toEqual([]);
  });

  it("refuses to run a Move-to-Trash job without the manifest, writing nothing", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], { ...DEFAULT_OPTIONS, manifest: false }, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await tick();
    await tick();
    expect(calls.write).toBe(0);
    expect(calls.plan).toBe(1);
    expect(engine.snapshot()[0]?.state).toBe("ready");
  });

  it("keeps a Move-to-Trash job from running, and a saved job's originals from Trash, after an unlisted folder", async () => {
    const { deps, calls } = makeDeps({
      plan: async () => {
        calls.plan++;
        const plan = planData(true);
        plan.findings = [{ rule: "entry.unlisted", severity: "warning", path: "locked", message: "folder could not be read" }];
        return plan;
      },
    });
    const engine = createQueueEngine(deps);
    const trashJob = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(engine.snapshot()[0]?.scanIncomplete).toBe(true);
    run(engine, trashJob);
    await tick();
    expect(calls.write).toBe(0);

    const saveJob = engine.add(["/other"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("ready"));
    run(engine, saveJob);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("done"));
    engine.removeOriginals(saveJob, "trash");
    await tick();
    expect(calls.verify).toBe(0);
    expect(calls.trash).toEqual([]);
  });

  it("tags a background plan as plan, and Create's re-plan, write, verify and recheck as one create run", async () => {
    const runs: string[] = [];
    const seen: string[] = [];
    const sinks = new Map<(e: LogEvent) => void, string>();
    const { deps } = makeDeps({
      progress: (jobId, action) => {
        runs.push(`${jobId} ${action}`);
        const sink = () => {};
        sinks.set(sink, action);
        return sink;
      },
      plan: async (_inputs, _options, _signal, onEvent) => {
        seen.push(`plan:${sinks.get(onEvent)}`);
        return planData(true);
      },
      write: async (_plan, _signal, onEvent) => (seen.push(`write:${sinks.get(onEvent)}`), 1),
      verify: async (_output, _signal, onEvent) => (seen.push(`verify:${sinks.get(onEvent)}`), true),
      recheck: async (_output, _inputs, _options, _signal, onEvent) => {
        seen.push(`recheck:${sinks.get(onEvent)}`);
        return { matches: true, added: [], missing: [], changed: [], unlisted: [] };
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(runs).toEqual([`${id} plan`, `${id} create`]);
    expect(seen).toEqual(["plan:plan", "plan:create", "write:create", "verify:create", "recheck:create"]);
  });

  it("names the source file that changed while the archive was written", async () => {
    const { deps } = makeDeps({
      write: async () => {
        throw new ZipKitError("write.source-changed", "source changed", { subject: "docs/notes.txt" });
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe(
      "docs/notes.txt changed while it was being archived, so no archive was written. Create the archive again.",
    );
  });

  it("names the stalled path when planning stops responding, and keeps no stale plan", async () => {
    let stall = false;
    const { deps } = makeDeps({
      plan: async (inputs) => {
        if (stall) throw new ZipKitError("io.stalled", "readdir did not respond", { subject: "/Volumes/NAS/src", details: { operation: "readdir", timeoutMs: 30_000 } });
        return planData(inputs[0] !== "bad");
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    stall = true;
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    const job = engine.snapshot()[0];
    expect(job?.errorCode).toBe("io.stalled");
    expect(say(job?.message)).toContain("/Volumes/NAS/src stopped responding");
    expect(engine.getPlan(id)).toBeNull();
  });

  it("keeps the originals and names the stalled path when verification stops responding", async () => {
    const { deps, calls } = makeDeps({
      verify: async () => {
        throw new ZipKitError("io.stalled", "read did not respond", { subject: "/tmp/out.zip", details: { operation: "read", timeoutMs: 30_000 } });
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe(
      "The drive or network share holding /tmp/out.zip stopped responding. " +
        "The archive could not be verified. The originals were kept.",
    );
    expect(calls.trash).toEqual([]);
  });

  it("passes the job's signal to the containment check", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const { deps } = makeDeps({
      outputInsideInputs: async (_output, _inputs, signal) => {
        seen.push(signal);
        return false;
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("plans a job to ready, then writes it to done when run", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.write).toBe(1);
  });

  it("runs only the requested job, not every ready one", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const a = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    engine.add(["/b"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    run(engine, a);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    await tick();
    expect(engine.snapshot()[1]?.state).toBe("ready"); // the unrequested job stays put
    expect(calls.write).toBe(1);
  });

  it("leaves a not-writable job in needs-attention and never writes it", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["bad"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    run(engine, id); // a no-op on a blocked job
    await tick();
    await tick();
    expect(engine.snapshot()[0]?.state).toBe("needs-attention");
    expect(calls.write).toBe(0);
  });

  it("drops a job whose plan throws to needs-attention with the error", async () => {
    const { deps } = makeDeps({
      plan: async () => {
        throw new Error("scan boom");
      },
    });
    const engine = createQueueEngine(deps);
    engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("needs-attention");
      expect(say(j?.message)).toContain("could not be prepared");
      expect(j?.errorCode).toBeUndefined(); // a plain Error carries no SDK code
    });
  });

  it("captures the SDK error code on a plan that throws", async () => {
    const { deps } = makeDeps({
      plan: async () => {
        throw new ZipKitError("output.ambiguous", "inputs live in different parents");
      },
    });
    const engine = createQueueEngine(deps);
    engine.add(["/a", "/b"], DEFAULT_OPTIONS, SAVE);
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("needs-attention");
      expect(j?.errorCode).toBe("output.ambiguous");
    });
  });

  it("stops Create for review when the fresh plan shows another Report, then creates once reviewed", async () => {
    let files = ["a.txt"];
    const { deps, calls } = makeDeps({
      plan: async () => {
        calls.plan++;
        const plan = planData(true);
        plan.entries = files.map((archivePath) => ({
          archivePath,
          originalPath: archivePath,
          diskPath: `/in/${archivePath}`,
          type: "file" as const,
          method: "deflate" as const,
          excluded: false,
          findings: [],
        }));
        return plan;
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    files = ["a.txt", "b.txt"]; // a file appeared after the Report was read
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    const job = engine.snapshot()[0];
    expect(job?.writable).toBe(true);
    expect(say(job?.message)).toContain("The files changed since this job was checked");
    expect(calls.write).toBe(0);
    expect(engine.getPlan(id)?.entries.map((e) => e.archivePath)).toEqual(["a.txt", "b.txt"]);
    run(engine, id); // the fresh plan is the reviewed one now
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.write).toBe(1);
  });

  it("re-plans fresh at run time", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    const atReady = calls.plan; // the add-time plan
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.plan).toBe(atReady + 1); // planned again at run
  });

  it("runs requested jobs sequentially — never two writes at once", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const ids = ["/a", "/b", "/c"].map((p) => engine.add([p], DEFAULT_OPTIONS, SAVE));
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    ids.forEach((id) => run(engine, id));
    await until(() => expect(engine.snapshot().every((j) => j.state === "done")).toBe(true));
    expect(calls.maxWriteInFlight).toBe(1);
  });

  it("a run requested while another job is running waits as queued, then runs in turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let writes = 0;
    const { deps } = makeDeps({
      write: async () => {
        writes++;
        if (writes === 1) await gate; // hold the first job in `running`
        return 1;
      },
    });
    const engine = createQueueEngine(deps);
    const a = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    const b = engine.add(["/b"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    run(engine, a);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("running")); // idle -> running, no queued
    run(engine, b);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("queued")); // waits its turn, visibly
    release();
    await until(() => expect(engine.snapshot().every((j) => j.state === "done")).toBe(true));
    expect(writes).toBe(2);
  });

  it("cancelling a queued job pulls it from the run queue and re-plans it; it never runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let writes = 0;
    const { deps, calls } = makeDeps({
      write: async () => {
        writes++;
        if (writes === 1) await gate;
        return 1;
      },
    });
    const engine = createQueueEngine(deps);
    const a = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    const b = engine.add(["/b"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    const plansBefore = calls.plan;
    run(engine, a);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("running"));
    run(engine, b);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("queued"));
    engine.cancel(b);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("ready")); // re-planned back to editable
    expect(calls.plan).toBeGreaterThan(plansBefore);
    release();
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    await tick();
    expect(engine.snapshot()[1]?.state).toBe("ready"); // stayed out of the run
    expect(writes).toBe(1); // only A ever wrote
  });

  it("ignores update() on a queued job, so it can't be silently re-armed to a new intent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let writes = 0;
    const { deps, calls } = makeDeps({
      write: async () => {
        writes++;
        if (writes === 1) await gate;
        return 1;
      },
    });
    const engine = createQueueEngine(deps);
    const a = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    const b = engine.add(["/b"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    run(engine, a);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("running"));
    run(engine, b);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("queued"));
    // Flipping a queued job's intent must be a no-op: a queued job is committed to
    // run, and a store-only edit would otherwise leave it queued and auto-run later
    // under the new (destructive) intent.
    engine.update(b, { intent: TRASH });
    expect(engine.snapshot()[1]?.intent).toBe(SAVE);
    release();
    await until(() => expect(engine.snapshot().every((j) => j.state === "done")).toBe(true));
    expect(calls.trash).toEqual([]); // B ran as a plain save — nothing trashed
  });

  it("ignores update() on a done job, so a late edit can't discard the finished result", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    const plansWhenDone = calls.plan;

    // The pane's option debounce lands after the job finishes. A plan-affecting
    // option re-planned the job out of `done` and threw the result away; any edit
    // dropped the published output, leaving the archive's Trash command inert.
    engine.update(id, { options: { ...DEFAULT_OPTIONS, exclude: false } });
    engine.update(id, { options: { ...DEFAULT_OPTIONS, level: 1 } });
    engine.update(id, { intent: TRASH });
    await tick();

    const job = engine.snapshot()[0];
    expect(job?.state).toBe("done");
    expect(job?.intent).toBe(SAVE);
    expect(job?.options).toEqual(DEFAULT_OPTIONS);
    expect(calls.plan).toBe(plansWhenDone);

    engine.removeArchive(id); // the archive it published is still the one it knows
    await until(() => expect(calls.trash).toEqual([["/tmp/out.zip"]]));
  });

  it("honors a run requested while the job is still (re)planning, once the plan lands ready", async () => {
    let releasePlan!: () => void;
    const planGate = new Promise<void>((r) => (releasePlan = r));
    let plans = 0;
    const { deps, calls } = makeDeps({
      plan: async (inputs) => {
        plans++;
        if (plans === 1) await planGate; // hold the add-time plan open
        return planData(inputs[0] !== "bad");
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    run(engine, id); // requested mid-plan — must be deferred, not dropped
    await tick();
    expect(engine.snapshot()[0]?.state).toBe("planning"); // still waiting on the plan
    releasePlan();
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done")); // ran once it became ready
    expect(calls.write).toBe(1);
  });

  it("drops a run requested mid-plan if the plan lands not-writable (no write)", async () => {
    let releasePlan!: () => void;
    const planGate = new Promise<void>((r) => (releasePlan = r));
    let plans = 0;
    const { deps, calls } = makeDeps({
      plan: async () => {
        plans++;
        if (plans === 1) await planGate;
        return planData(false); // not writable
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    run(engine, id);
    releasePlan();
    await until(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    await tick();
    expect(engine.snapshot()[0]?.state).toBe("needs-attention"); // stale request dropped
    expect(calls.write).toBe(0);
  });

  it("isolates a failing write — the other requested jobs still run", async () => {
    let n = 0;
    const { deps } = makeDeps({
      write: async () => {
        n++;
        if (n === 2) throw new Error("disk full");
        return 1;
      },
    });
    const engine = createQueueEngine(deps);
    const ids = ["/a", "/b", "/c"].map((p) => engine.add([p], DEFAULT_OPTIONS, SAVE));
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    ids.forEach((id) => run(engine, id));
    await until(() =>
      expect(engine.snapshot().every((j) => j.state === "done" || j.state === "failed")).toBe(true),
    );
    expect(engine.snapshot().map((j) => j.state)).toEqual(["done", "failed", "done"]);
    expect(n).toBe(3); // all three writes were attempted
  });

  it("archive-and-trash: writes, verifies, then trashes the originals", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.verify).toBe(1);
    expect(calls.trash).toEqual([["/data"]]);
  });

  it("archive-and-trash: keeps the originals when verification fails", async () => {
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(say(j?.message)).toContain("Verification failed");
    });
    expect(calls.trash).toEqual([]);
  });

  it("a new or restored job verifies and keeps its originals until the user chooses otherwise", async () => {
    const { deps } = makeDeps();
    const engine = createQueueEngine(deps);
    engine.add(["/new"], DEFAULT_OPTIONS);
    engine.restore([{ id: "restored", inputs: ["/old"], options: DEFAULT_OPTIONS }]);
    for (const job of engine.snapshot()) expect(job.intent).toEqual({ verify: true, originals: "keep" });
  });

  it("keep and verify: verifies the archive against its manifest only when it has one", async () => {
    const seen: (string | null)[] = [];
    const { deps, calls } = makeDeps({ verify: async (_output, _signal, _onProgress, manifestName) => (seen.push(manifestName), true) });
    const engine = createQueueEngine(deps);
    const withManifest = engine.add(["/a"], DEFAULT_OPTIONS);
    const without = engine.add(["/b"], { ...DEFAULT_OPTIONS, manifest: false });
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    run(engine, withManifest);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    run(engine, without);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("done"));
    expect(seen).toEqual(["zipkit.json", null]);
    expect(say(engine.snapshot()[0]?.message)).toContain("Saved and verified");
    expect(calls.trash).toEqual([]);
    expect(calls.deleted).toEqual([]);
  });

  it("keep and verify: a failed verification keeps the archive and the originals, offering the archive to Trash", async () => {
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    const job = engine.snapshot()[0]!;
    expect(job.archiveWritten).toBe(true);
    expect(say(job.message)).toContain("did not pass verification");
    expect(calls.trash).toEqual([]);
  });

  it("delete: writes, verifies, rechecks, then deletes the originals permanently, never trashing them", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, DELETE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.verify).toBe(1);
    expect(calls.recheck).toBe(1);
    expect(calls.deleted).toEqual([["/data"]]);
    expect(calls.trash).toEqual([]);
    expect(say(engine.snapshot()[0]?.message)).toContain("deleted permanently");
  });

  it("delete: deletes nothing when the originals changed since archiving", async () => {
    const { deps, calls } = makeDeps({ recheck: async () => ({ matches: false, added: ["new.txt"], missing: [], changed: [], unlisted: [] }) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, DELETE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(calls.deleted).toEqual([]);
  });

  it("delete: reports a partial deletion exactly and keeps the archive", async () => {
    const { deps } = makeDeps({
      deleteOriginals: async (paths) => ({ moved: [paths[0]!], failed: [{ path: paths[1]!, message: "EACCES" }], unconfirmed: [] }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, DELETE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    const text = say(engine.snapshot()[0]?.message);
    expect(text).toContain("1 original was deleted permanently");
    expect(text).toContain("1 original was kept");
  });

  it("deletes a finished kept job's originals on request, after the checks", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.removeOriginals(id, "delete");
    await until(() => expect(engine.snapshot()[0]?.actionResult).toBeDefined());
    expect(calls.verify).toBe(1);
    expect(calls.deleted).toEqual([["/data"]]);
    expect(say(engine.snapshot()[0]?.actionResult?.message)).toContain("deleted permanently");
  });

  it("does not move a finished job's archive to Trash once an original is gone", async () => {
    let gone = false;
    const { deps, calls } = makeDeps({ pathKinds: async (paths) => paths.map((path) => ({ path, kind: gone ? "missing" as const : "file" as const })) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    gone = true;
    engine.removeOriginals(id, "delete");
    await until(() => expect(engine.snapshot()[0]?.entries?.[0]?.kind).toBe("missing"));
    const trashedBefore = calls.trash.length;
    engine.removeArchive(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.trash.length).toBe(trashedBefore);
    expect(engine.snapshot()[0]?.state).toBe("done");
  });

  it("removeArchive trashes a done save job's output and returns it to ready", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.removeArchive(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.trash).toEqual([["/tmp/out.zip"]]); // the archive was trashed
  });

  it("removeArchive can clean up a FAILED job whose archive was written (verify failed)", async () => {
    // archive-and-trash that wrote the .zip then failed verify: the file exists and
    // the originals are kept, so the user may remove that partial archive.
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(engine.snapshot()[0]?.output).toBe("/tmp/out.zip"); // the .zip was written
    expect(calls.trash).toEqual([]); // verify failed before any trash
    engine.removeArchive(id);
    await until(() => expect(calls.trash).toEqual([["/tmp/out.zip"]])); // archive removed
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready")); // back to editable
  });

  it("restore reloads saved jobs and plans each fresh to ready", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    engine.restore([
      { id: "j1", inputs: ["/a"], options: DEFAULT_OPTIONS },
      { id: "j2", inputs: ["/b"], options: DEFAULT_OPTIONS },
    ]);
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    expect(engine.snapshot().map((j) => j.id)).toEqual(["j1", "j2"]);
    expect(calls.plan).toBe(2); // each restored job is re-planned
  });

  it("cancel aborts an in-flight write — the job fails, not silently hangs", async () => {
    const { deps } = makeDeps({
      write: (_plan, signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("running"));
    engine.cancel(id);
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(say(j?.message)).toContain("could not be written");
    });
  });

  it("ZK-1: cancel reaches the Trash step through a real signal, not a dead button", async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseTrash!: () => void;
    const { deps } = makeDeps({
      trash: (paths, signal) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          releaseTrash = () =>
            resolve(
              signal.aborted
                ? { moved: [], failed: paths.map((path) => ({ path, message: "cancelled before Trash" })), unconfirmed: [] }
                : { moved: paths, failed: [], unconfirmed: [] },
            );
        });
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(observedSignal).toBeDefined());

    // The Cancel button, while the Trash step is in flight.
    engine.cancel(id);
    expect(observedSignal!.aborted).toBe(true); // previously: trash had no signal to abort at all
    releaseTrash();

    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(say(j?.message)).toContain("kept");
    });
  });

  it("ZK-2: shutdown waits for the aborted writer to actually stop, not just for the abort call", async () => {
    let rejectWrite!: (err: Error) => void;
    const { deps } = makeDeps({
      // Aborting alone does not settle this fake — only the writer itself
      // decides when it has actually stopped, same as the real ZipWriter's
      // own `abort()` cleanup taking real (if brief) time.
      write: () =>
        new Promise<number>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(rejectWrite).toBeTypeOf("function"));

    let settled = false;
    const shutdown = engine.shutdown().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false); // shutdown asked for cancellation; the writer hasn't stopped yet
    expect(engine.hasRunningJob()).toBe(true); // still running, by design of this fake

    rejectWrite(new Error("aborted"));
    await shutdown;
    expect(settled).toBe(true);
    expect(engine.hasRunningJob()).toBe(false);
    expect(engine.snapshot()[0]?.state).toBe("failed");
  });

  it("ZK-2: shutdown stops a queued job from ever getting its turn", async () => {
    let rejectFirstWrite!: (err: Error) => void;
    const { deps, calls } = makeDeps({
      write: () => {
        calls.write++;
        return new Promise<number>((_resolve, reject) => {
          rejectFirstWrite = reject;
        });
      },
    });
    const engine = createQueueEngine(deps);
    const a = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    const b = engine.add(["/b"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    run(engine, a);
    run(engine, b);
    await until(() => expect(engine.snapshot().find((j) => j.id === b)?.state).toBe("queued"));

    await until(() => expect(rejectFirstWrite).toBeTypeOf("function"));
    const shutdown = engine.shutdown();
    rejectFirstWrite(new Error("aborted"));
    await shutdown;

    expect(calls.write).toBe(1); // b never started
    expect(engine.snapshot().find((j) => j.id === b)?.state).toBe("ready");
  });

  it("archive-and-trash refuses to Trash when the archive is inside the source", async () => {
    const { deps, calls } = makeDeps({
      plan: async (inputs) => planData(true, `${inputs[0]}/out.zip`),
      outputInsideInputs: async () => true,
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(say(j?.message)).toContain("inside the source");
    });
    expect(calls.trash).toEqual([]); // originals untouched
  });

  it("trashOriginals refuses when the archive sits inside an input (no self-deletion)", async () => {
    const { deps, calls } = makeDeps({
      plan: async (inputs) => planData(true, `${inputs[0]}/out.zip`),
      outputInsideInputs: async () => true,
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.removeOriginals(id, "trash");
    await tick();
    expect(calls.trash).toEqual([]); // refused — never trashed
    expect(say(engine.snapshot()[0]?.actionResult?.message)).toContain("inside an original");
    expect(engine.snapshot()[0]?.actionResult?.severity).toBe("error");
  });

  it("trashOriginals surfaces a Trash failure instead of claiming success", async () => {
    const { deps } = makeDeps({
      trash: async () => {
        throw new Error("trash boom");
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.removeOriginals(id, "trash");
    await until(() =>
      expect(say(engine.snapshot()[0]?.actionResult?.message)).toContain("could not be moved to Trash"),
    );
    expect(engine.snapshot()[0]?.actionResult?.severity).toBe("error");
    expect(engine.snapshot()[0]?.state).toBe("done"); // unchanged
  });

  it("reports partial Trash truthfully and keeps the recoverable moves", async () => {
    const { deps } = makeDeps({
      trash: async (paths) => ({
        moved: [paths[0]!],
        failed: [{ path: paths[1]!, message: "permission denied" }],
        unconfirmed: [],
      }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toContain("1 original was moved to recoverable Trash. 1 original was kept.");
  });

  it("never calls an original kept while its Trash call may still move it", async () => {
    const { deps } = makeDeps({
      trash: async (paths) => ({ moved: [paths[0]!], failed: [], unconfirmed: [paths[1]!] }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    const message = say(engine.snapshot()[0]?.message);
    expect(message).toContain("1 original was moved to recoverable Trash. 1 original was still being moved and may yet reach recoverable Trash.");
    expect(message).not.toContain("kept");
  });

  it("removeArchive does not claim the archive remains when its Trash call is unconfirmed", async () => {
    const { deps } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    deps.trash = async (paths) => ({ moved: [], failed: [], unconfirmed: paths });
    engine.removeArchive(id);
    await until(() => expect(engine.snapshot()[0]?.actionResult).toBeDefined());
    const result = engine.snapshot()[0]?.actionResult;
    expect(result?.severity).toBe("warning");
    expect(say(result?.message)).toContain("may yet reach recoverable Trash");
    expect(say(result?.message)).not.toContain("remains available");
  });

  it("does not offer a planned output as removable after its write fails", async () => {
    const { deps, calls } = makeDeps({
      write: async () => { throw new Error("disk full"); },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(engine.snapshot()[0]?.archiveWritten).toBe(false);
    engine.removeArchive(id);
    await tick();
    expect(calls.trash).toEqual([]);
  });

  it("Retry after a failed check resumes from the written archive, without writing again", async () => {
    let verifyOk = false;
    const { deps, calls } = makeDeps({ verify: async () => (calls.verify++, verifyOk) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(engine.snapshot()[0]?.archiveWritten).toBe(true);
    // The written archive is the record of the options now: no edits.
    engine.update(id, { options: { ...DEFAULT_OPTIONS, level: 1 } });
    expect(engine.snapshot()[0]?.options.level).toBe(DEFAULT_OPTIONS.level);
    verifyOk = true;
    const plansBefore = calls.plan;
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.write).toBe(1);
    expect(calls.plan).toBe(plansBefore);
    expect(calls.verify).toBe(2);
    expect(calls.recheck).toBe(1);
    expect(calls.trash).toEqual([["/data"]]);
  });

  it("Retry after a partial Trash checks and moves only the inputs still present, naming those already moved", async () => {
    let trashCall = 0;
    let checked: { inputs: string[]; removed: string[] } | undefined;
    const { deps, calls } = makeDeps({
      trash: async (paths) => {
        calls.trash.push(paths);
        trashCall++;
        return trashCall === 1
          ? { moved: ["/x/a"], failed: [{ path: "/x/b", message: "busy" }], unconfirmed: [] }
          : { moved: paths, failed: [], unconfirmed: [] };
      },
      pathKinds: async (paths) => paths.map((path) => ({ path, kind: trashCall > 0 && path === "/x/a" ? "missing" as const : "file" as const })),
      // What the archive holds from a moved input is the SDK's to forgive.
      checkRemoval: async (_output, inputs, removed) => {
        checked = { inputs, removed };
        return { refusal: null, verified: { fingerprint: null } };
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x/a", "/x/b"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(checked).toEqual({ inputs: ["/x/b"], removed: ["/x/a"] });
    expect(calls.trash).toEqual([["/x/a", "/x/b"], ["/x/b"]]);
    expect(calls.write).toBe(1);
  });

  it("a verify that fails again after Retry says to move the archive to Trash and create it again", async () => {
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe("Verification failed. The originals were kept.");
    run(engine, id);
    await until(() =>
      expect(say(engine.snapshot()[0]?.message)).toBe(
        "Verification failed again. The originals were kept. Move the archive to Trash, then create it again.",
      ),
    );
    expect(engine.snapshot()[0]?.state).toBe("failed");
    expect(calls.write).toBe(1);
    expect(calls.trash).toEqual([]);
  });

  it("removeArchive surfaces a Trash failure and leaves the job done", async () => {
    const { deps } = makeDeps({
      trash: async () => {
        throw new Error("nope");
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.removeArchive(id);
    await until(() =>
      expect(say(engine.snapshot()[0]?.actionResult?.message)).toContain("archive could not be moved to Trash"),
    );
    expect(engine.snapshot()[0]?.actionResult?.severity).toBe("error");
    expect(engine.snapshot()[0]?.state).toBe("done"); // unchanged
  });

  it("discards a superseded re-plan; only the newest plan's result wins", async () => {
    // A slow, stale plan must never overwrite a newer one (rapid input/option edits
    // stack re-plans). The first plan is held open; a second plan starts and
    // resolves; then the first is released and must be discarded.
    const release: Array<() => void> = [];
    let n = 0;
    const { deps } = makeDeps({
      plan: () => {
        n += 1;
        if (n === 1) {
          return new Promise<PlanData>((resolve) => {
            release.push(() => resolve(planData(true, "/STALE.zip")));
          });
        }
        return Promise.resolve(planData(true, "/FRESH.zip"));
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE); // plan #1 (held open)
    await until(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.update(id, { options: { ...DEFAULT_OPTIONS, exclude: false } }); // plan #2 (fresh)
    await until(() => expect(engine.snapshot()[0]?.output).toBe("/FRESH.zip"));
    release[0]!(); // release the stale plan #1 — it must NOT win
    await tick();
    await tick();
    expect(engine.snapshot()[0]?.output).toBe("/FRESH.zip");
    expect(engine.snapshot()[0]?.state).toBe("ready");
  });

  it("re-plans when a plan-affecting option changes", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.plan).toBe(1);
    engine.update(id, { options: { ...DEFAULT_OPTIONS, exclude: false } });
    await until(() => expect(calls.plan).toBe(2));
    expect(engine.snapshot()[0]?.options.exclude).toBe(false);
  });

  it("classifies inputs on add, storing them as entries", async () => {
    const { deps } = makeDeps({
      pathKinds: async (paths) =>
        paths.map((path) => ({ path, kind: path.endsWith("/") ? "directory" : "file" })),
    });
    const engine = createQueueEngine(deps);
    engine.add(["/dir/", "/file.txt"], DEFAULT_OPTIONS, SAVE);
    await until(() =>
      expect(engine.snapshot()[0]?.entries).toEqual([
        { path: "/dir/", kind: "directory" },
        { path: "/file.txt", kind: "file" },
      ]),
    );
  });

  it("does NOT re-plan when only a write-only option (level/comment) changes", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.plan).toBe(1);
    engine.update(id, { options: { ...DEFAULT_OPTIONS, level: 1, comment: "hi" } });
    await tick();
    await tick();
    expect(calls.plan).toBe(1); // stored, but no redundant dry run
    expect(engine.snapshot()[0]?.options.level).toBe(1); // change still applied
  });

  it("re-plans and re-classifies when a job's inputs change", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.plan).toBe(1);
    engine.addInputs(id, ["/y"]);
    await until(() => expect(calls.plan).toBe(2));
    expect(engine.snapshot()[0]?.inputs).toEqual(["/x", "/y"]);
    await until(() =>
      expect(engine.snapshot()[0]?.entries?.map((e) => e.path)).toEqual(["/x", "/y"]),
    );
  });

  it("trashOriginals moves a done save job's inputs to Trash", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.removeOriginals(id, "trash");
    await until(() => expect(calls.trash).toEqual([["/a", "/b"]]));
    expect(engine.snapshot()[0]?.state).toBe("done"); // archive kept; job stays done
  });

  it("archive-and-trash: keeps the originals and the archive when they changed after archiving", async () => {
    const { deps, calls } = makeDeps({
      recheck: async () => ({ matches: false, added: ["data/new.txt"], missing: [], changed: [], unlisted: [] }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe(
      "1 file was added to the originals. " +
        "The originals changed after the archive was made, so the originals and the archive were kept. " +
        "To include the changes, move the archive to Trash and create it again.",
    );
    expect(engine.snapshot()[0]?.originalsChanges).toEqual({ missing: [], added: ["data/new.txt"], changed: [], unlisted: [] });
    expect(engine.snapshot()[0]?.archiveBytes).toBe(123);
    expect(calls.verify).toBe(1);
    expect(calls.trash).toEqual([]);
  });

  async function doneSave(deps: EngineDeps, options = DEFAULT_OPTIONS) {
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], options, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    return { engine, id };
  }

  it("trashOriginals verifies the archive and rechecks the originals before moving them", async () => {
    const order: string[] = [];
    const { deps, calls } = makeDeps({
      verify: async () => (order.push("verify"), true),
      recheck: async (output, inputs) => {
        order.push(`recheck ${output} ${inputs.join(",")}`);
        return { matches: true, added: [], missing: [], changed: [], unlisted: [] };
      },
    });
    const { engine, id } = await doneSave(deps);
    engine.removeOriginals(id, "trash");
    await until(() => expect(calls.trash).toEqual([["/data"]]));
    expect(order).toEqual(["verify", "recheck /tmp/out.zip /data"]);
    await until(() => expect(engine.snapshot()[0]?.actionResult?.severity).toBe("info"));
  });

  it("trashOriginals refuses when the archive no longer verifies, or the originals changed", async () => {
    let verifyOk = false;
    let matches = true;
    const { deps, calls } = makeDeps({
      verify: async () => verifyOk,
      recheck: async () => ({ matches, added: [], missing: [], changed: matches ? [] : ["data/a"], unlisted: [] }),
    });
    const { engine, id } = await doneSave(deps);
    engine.removeOriginals(id, "trash");
    await until(() => expect(say(engine.snapshot()[0]?.actionResult?.message)).toBe("Verification failed. The originals were kept."));
    verifyOk = true;
    matches = false;
    engine.removeOriginals(id, "trash");
    await until(() => expect(say(engine.snapshot()[0]?.actionResult?.message)).toContain("The originals changed after the archive was made"));
    expect(engine.snapshot()[0]?.actionResult?.severity).toBe("error");
    expect(calls.trash).toEqual([]);
  });

  it("trashOriginals is refused for an archive without the manifest", async () => {
    const { deps, calls } = makeDeps();
    const { engine, id } = await doneSave(deps, { ...DEFAULT_OPTIONS, manifest: false });
    engine.removeOriginals(id, "trash");
    await tick();
    expect(calls.verify).toBe(0);
    expect(calls.trash).toEqual([]);
    expect(engine.snapshot()[0]?.trashing).toBeUndefined();
  });

  it("trashOriginals is busy while it runs, takes one claim, and cancels for real", async () => {
    let release: (() => void) | null = null;
    const { deps, calls } = makeDeps({
      verify: (_output, signal) =>
        new Promise<boolean>((resolve, reject) => {
          release = () => resolve(true);
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const { engine, id } = await doneSave(deps);
    engine.removeOriginals(id, "trash");
    engine.removeOriginals(id, "trash"); // a second click while the first is in flight
    expect(engine.snapshot()[0]?.trashing).toBe(true);
    expect(engine.hasRunningJob()).toBe(true);
    await until(() => expect(release).not.toBeNull());
    engine.cancel(id);
    await until(() => expect(engine.snapshot()[0]?.trashing).toBe(false));
    expect(say(engine.snapshot()[0]?.actionResult?.message)).toBe(
      "Moving the originals to Trash was cancelled. The originals were kept.",
    );
    expect(engine.snapshot()[0]?.state).toBe("done");
    expect(engine.hasRunningJob()).toBe(false);
    expect(calls.trash).toEqual([]);
  });

  it("shutdown waits for a finished job's Trash command to stop", async () => {
    let settled = false;
    const { deps } = makeDeps({
      verify: (_output, signal) =>
        new Promise<boolean>((_resolve, reject) => {
          const stop = () => setTimeout(() => ((settled = true), reject(new Error("aborted"))), 20);
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop);
        }),
    });
    const { engine, id } = await doneSave(deps);
    engine.removeOriginals(id, "trash");
    await tick();
    await engine.shutdown();
    expect(settled).toBe(true);
    expect(engine.snapshot()[0]?.trashing).toBe(false);
  });

  it("trashOriginals is a no-op unless the job is a done save job", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.removeOriginals(id, "trash"); // not done yet, wrong intent
    await tick();
    expect(calls.trash).toEqual([]);
  });

  it("cancel aborts an in-flight plan", async () => {
    const { deps } = makeDeps({
      plan: (_inputs, _options, signal) =>
        new Promise<PlanData>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.cancel(id);
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("needs-attention");
      expect(say(j?.message)).toContain("could not be prepared");
    });
  });
});

describe("removing a job's archive", () => {
  /** A Trash that holds each call until released, and reports a cut-short wait as unconfirmed. */
  function heldTrash() {
    const releases: Array<() => void> = [];
    const trash: EngineDeps["trash"] = (paths, signal) =>
      new Promise((resolve) => {
        const moved = () => resolve({ moved: paths, failed: [], unconfirmed: [] });
        releases.push(moved);
        signal.addEventListener("abort", () => resolve({ moved: [], failed: [], unconfirmed: paths }), { once: true });
      });
    return { trash, started: () => releases.length > 0, release: () => releases.splice(0).forEach((resolve) => resolve()) };
  }

  async function doneSaveJob(overrides: Partial<EngineDeps> = {}) {
    const made = makeDeps(overrides);
    const engine = createQueueEngine(made.deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    return { ...made, engine, id };
  }

  it("claims the job: a second click, Move originals and removing the job wait until it ends", async () => {
    const held = heldTrash();
    const { engine, id, deps, calls } = await doneSaveJob();
    deps.trash = async (paths, signal) => {
      calls.trash.push(paths);
      return held.trash(paths, signal);
    };

    engine.removeArchive(id);
    expect(engine.snapshot()[0]?.trashing).toBe(true);
    expect(engine.hasRunningJob()).toBe(true);
    engine.removeArchive(id);
    engine.removeOriginals(id, "trash");
    engine.remove(id);
    await tick();
    expect(calls.trash).toEqual([["/tmp/out.zip"]]);
    expect(engine.snapshot().map((job) => job.id)).toEqual([id]);

    held.release();
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(engine.snapshot()[0]?.trashing).toBe(false);
    expect(engine.hasRunningJob()).toBe(false);
  });

  it("holds Retry on a failed job until its archive's Trash ends", async () => {
    const held = heldTrash();
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, TRASH);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    deps.trash = held.trash;
    const verifies = calls.verify;

    engine.removeArchive(id);
    run(engine, id);
    await tick();

    expect(engine.snapshot()[0]?.state).toBe("failed");
    expect(calls.verify).toBe(verifies);
    held.release();
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
  });

  it("Cancel stops waiting and says the archive may still reach Trash, keeping the job as it was", async () => {
    const held = heldTrash();
    const { engine, id, deps } = await doneSaveJob();
    deps.trash = held.trash;

    engine.removeArchive(id);
    await until(() => expect(held.started()).toBe(true));
    engine.cancel(id);

    await until(() => expect(engine.snapshot()[0]?.trashing).toBe(false));
    const job = engine.snapshot()[0]!;
    expect(job.state).toBe("done");
    expect(job.actionResult?.severity).toBe("warning");
    expect(say(job.actionResult?.message)).toContain("may yet reach recoverable Trash");
    expect(engine.hasRunningJob()).toBe(false);
  });

  it("quit stops waiting on an archive's Trash and settles once the removal has ended", async () => {
    const held = heldTrash();
    const { engine, id, deps } = await doneSaveJob();
    deps.trash = held.trash;

    engine.removeArchive(id);
    await until(() => expect(held.started()).toBe(true));
    await engine.shutdown();

    expect(engine.snapshot()[0]?.trashing).toBe(false);
    expect(say(engine.snapshot()[0]?.actionResult?.message)).toContain("may yet reach recoverable Trash");
  });
});

describe("a write that stalls", () => {
  function stall(committing: boolean): Error {
    return new ZipKitError("io.stalled", "stalled", {
      subject: "/Volumes/Share/out.zip", effect: committing ? "unknown" : "none", details: { operation: "publish", timeoutMs: 30_000 },
    });
  }

  async function failedWith(error: Error): Promise<string> {
    const { deps } = makeDeps({ write: async () => { throw error; } });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, SAVE);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    return say(engine.snapshot()[0]?.message);
  }

  it("while publishing the archive says it may still appear, not that it could not be written", async () => {
    const text = await failedWith(stall(true));
    expect(text).toContain("stopped responding");
    expect(text).toContain("may already be at /tmp/out.zip or may still appear there");
    expect(text).not.toContain("could not be written");
  });

  it("before publishing says the archive could not be written", async () => {
    const text = await failedWith(stall(false));
    expect(text).toContain("stopped responding");
    expect(text).toContain("could not be written");
  });
});

describe("the archive's recorded state and the job's history", () => {
  const VERIFY = { verify: true, originals: "keep" } as const;
  const keys = (engine: QueueEngine) => (engine.snapshot()[0]?.history ?? []).map((entry) => entry.message.key);

  /** Deps whose archive the test sets: its content while it is there under the
   *  same file, another file's after `replace`, null once gone, or out of reach. */
  function withArchive(overrides: Partial<EngineDeps> = {}) {
    const archive = { state: "first" as string | null | "unavailable", file: "1:1" };
    const made = makeDeps({
      pathState: async (target) => {
        if (!target.endsWith(".zip")) return { kind: "present", fingerprint: `1:${target}:1:1` };
        if (archive.state === null) return { kind: "missing" };
        if (archive.state === "unavailable") return { kind: "unavailable" };
        return { kind: "present", fingerprint: `${archive.file}:${archive.state}:1` };
      },
      ...overrides,
    });
    return { ...made, archive };
  }
  async function finished(engine: QueueEngine, id: string): Promise<void> {
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
  }

  it("records a run that verified as verified, and says so once in the history", async () => {
    const { deps } = withArchive();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, VERIFY);
    try {
      await finished(engine, id);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("verified");
      expect(keys(engine)).toEqual(["job.savedVerified"]);
    } finally { await engine.shutdown(); }
  });

  it("records a verification on request, and a later change to the archive", async () => {
    const { deps, archive } = withArchive();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("written");
      expect((await engine.verify(id))?.ok).toBe(true);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("verified");
      expect(say(engine.snapshot()[0]?.actionResult?.message)).toBe("Verified 1 entry. No problems were found.");
      // Looking again at the same archive changes nothing.
      await engine.refresh(id);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("verified");
      archive.state = "rewritten";
      await engine.refresh(id);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("changed");
      expect(keys(engine)).toEqual(["job.saved", "history.verified", "report.archiveChanged"]);
      // Verifying the changed archive records it as verified again.
      await engine.verify(id);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("verified");
    } finally { await engine.shutdown(); }
  });

  it("records a failed verification on request as a problem count", async () => {
    const { deps } = withArchive({
      inspect: async () => ({ ok: false, summary: { total: 3, crc32Failed: 1, unreadable: 0, localMismatched: 0, sha256Mismatched: 0, manifestMismatched: 0 } as never, missing: ["a"], extra: [] }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      await engine.verify(id);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("written");
      expect(say(engine.snapshot()[0]?.actionResult?.message)).toBe("Verification found 2 problems. The archive is left as it is.");
    } finally { await engine.shutdown(); }
  });

  it("returns a job whose archive was deleted outside ZipKit to ready, saying why", async () => {
    const { deps, archive, calls } = withArchive();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      archive.state = null;
      await engine.refresh(id);
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      const job = engine.snapshot()[0]!;
      expect(job.archiveWritten).toBe(false);
      expect(job.archiveStatus).toBeUndefined();
      expect(keys(engine)).toEqual(["job.saved", "action.archiveMissing"]);
      expect(calls.trash).toEqual([]);
    } finally { await engine.shutdown(); }
  });

  it("says the archive is gone, not that it could not be trashed or read, when an action finds it missing", async () => {
    const { deps, archive, calls } = withArchive();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      archive.state = null;
      expect(await engine.verify(id)).toBeNull();
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      expect(keys(engine)).toEqual(["job.saved", "action.archiveMissing"]);

      // Created again, then gone again before Move archive to Trash.
      archive.state = "second";
      run(engine, id);
      await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
      archive.state = null;
      engine.removeArchive(id);
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      expect(calls.trash).toEqual([]);
      expect(keys(engine)).toEqual(["job.saved", "action.archiveMissing", "job.saved", "action.archiveMissing"]);
      expect(keys(engine)).not.toContain("action.archiveTrashFailed");
    } finally { await engine.shutdown(); }
  });

  it("keeps a job whose originals are gone finished when its archive goes too, with nothing left to offer", async () => {
    let trashed = false;
    const { deps, archive } = withArchive({
      pathKinds: async (paths) => paths.map((path) => ({ path, kind: trashed ? "missing" as const : "file" as const })),
      trash: async (paths) => { trashed = true; return { moved: paths, failed: [], unconfirmed: [] }; },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, TRASH);
    try {
      await finished(engine, id);
      archive.state = null;
      await engine.refresh(id);
      const job = engine.snapshot()[0]!;
      expect(job.state).toBe("done");
      expect(job.archiveStatus).toBe("missing");
      expect(keys(engine)).toEqual(["job.archivedAndTrashed", "action.archiveMissingOriginalsGone"]);
    } finally { await engine.shutdown(); }
  });

  it("keeps the originals and says the archive is gone when removing them finds it missing", async () => {
    const { deps, archive, calls } = withArchive();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      archive.state = null;
      engine.removeOriginals(id, "trash");
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      expect(calls.trash).toEqual([]);
      expect(keys(engine)).toEqual(["job.saved", "action.archiveMissing"]);
    } finally { await engine.shutdown(); }
  });

  it("adds a moved-to-Trash line when the user removes the archive", async () => {
    const { deps } = withArchive();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      engine.removeArchive(id);
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      expect(keys(engine)).toEqual(["job.saved", "action.archiveTrashed"]);
    } finally { await engine.shutdown(); }
  });
});

describe("changes made outside ZipKit to the originals and the archive", () => {
  const keys = (engine: QueueEngine) => (engine.snapshot()[0]?.history ?? []).map((entry) => entry.message.key);
  const archiveAt = (archive: { state: "there" | "replaced" | "gone" | "unavailable" }) =>
    async (target: string) => {
      if (!target.endsWith(".zip")) return { kind: "present" as const, fingerprint: `1:${target}:1:1` };
      if (archive.state === "gone") return { kind: "missing" as const };
      if (archive.state === "unavailable") return { kind: "unavailable" as const };
      return { kind: "present" as const, fingerprint: archive.state === "there" ? "1:1:10:1" : "1:2:10:1" };
    };
  async function finished(engine: QueueEngine, id: string): Promise<void> {
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    run(engine, id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
  }

  it("says an original something else removed first was already gone, never kept", async () => {
    const { deps } = makeDeps({ trash: async (paths) => ({ moved: paths.slice(1), failed: [], unconfirmed: [], gone: paths.slice(0, 1) }) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, TRASH);
    try {
      await finished(engine, id);
      expect(say(engine.snapshot()[0]?.message)).toBe("Saved and verified. 1 original was moved to recoverable Trash. 1 original was already gone.");
    } finally { await engine.shutdown(); }
  });

  it("reads the originals again after a run moves them to Trash, and offers them again once they are put back", async () => {
    let onDisk = true;
    const { deps, calls } = makeDeps({
      pathKinds: async (paths) => paths.map((path) => ({ path, kind: onDisk ? "file" as const : "missing" as const })),
      trash: async (paths) => { onDisk = false; calls.trash.push(paths); return { moved: paths, failed: [], unconfirmed: [] }; },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, TRASH);
    try {
      await finished(engine, id);
      await until(() => expect(engine.snapshot()[0]?.entries?.[0]?.kind).toBe("missing"));
      // Put back from the Trash: a fresh look sees them, and they can be removed again.
      onDisk = true;
      await engine.refresh(id);
      expect(engine.snapshot()[0]?.entries?.[0]?.kind).toBe("file");
      engine.removeOriginals(id, "trash");
      await until(() => expect(calls.trash).toHaveLength(2));
      await until(() => expect(engine.snapshot()[0]?.trashing).toBe(false));
      expect(keys(engine).at(-1)).toBe("action.originalsTrashed");
    } finally { await engine.shutdown(); }
  });

  it("removes the originals still there when some were deleted outside ZipKit, saying how many were already gone", async () => {
    const { deps, calls } = makeDeps({
      pathKinds: async (paths) => paths.map((path) => ({ path, kind: path === "/b" ? "missing" as const : "file" as const })),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      engine.removeOriginals(id, "trash");
      await until(() => expect(calls.trash).toEqual([["/a"]]));
      await until(() => expect(engine.snapshot()[0]?.trashing).toBe(false));
      expect(say(engine.snapshot()[0]?.actionResult?.message)).toBe("1 original was moved to Trash. 1 original was already gone.");
    } finally { await engine.shutdown(); }
  });

  it("removes nothing while an original is out of reach", async () => {
    const { deps, calls } = makeDeps({
      pathKinds: async (paths) => paths.map((path) => ({ path, kind: path === "/b" ? "unavailable" as const : "file" as const })),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      engine.removeOriginals(id, "delete");
      await until(() => expect(engine.snapshot()[0]?.trashing).toBe(false));
      expect(calls.deleted).toEqual([]);
      expect(keys(engine).at(-1)).toBe("originals.unavailable");
    } finally { await engine.shutdown(); }
  });

  it("leaves a file put in the archive's place alone, and lets the job create its archive again", async () => {
    const archive = { state: "there" as "there" | "replaced" | "gone" | "unavailable" };
    const { deps, calls } = makeDeps({ pathState: archiveAt(archive) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await finished(engine, id);
      archive.state = "replaced";
      engine.removeArchive(id);
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      expect(calls.trash).toEqual([]);
      expect(keys(engine)).toEqual(["job.saved", "action.archiveReplaced"]);
    } finally { await engine.shutdown(); }
  });

  it("waits, changing nothing, while the archive's drive is not connected, then picks up where it was", async () => {
    const archive = { state: "there" as "there" | "replaced" | "gone" | "unavailable" };
    const { deps } = makeDeps({ pathState: archiveAt(archive) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, { verify: true, originals: "keep" });
    try {
      await finished(engine, id);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("verified");
      archive.state = "unavailable";
      await engine.refresh(id);
      expect(engine.snapshot()[0]?.state).toBe("done");
      expect(engine.snapshot()[0]?.archiveStatus).toBe("unavailable");
      // Looking again while it is still away says nothing new.
      await engine.refresh(id);
      archive.state = "there";
      await engine.refresh(id);
      expect(engine.snapshot()[0]?.archiveStatus).toBe("verified");
      expect(keys(engine)).toEqual(["job.savedVerified", "action.archiveUnavailable", "action.archiveAvailableAgain"]);
    } finally { await engine.shutdown(); }
  });

  it("reads a waiting job's inputs again, so one deleted outside ZipKit shows before Create", async () => {
    let gone = false;
    const { deps } = makeDeps({ pathKinds: async (paths) => paths.map((path) => ({ path, kind: gone ? "missing" as const : "file" as const })) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, SAVE);
    try {
      await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
      gone = true;
      await engine.refresh(id);
      expect(engine.snapshot()[0]?.entries?.[0]?.kind).toBe("missing");
    } finally { await engine.shutdown(); }
  });
});
