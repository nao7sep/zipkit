/**
 * Tests for the queue runner. The engine is exercised through its real state
 * machine with injected fakes for the SDK verbs / Trash / id minting — no
 * Electron, no module mocking. These pin the behaviors that matter: the
 * background-plan -> ready transition, the sequential drain, fresh re-plan at
 * run, the all-or-nothing destructive sequence (originals kept on any failure),
 * failure isolation, and cancel.
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
    trash: async (paths) => {
      calls.trash.push(paths);
    },
    emit: () => {},
    newId: () => `job-${++idN}`,
    log: nullLog,
    ...overrides,
  };
  return { deps, calls };
}

describe("queue engine", () => {
  it("plans a job to ready, then writes it to done on start", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    engine.add(["/good"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.start();
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.write).toBe(1);
  });

  it("leaves a not-writable job in needs-attention and never writes it", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    engine.add(["bad"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("needs-attention"));
    engine.start();
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
    });
  });

  it("re-plans fresh at run time", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    const atReady = calls.plan; // the add-time plan
    engine.start();
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.plan).toBe(atReady + 1); // planned again at run
  });

  it("drains sequentially — never two writes at once", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    for (const p of ["/a", "/b", "/c"]) engine.add([p], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.start();
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "done")).toBe(true));
    expect(calls.maxWriteInFlight).toBe(1);
  });

  it("isolates a failing write — the other jobs still run", async () => {
    let n = 0;
    const { deps } = makeDeps({
      write: async () => {
        n++;
        if (n === 2) throw new Error("disk full");
        return 1;
      },
    });
    const engine = createQueueEngine(deps);
    for (const p of ["/a", "/b", "/c"]) engine.add([p], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot().every((j) => j.state === "ready")).toBe(true));
    engine.start();
    await vi.waitFor(() =>
      expect(engine.snapshot().every((j) => j.state === "done" || j.state === "failed")).toBe(true),
    );
    expect(engine.snapshot().map((j) => j.state)).toEqual(["done", "failed", "done"]);
    expect(n).toBe(3); // all three writes were attempted
  });

  it("archive-and-trash: writes, verifies, then trashes the originals", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.start();
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("done"));
    expect(calls.verify).toBe(1);
    expect(calls.trash).toEqual([["/data"]]);
  });

  it("archive-and-trash: keeps the originals when verification fails", async () => {
    const { deps, calls } = makeDeps({ verify: async () => false });
    const engine = createQueueEngine(deps);
    engine.add(["/data"], DEFAULT_OPTIONS, "archive-and-trash");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    engine.start();
    await vi.waitFor(() => {
      const j = engine.snapshot()[0];
      expect(j?.state).toBe("failed");
      expect(j?.message).toContain("verification failed");
    });
    expect(calls.trash).toEqual([]);
  });

  it("re-plans when a job's options change", async () => {
    const { deps, calls } = makeDeps();
    const engine = createQueueEngine(deps);
    const id = engine.add(["/x"], DEFAULT_OPTIONS, "save");
    await vi.waitFor(() => expect(engine.snapshot()[0]?.state).toBe("ready"));
    expect(calls.plan).toBe(1);
    engine.update(id, { options: { ...DEFAULT_OPTIONS, level: 1 } });
    await vi.waitFor(() => expect(calls.plan).toBe(2));
    expect(engine.snapshot()[0]?.options.level).toBe(1);
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
