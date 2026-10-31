/**
 * Unit tests for queue persistence parsing (pure). A corrupt file must degrade to
 * an empty queue rather than crash the app, an unreadable job must not take the
 * readable ones with it, and missing option fields must default — so the
 * defensive-loading boundaries are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadQueue,
  parseQueue,
  saveQueue,
  saveQueueWithin,
  serializeQueue,
  toResumable,
} from "../../../src/gui/main/persist.js";
import type { Job } from "../../../src/gui/shared/queue.js";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { closeBackupStore } from "../../../src/gui/main/backupStore.js";
import { managedEntries } from "../../helpers/managedEntries.js";
import { headed, headedText } from "../../helpers/fileHeader.js";
import { SAVE } from "../../helpers/intents.js";

describe("parseQueue", () => {
  it("round-trips serialized jobs behind the file header", () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS }];
    const root = JSON.parse(serializeQueue(jobs));
    expect(root).toEqual(headed("queue", { jobs }));
    expect(parseQueue(root)).toEqual({ jobs, kept: [] });
  });

  it("defaults missing option fields over DEFAULT_OPTIONS", () => {
    const root = { jobs: [{ id: "a", inputs: ["/x"], options: { level: 9 } }] };
    expect(parseQueue(root).jobs[0]?.options).toEqual({ ...DEFAULT_OPTIONS, level: 9 });
  });

  it("skips and counts malformed entries, keeping the readable jobs in order", () => {
    const root = {
      jobs: [
        { id: "a", inputs: ["/x"] },
        { id: "b", inputs: ["/b"] },
        { inputs: ["/y"] },
        { id: "c", inputs: ["/c"], options: { level: "high" } },
        { id: "d", inputs: ["/d"] },
      ],
    };
    const read = parseQueue(root);
    expect(read.jobs.map((job) => job.id)).toEqual(["a", "b", "d"]);
    expect(read.kept).toEqual([{ inputs: ["/y"] }, { id: "c", inputs: ["/c"], options: { level: "high" } }]);
  });

  it("rejects a non-array jobs field as a whole", () => {
    expect(() => parseQueue({ jobs: "x" })).toThrow(/jobs/);
    expect(() => parseQueue({})).toThrow(/jobs/);
  });

  it("keeps an empty job ID and a repeated one as written, restoring the first", () => {
    const entry = { inputs: ["/x"], options: DEFAULT_OPTIONS };
    expect(parseQueue({ jobs: [{ id: "", ...entry }] })).toEqual({ jobs: [], kept: [{ id: "", ...entry }] });
    const repeated = parseQueue({ jobs: [{ id: "a", ...entry, inputs: ["/first"] }, { id: "a", ...entry, inputs: ["/second"] }] });
    expect(repeated.jobs).toEqual([{ id: "a", ...entry, inputs: ["/first"] }]);
    expect(repeated.kept).toEqual([{ id: "a", ...entry, inputs: ["/second"] }]);
  });
});

describe("queue file location and persistence", () => {
  // The queue lives under the resolved storage root. Relocating that root via
  // ZIPKIT_DATA_DIR to a throwaway directory keeps the suite out of the real home dir
  // and pins the relocation + atomic round-trip in one place.
  let root: string;
  const prev = process.env.ZIPKIT_DATA_DIR;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_DATA_DIR = root;
    // Main always loads before it saves; a load of the empty root starts each test unrefused.
    await loadQueue();
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_DATA_DIR;
    else process.env.ZIPKIT_DATA_DIR = prev;
    // saveQueue now records through the write-through backup store (backups.sqlite3 under this root);
    // close it so the next test re-opens against its own throwaway root and the rm below can delete
    // the file with no open handle.
    await closeBackupStore();
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips saved jobs through the relocated root, leaving no temp file", async () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS }];
    await saveQueue(jobs);

    const file = path.join(root, "queue.json");
    // The atomic write renames the temp (`queue-<nanoid>.tmp`) over the target, so only the final file
    // remains (no orphaned temp, no dot-appended `queue.json.tmp`). The write-through backup store's own
    // files (backups.sqlite3 + its WAL sidecars) are the one other expected presence and are filtered
    // out here; that they never carry a `.tmp` is what this still proves.
    expect(managedEntries(root)).toEqual(["queue.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(headed("queue", { jobs }));
    expect((await loadQueue()).value).toEqual({ jobs, kept: [] });
  });

  it("saves the queue before returning for the end of a session, through the same atomic write", async () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS }];

    saveQueueWithin(jobs, 10_000);

    expect(managedEntries(root)).toEqual(["queue.json"]);
    expect((await loadQueue()).value).toEqual({ jobs, kept: [] });
  });

  it("throws when the session-end save fails", () => {
    // A file where the root's directory should be: the write cannot create its temp beside queue.json.
    const blocked = path.join(root, "blocked");
    writeFileSync(blocked, "", "utf8");
    process.env.ZIPKIT_DATA_DIR = blocked;

    expect(() => saveQueueWithin([], 10_000)).toThrow(/blocked/);
  });

  it("loads an empty queue when no file exists under the root", async () => {
    expect((await loadQueue()).value).toEqual({ jobs: [], kept: [] });
  });

  it.each([
    ["not JSON", "{ not json"],
    ["no header", JSON.stringify({ jobs: [] })],
    ["another kind", JSON.stringify({ format: { owner: "zipkit", kind: "config", version: 1 }, jobs: [] })],
    ["no job list", headedText("queue", { jobs: "x" })],
  ])("refuses a queue file with %s, leaves it as it is, and never saves over it", async (_case, bytes) => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, bytes);
    const loaded = await loadQueue();
    expect(loaded).toEqual({ value: { jobs: [], kept: [] }, missing: false, refused: { file, reason: "unreadable" } });
    await expect(saveQueue([{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS }])).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(readdirSync(root)).toEqual(["queue.json"]);
  });

  it("refuses a queue of a newer format and never saves over it", async () => {
    const file = path.join(root, "queue.json");
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS }];
    const bytes = JSON.stringify({ ...headed("queue", { jobs }), format: { owner: "zipkit", kind: "queue", version: 2 } });
    writeFileSync(file, bytes);
    expect(await loadQueue()).toEqual({ value: { jobs: [], kept: [] }, missing: false, refused: { file, reason: "newer" } });
    await expect(saveQueue(jobs)).rejects.toThrow(/refused at launch/);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("restores the readable jobs and writes the unreadable ones back after them on every save", async () => {
    const file = path.join(root, "queue.json");
    const good = { id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS };
    const unreadable = { id: "", inputs: ["/y"], later: true };
    writeFileSync(file, headedText("queue", { jobs: [unreadable, good] }));
    const loaded = await loadQueue();
    expect(loaded).toMatchObject({ value: { jobs: [good], kept: [unreadable] }, refused: null });
    const added = { id: "b", inputs: ["/z"], options: DEFAULT_OPTIONS };
    await saveQueue([good, added]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(headed("queue", { jobs: [good, added, unreadable] }));
    await saveQueue([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(headed("queue", { jobs: [unreadable] }));
  });
});

describe("toResumable", () => {
  const job = (id: string, state: Job["state"]): Job => ({
    id,
    inputs: [`/${id}`],
    options: DEFAULT_OPTIONS,
    intent: SAVE,
    state,
  });

  it("keeps pending jobs and drops terminal ones, as specs only, without the run's intent", () => {
    const jobs: Job[] = [
      job("a", "ready"),
      job("b", "done"),
      job("c", "planning"),
      job("d", "failed"),
      job("e", "running"),
    ];
    expect(toResumable(jobs)).toEqual([
      { id: "a", inputs: ["/a"], options: DEFAULT_OPTIONS },
      { id: "c", inputs: ["/c"], options: DEFAULT_OPTIONS },
      { id: "e", inputs: ["/e"], options: DEFAULT_OPTIONS },
    ]);
  });
});
