import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createAppLog } from "../../../src/gui/main/log.js";

const controls = vi.hoisted(() => ({ path: "", entered: null as (() => void) | null, held: null as Promise<void> | null }));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    if (String(args[0]) === controls.path) { controls.entered?.(); await controls.held; }
    return actual.mkdir(...args);
  } };
});

it("a held fallback filesystem tail cannot hold log close, and its late physical work remains ordered", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zipkit-log-tail-"));
  const database = path.join(root, "records.sqlite3");
  const db = new DatabaseSync(database);
  db.exec("PRAGMA user_version = 2");
  db.close();
  controls.path = path.join(root, "logs");
  let release!: () => void;
  controls.held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { controls.entered = resolve; });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const log = createAppLog(database, controls.path, new Date("2026-06-14T05:25:48.123Z"));
  try {
    log.info("kept late");
    await entered;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = log.close(50);
    // Close bounds the worker first, then the held fallback tail separately.
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    expect(stderr.mock.calls.some(([line]) => String(line).includes("fallback did not finish within 50 ms"))).toBe(true);
    release();
    vi.useRealTimers();
    await log.close();
    const lines = (await readFile(path.join(controls.path, "20260614-052548-123-utc.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).message);
    expect(lines).toEqual(["records database unavailable", "kept late"]);
  } finally {
    release();
    vi.useRealTimers();
    await log.close();
    stderr.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
