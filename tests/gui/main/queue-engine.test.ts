/**
 * Tests for the queue runner. The engine is exercised through its real state
 * machine with injected fakes for the SDK verbs / Trash / id minting — no
 * Electron, no module mocking. These pin the behaviors that matter: the
 * background-plan -> ready transition, per-job run with sequential execution,
 * fresh re-plan at run, the all-or-nothing destructive sequence (originals kept
 * on any failure), failure isolation, cancel, and remove-archive-then-retry.
 */

import { describe, expect, it, vi } from "vitest";
import { createQueueEngine, type EngineDeps } from "../../../src/gui/main/queue-engine.js";
import { nullLog } from "../../../src/gui/main/log.js";
import type { LogEvent, PlanData } from "../../../src/gui/shared/api.js";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { createTranslator, type Message } from "../../../src/gui/shared/i18n/translate.js";
import { StallError, WriteError } from "../../../src/sdk/errors.js";

const en = createTranslator("en");
/** A job or action message as the English reader sees it. */
const say = (message: Message | undefined): string => (message ? en.text(message) : "");

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
    log: "",
    writable,
    summary: { total: 1, included: 1, excluded: 0, renamed: 0, warnings: 0, errors: writable ? 0 : 1, zip64: false },
    findings: [],
    entries: [],
  };
}

function makeDeps(overrides: Partial<EngineDeps> = {}) {
  const calls = { plan: 0, write: 0, verify: 0, recheck: 0, trash: [] as string[][], maxWriteInFlight: 0 };
  let writeInFlight = 0;
  let idN = 0;
  const deps: EngineDeps = {
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
    recheck: async () => {
      calls.recheck++;
      return { matches: true, added: [], missing: [], changed: [], unlisted: [] };
    },
    classify: async (paths) => paths.map((path) => ({ path, kind: "file" as const })),
    trash: async (paths) => {
      calls.trash.push(paths);
      return { moved: paths, failed: [], unconfirmed: [] };
    },
    outputInsideInputs: async () => false,
    emit: () => {},
    progress: () => () => {},
    newId: () => `job-${++idN}`,
    log: nullLog,
    ...overrides,
  };
  return { deps, calls };
}

describe("queue engine", () => {
  it("names the stalled path when a write stops responding", async () => {
    const { deps } = makeDeps({
      write: async () => {
        throw new StallError("write", "/Volumes/NAS/out-x.tmp", 30_000, false);
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe(
      "The drive or network share holding /Volumes/NAS/out-x.tmp stopped responding. " +
        "The archive could not be written. Check the output location and available storage, then try again.",
    );
  });

  it("refuses to run a Move-to-Trash job without the manifest, writing nothing", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], { ...DEFAULT_OPTIONS, metadata: false }, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const trashJob = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(engine.snapshot()[0]?.scanIncomplete).toBe(true);
    engine.run(trashJob);
    await tick();
    expect(calls.write).toBe(0);

    const saveJob = engine.add(["/other"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[1]?.state).toBe("ready"));
    engine.run(saveJob);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("done"));
    engine.trashOriginals(saveJob);
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
      plan: async (_inputs, _options, _signal, onProgress) => {
        seen.push(`plan:${sinks.get(onProgress)}`);
        return planData(true);
      },
      write: async (_plan, _signal, onProgress) => (seen.push(`write:${sinks.get(onProgress)}`), 1),
      verify: async (_output, _signal, onProgress) => (seen.push(`verify:${sinks.get(onProgress)}`), true),
      recheck: async (_output, _inputs, _options, _signal, onProgress) => {
        seen.push(`recheck:${sinks.get(onProgress)}`);
        return { matches: true, added: [], missing: [], changed: [], unlisted: [] };
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(runs).toEqual([`${id} plan`, `${id} create`]);
    expect(seen).toEqual(["plan:plan", "plan:create", "write:create", "verify:create", "recheck:create"]);
  });

  it("names the source file that changed while the archive was written", async () => {
    const { deps } = makeDeps({
      write: async () => {
        throw new WriteError("write.source-changed", "source changed", { path: "docs/notes.txt" });
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe(
      "docs/notes.txt changed while it was being archived, so no archive was written. Create the archive again.",
    );
  });

  it("names the stalled path when planning stops responding, and keeps no stale plan", async () => {
    let stall = false;
    const { deps } = makeDeps({
      plan: async (inputs) => {
        if (stall) throw new StallError("readdir", "/Volumes/NAS/src", 30_000, false);
        return planData(inputs[0] !== "bad");
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    stall = true;
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    const job = engine.snapshot()[0];
    expect(job?.errorCode).toBe("io.stalled");
    expect(say(job?.message)).toContain("/Volumes/NAS/src stopped responding");
    expect(engine.getPlan(id)).toBeNull();
  });

  it("keeps the originals and names the stalled path when verification stops responding", async () => {
    const { deps, calls } = makeDeps({
      verify: async () => {
        throw new StallError("read", "/tmp/out.zip", 30_000, false);
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const id = engine.add(["/good"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("plans a job to ready, then writes it to done when run", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.write).toBe(1);
  });

  it("runs only the requested job, not every ready one", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const a = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    engine.add(["/b"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.run(a);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    await tick();
    expect(engine.snapshot()[1]?.state).toBe("ready"); // the unrequested job stays put
    expect(calls.write).toBe(1);
  });

  it("leaves a not-writable job in needs-attention and never writes it", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["bad"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    engine.run(id); // a no-op on a blocked job
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
    engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("needs-attention");
      expect(say(j?.message)).toContain("could not be prepared");
      expect(j?.errorCode).toBeUndefined(); // a plain Error carries no SDK code
    });
  });

  it("captures the SDK error code (errorType + code) on a plan that throws", async () => {
    const { deps } = makeDeps({
      plan: async () => {
        throw Object.assign(new Error("inputs live in different parents"), {
          errorType: "policy",
          code: "output.ambiguous",
        });
      },
    });
    const engine = createQueueEngine(deps);
    engine.add(["/a", "/b"], DEFAULT_OPTIONS, "save");
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
          type: "file" as const,
          method: "deflate" as const,
          excluded: false,
          findings: [],
        }));
        return plan;
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    files = ["a.txt", "b.txt"]; // a file appeared after the Report was read
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    const job = engine.snapshot()[0];
    expect(job?.writable).toBe(true);
    expect(say(job?.message)).toContain("The files changed since this job was checked");
    expect(calls.write).toBe(0);
    expect(engine.getPlan(id)?.entries.map((e) => e.archivePath)).toEqual(["a.txt", "b.txt"]);
    engine.run(id); // the fresh plan is the reviewed one now
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.write).toBe(1);
  });

  it("re-plans fresh at run time", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    const atReady = calls.plan; // the add-time plan
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.plan).toBe(atReady + 1); // planned again at run
  });

  it("runs requested jobs sequentially — never two writes at once", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const ids = ["/a", "/b", "/c"].map((p) => engine.add([p], DEFAULT_OPTIONS, "save"));
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    ids.forEach((id) => engine.run(id));
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
    const a = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    const b = engine.add(["/b"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.run(a);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("running")); // idle -> running, no queued
    engine.run(b);
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
    const a = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    const b = engine.add(["/b"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    const plansBefore = calls.plan;
    engine.run(a);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("running"));
    engine.run(b);
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
    const a = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    const b = engine.add(["/b"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.run(a);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("running"));
    engine.run(b);
    await until(() => expect(engine.snapshot()[1]?.state).toBe("queued"));
    // Flipping a queued job's intent must be a no-op: a queued job is committed to
    // run, and a store-only edit would otherwise leave it queued and auto-run later
    // under the new (destructive) intent.
    engine.update(b, { intent: "archive-and-trash" });
    expect(engine.snapshot()[1]?.intent).toBe("save");
    release();
    await until(() => expect(engine.snapshot().every((j) => j.state === "done")).toBe(true));
    expect(calls.trash).toEqual([]); // B ran as a plain save — nothing trashed
  });

  it("ignores update() on a done job, so a late edit can't discard the finished result", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    const plansWhenDone = calls.plan;

    // The pane's option debounce lands after the job finishes. A plan-affecting
    // option re-planned the job out of `done` and threw the result away; any edit
    // dropped the published output, leaving the archive's Trash command inert.
    engine.update(id, { options: { ...DEFAULT_OPTIONS, junk: false } });
    engine.update(id, { options: { ...DEFAULT_OPTIONS, level: 1 } });
    engine.update(id, { intent: "archive-and-trash" });
    await tick();

    const job = engine.snapshot()[0];
    expect(job?.state).toBe("done");
    expect(job?.intent).toBe("save");
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
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.run(id); // requested mid-plan — must be deferred, not dropped
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
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.run(id);
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
    const ids = ["/a", "/b", "/c"].map((p) => engine.add([p], DEFAULT_OPTIONS, "save"));
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    ids.forEach((id) => engine.run(id));
    await until(() =>
      expect(engine.snapshot().every((j) => j.state === "done" || j.state === "failed")).toBe(true),
    );
    expect(engine.snapshot().map((j) => j.state)).toEqual(["done", "failed", "done"]);
    expect(n).toBe(3); // all three writes were attempted
  });

  it("archive-and-trash: writes, verifies, then trashes the originals", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.verify).toBe(1);
    expect(calls.trash).toEqual([["/data"]]);
  });

  it("archive-and-trash: keeps the originals when verification fails", async () => {
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(say(j?.message)).toContain("Verification failed");
    });
    expect(calls.trash).toEqual([]);
  });

  it("removeArchive trashes a done save job's output and returns it to ready", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
      { id: "j1", inputs: ["/a"], options: DEFAULT_OPTIONS, intent: "save" },
      { id: "j2", inputs: ["/b"], options: DEFAULT_OPTIONS, intent: "archive-and-trash" },
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
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.hasRunningJob()).toBe(true));

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
    const a = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    const b = engine.add(["/b"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.run(a);
    engine.run(b);
    await until(() => expect(engine.snapshot().find((j) => j.id === b)?.state).toBe("queued"));

    const shutdown = engine.shutdown();
    rejectFirstWrite(new Error("aborted"));
    await shutdown;

    expect(calls.write).toBe(1); // b never started
    expect(engine.snapshot().find((j) => j.id === b)?.state).toBe("queued");
  });

  it("archive-and-trash refuses to Trash when the archive is inside the source", async () => {
    const { deps, calls } = makeDeps({
      plan: async (inputs) => planData(true, `${inputs[0]}/out.zip`),
      outputInsideInputs: async () => true,
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.trashOriginals(id);
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
    const id = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.trashOriginals(id);
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
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toContain("1 original was moved to recoverable Trash. 1 original was kept.");
  });

  it("never calls an original kept while its Trash call may still move it", async () => {
    const { deps } = makeDeps({
      trash: async (paths) => ({ moved: [paths[0]!], failed: [], unconfirmed: [paths[1]!] }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    const message = say(engine.snapshot()[0]?.message);
    expect(message).toContain("1 original was moved to recoverable Trash. 1 original was still being moved and may yet reach recoverable Trash.");
    expect(message).not.toContain("kept");
  });

  it("removeArchive does not claim the archive remains when its Trash call is unconfirmed", async () => {
    const { deps } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const id = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(engine.snapshot()[0]?.archiveWritten).toBe(true);
    // The written archive is the record of the options now: no edits.
    engine.update(id, { options: { ...DEFAULT_OPTIONS, level: 1 } });
    expect(engine.snapshot()[0]?.options.level).toBe(DEFAULT_OPTIONS.level);
    verifyOk = true;
    const plansBefore = calls.plan;
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.write).toBe(1);
    expect(calls.plan).toBe(plansBefore);
    expect(calls.verify).toBe(2);
    expect(calls.recheck).toBe(1);
    expect(calls.trash).toEqual([["/data"]]);
  });

  it("Retry after a partial Trash moves only the inputs still present, forgiving what moved", async () => {
    let trashCall = 0;
    let recheckedInputs: string[] = [];
    const { deps, calls } = makeDeps({
      trash: async (paths) => {
        calls.trash.push(paths);
        trashCall++;
        return trashCall === 1
          ? { moved: ["/x/a"], failed: [{ path: "/x/b", message: "busy" }], unconfirmed: [] }
          : { moved: paths, failed: [], unconfirmed: [] };
      },
      classify: async (paths) => paths.map((path) => ({ path, kind: trashCall > 0 && path === "/x/a" ? "nonexistent" as const : "file" as const })),
      recheck: async (_output, inputs) => {
        recheckedInputs = inputs;
        calls.recheck++;
        // The moved input's entries are missing from disk, as they should be.
        return { matches: inputs.length === 2, added: [], missing: inputs.length === 2 ? [] : ["a/f.txt"], changed: [], unlisted: [] };
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x/a", "/x/b"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(recheckedInputs).toEqual(["/x/b"]);
    expect(calls.trash).toEqual([["/x/a", "/x/b"], ["/x/b"]]);
    expect(calls.write).toBe(1);
  });

  it("a verify that fails again after Retry says to move the archive to Trash and create it again", async () => {
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe("Verification failed. The originals were kept.");
    engine.run(id);
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
    const id = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save"); // plan #1 (held open)
    await until(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.update(id, { options: { ...DEFAULT_OPTIONS, junk: false } }); // plan #2 (fresh)
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
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.plan).toBe(1);
    engine.update(id, { options: { ...DEFAULT_OPTIONS, junk: false } });
    await until(() => expect(calls.plan).toBe(2));
    expect(engine.snapshot()[0]?.options.junk).toBe(false);
  });

  it("classifies inputs on add, storing them as entries", async () => {
    const { deps } = makeDeps({
      classify: async (paths) =>
        paths.map((path) => ({ path, kind: path.endsWith("/") ? "directory" : "file" })),
    });
    const engine = createQueueEngine(deps);
    engine.add(["/dir/", "/file.txt"], DEFAULT_OPTIONS, "save");
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
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
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
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.plan).toBe(1);
    engine.update(id, { inputs: ["/x", "/y"] });
    await until(() => expect(calls.plan).toBe(2));
    expect(engine.snapshot()[0]?.inputs).toEqual(["/x", "/y"]);
    await until(() =>
      expect(engine.snapshot()[0]?.entries?.map((e) => e.path)).toEqual(["/x", "/y"]),
    );
  });

  it("trashOriginals moves a done save job's inputs to Trash", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.trashOriginals(id);
    await until(() => expect(calls.trash).toEqual([["/a", "/b"]]));
    expect(engine.snapshot()[0]?.state).toBe("done"); // archive kept; job stays done
  });

  it("archive-and-trash: keeps the originals and the archive when they changed after archiving", async () => {
    const { deps, calls } = makeDeps({
      recheck: async () => ({ matches: false, added: ["data/new.txt"], missing: [], changed: [], unlisted: [] }),
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await until(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(say(engine.snapshot()[0]?.message)).toBe(
      "The originals changed after the archive was made, so the originals and the archive were kept. " +
        "To include the changes, move the archive to Trash and create it again.",
    );
    expect(calls.verify).toBe(1);
    expect(calls.trash).toEqual([]);
  });

  async function doneSave(deps: EngineDeps, options = DEFAULT_OPTIONS) {
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], options, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
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
    engine.trashOriginals(id);
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
    engine.trashOriginals(id);
    await until(() => expect(say(engine.snapshot()[0]?.actionResult?.message)).toBe("Verification failed. The originals were kept."));
    verifyOk = true;
    matches = false;
    engine.trashOriginals(id);
    await until(() => expect(say(engine.snapshot()[0]?.actionResult?.message)).toContain("The originals changed after the archive was made"));
    expect(engine.snapshot()[0]?.actionResult?.severity).toBe("error");
    expect(calls.trash).toEqual([]);
  });

  it("trashOriginals is refused for an archive without the manifest", async () => {
    const { deps, calls } = makeDeps();
    const { engine, id } = await doneSave(deps, { ...DEFAULT_OPTIONS, metadata: false });
    engine.trashOriginals(id);
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
    engine.trashOriginals(id);
    engine.trashOriginals(id); // a second click while the first is in flight
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
    engine.trashOriginals(id);
    await tick();
    await engine.shutdown();
    expect(settled).toBe(true);
    expect(engine.snapshot()[0]?.trashing).toBe(false);
  });

  it("trashOriginals is a no-op unless the job is a done save job", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.trashOriginals(id); // not done yet, wrong intent
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
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await until(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.cancel(id);
    await until(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("needs-attention");
      expect(say(j?.message)).toContain("could not be prepared");
    });
  });
});
