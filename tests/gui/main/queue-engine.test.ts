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
import type { PlanData } from "../../../src/gui/shared/api.js";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
  const calls = { plan: 0, write: 0, verify: 0, trash: [] as string[][], maxWriteInFlight: 0 };
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
    classify: async (paths) => paths.map((path) => ({ path, kind: "file" as const })),
    trash: async (paths) => {
      calls.trash.push(paths);
    },
    emit: () => {},
    sendEvent: () => {},
    newId: () => `job-${++idN}`,
    log: nullLog,
    ...overrides,
  };
  return { deps, calls };
}

describe("queue engine", () => {
  it("plans a job to ready, then writes it to done when run", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/good"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.write).toBe(1);
  });

  it("runs only the requested job, not every ready one", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const a = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    engine.add(["/b"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.run(a);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    await tick();
    expect(engine.snapshot()[1]?.state).toBe("ready"); // the unrequested job stays put
    expect(calls.write).toBe(1);
  });

  it("leaves a not-writable job in needs-attention and never writes it", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["bad"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
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
    await vi.waitFor(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("needs-attention");
      expect(j?.message).toBe("scan boom");
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
    await vi.waitFor(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("needs-attention");
      expect(j?.errorCode).toBe("output.ambiguous");
    });
  });

  it("re-plans fresh at run time", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    const atReady = calls.plan; // the add-time plan
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.plan).toBe(atReady + 1); // planned again at run
  });

  it("runs requested jobs sequentially — never two writes at once", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const ids = ["/a", "/b", "/c"].map((p) => engine.add([p], DEFAULT_OPTIONS, "save"));
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    ids.forEach((id) => engine.run(id));
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "done")).toBe(true));
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
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.run(a);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("running")); // idle -> running, no queued
    engine.run(b);
    await vi.waitFor(() => expect(engine.snapshot()[1]?.state).toBe("queued")); // waits its turn, visibly
    release();
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "done")).toBe(true));
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
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    const plansBefore = calls.plan;
    engine.run(a);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("running"));
    engine.run(b);
    await vi.waitFor(() => expect(engine.snapshot()[1]?.state).toBe("queued"));
    engine.cancel(b);
    await vi.waitFor(() => expect(engine.snapshot()[1]?.state).toBe("ready")); // re-planned back to editable
    expect(calls.plan).toBeGreaterThan(plansBefore);
    release();
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
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
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.run(a);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("running"));
    engine.run(b);
    await vi.waitFor(() => expect(engine.snapshot()[1]?.state).toBe("queued"));
    // Flipping a queued job's intent must be a no-op: a queued job is committed to
    // run, and a store-only edit would otherwise leave it queued and auto-run later
    // under the new (destructive) intent.
    engine.update(b, { intent: "archive-and-trash" });
    expect(engine.snapshot()[1]?.intent).toBe("save");
    release();
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "done")).toBe(true));
    expect(calls.trash).toEqual([]); // B ran as a plain save — nothing trashed
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
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.run(id); // requested mid-plan — must be deferred, not dropped
    await tick();
    expect(engine.snapshot()[0]?.state).toBe("planning"); // still waiting on the plan
    releasePlan();
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done")); // ran once it became ready
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
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.run(id);
    releasePlan();
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
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
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    ids.forEach((id) => engine.run(id));
    await vi.waitFor(() =>
      expect(engine.snapshot().every((j) => j.state === "done" || j.state === "failed")).toBe(true),
    );
    expect(engine.snapshot().map((j) => j.state)).toEqual(["done", "failed", "done"]);
    expect(n).toBe(3); // all three writes were attempted
  });

  it("archive-and-trash: writes, verifies, then trashes the originals", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.verify).toBe(1);
    expect(calls.trash).toEqual([["/data"]]);
  });

  it("archive-and-trash: keeps the originals when verification fails", async () => {
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(j?.message).toContain("verification failed");
    });
    expect(calls.trash).toEqual([]);
  });

  it("removeArchive trashes a done save job's output and returns it to ready", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.removeArchive(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.trash).toEqual([["/tmp/out.zip"]]); // the archive was trashed
  });

  it("removeArchive can clean up a FAILED job whose archive was written (verify failed)", async () => {
    // archive-and-trash that wrote the .zip then failed verify: the file exists and
    // the originals are kept, so the user may remove that partial archive.
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("failed"));
    expect(engine.snapshot()[0]?.output).toBe("/tmp/out.zip"); // the .zip was written
    expect(calls.trash).toEqual([]); // verify failed before any trash
    engine.removeArchive(id);
    await vi.waitFor(() => expect(calls.trash).toEqual([["/tmp/out.zip"]])); // archive removed
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready")); // back to editable
  });

  it("restore reloads saved jobs and plans each fresh to ready", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    engine.restore([
      { id: "j1", inputs: ["/a"], options: DEFAULT_OPTIONS, intent: "save" },
      { id: "j2", inputs: ["/b"], options: DEFAULT_OPTIONS, intent: "archive-and-trash" },
    ]);
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
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
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("running"));
    engine.cancel(id);
    await vi.waitFor(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(j?.message).toContain("write failed");
    });
  });

  it("archive-and-trash refuses to Trash when the archive is inside the source", async () => {
    const { deps, calls } = makeDeps({ plan: async (inputs) => planData(true, `${inputs[0]}/out.zip`) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(j?.message).toContain("inside the source");
    });
    expect(calls.trash).toEqual([]); // originals untouched
  });

  it("trashOriginals refuses when the archive sits inside an input (no self-deletion)", async () => {
    const { deps, calls } = makeDeps({ plan: async (inputs) => planData(true, `${inputs[0]}/out.zip`) });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.trashOriginals(id);
    await tick();
    expect(calls.trash).toEqual([]); // refused — never trashed
    expect(engine.snapshot()[0]?.message).toContain("inside an original");
  });

  it("trashOriginals surfaces a Trash failure instead of claiming success", async () => {
    const { deps } = makeDeps({
      trash: async () => {
        throw new Error("trash boom");
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.trashOriginals(id);
    await vi.waitFor(() =>
      expect(engine.snapshot()[0]?.message).toContain("could not move the originals"),
    );
    expect(engine.snapshot()[0]?.state).toBe("done"); // unchanged
  });

  it("removeArchive surfaces a Trash failure and leaves the job done", async () => {
    const { deps } = makeDeps({
      trash: async () => {
        throw new Error("nope");
      },
    });
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.removeArchive(id);
    await vi.waitFor(() =>
      expect(engine.snapshot()[0]?.message).toContain("could not remove the archive"),
    );
    expect(engine.snapshot()[0]?.state).toBe("done"); // unchanged
  });

  it("discards a superseded re-plan; only the newest plan's result wins", async () => {
    // A slow, stale plan must never overwrite a newer one (rapid input/option edits
    // stack re-plans). The first plan is held open; a second plan starts and
    // resolves; then the first is released and must be discarded.
    const release: Array<() => void> = [];
    let n = 0;
    const { deps } = makeDeps({
      plan: (inputs) => {
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
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.update(id, { options: { ...DEFAULT_OPTIONS, junk: false } }); // plan #2 (fresh)
    await vi.waitFor(() => expect(engine.snapshot()[0]?.output).toBe("/FRESH.zip"));
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
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.plan).toBe(1);
    engine.update(id, { options: { ...DEFAULT_OPTIONS, junk: false } });
    await vi.waitFor(() => expect(calls.plan).toBe(2));
    expect(engine.snapshot()[0]?.options.junk).toBe(false);
  });

  it("classifies inputs on add, storing them as entries", async () => {
    const { deps } = makeDeps({
      classify: async (paths) =>
        paths.map((path) => ({ path, kind: path.endsWith("/") ? "directory" : "file" })),
    });
    const engine = createQueueEngine(deps);
    engine.add(["/dir/", "/file.txt"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() =>
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
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
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
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.plan).toBe(1);
    engine.update(id, { inputs: ["/x", "/y"] });
    await vi.waitFor(() => expect(calls.plan).toBe(2));
    expect(engine.snapshot()[0]?.inputs).toEqual(["/x", "/y"]);
    await vi.waitFor(() =>
      expect(engine.snapshot()[0]?.entries?.map((e) => e.path)).toEqual(["/x", "/y"]),
    );
  });

  it("trashOriginals moves a done save job's inputs to Trash", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/a", "/b"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.run(id);
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    engine.trashOriginals(id);
    await vi.waitFor(() => expect(calls.trash).toEqual([["/a", "/b"]]));
    expect(engine.snapshot()[0]?.state).toBe("done"); // archive kept; job stays done
  });

  it("trashOriginals is a no-op unless the job is a done save job", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
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
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("planning"));
    engine.cancel(id);
    await vi.waitFor(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("needs-attention");
      expect(j?.message).toBe("aborted");
    });
  });
});
