/**
 * Unit tests for queue persistence parsing (pure). A corrupt file must degrade to
 * an empty queue rather than crash the app, an unreadable job must not take the
 * readable ones with it, and missing option fields must default — so the
 * defensive-loading boundaries are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type { AppLog } from "../../../src/gui/main/log.js";
import type { Job } from "../../../src/gui/shared/queue.js";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { closeBackupStore } from "../../../src/gui/main/backupStore.js";
import { managedEntries } from "../../helpers/managedEntries.js";

describe("parseQueue", () => {
  it("round-trips serialized jobs with no format marker", () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    const root = JSON.parse(serializeQueue(jobs));
    expect(root).toEqual({ jobs });
    expect(parseQueue(root)).toEqual({ jobs, skipped: 0 });
  });

  it("reads a leftover format marker or 0.1.0 version key as unknown", () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    expect(parseQueue({ formatVersion: 3, version: 1, jobs })).toEqual({ jobs, skipped: 0 });
  });

  it("defaults missing option fields over DEFAULT_OPTIONS", () => {
    const root = { jobs: [{ id: "a", inputs: ["/x"], options: { level: 9 }, intent: "save" }] };
    expect(parseQueue(root).jobs[0]?.options).toEqual({ ...DEFAULT_OPTIONS, level: 9 });
  });

  it("skips and counts malformed entries and unknown intents, keeping the readable jobs in order", () => {
    const root = {
      jobs: [
        { id: "a", inputs: ["/x"], intent: "weird" },
        { id: "b", inputs: ["/b"], intent: "save" },
        { inputs: ["/y"] },
        { id: "c", inputs: ["/c"], options: { level: "high" }, intent: "save" },
        { id: "d", inputs: ["/d"], intent: "archive-and-trash" },
      ],
    };
    const read = parseQueue(root);
    expect(read.jobs.map((job) => job.id)).toEqual(["b", "d"]);
    expect(read.skipped).toBe(3);
  });

  it("preserves the archive-and-trash intent", () => {
    const root = { jobs: [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "archive-and-trash" }] };
    expect(parseQueue(root).jobs[0]?.intent).toBe("archive-and-trash");
  });

  it("rejects a non-array jobs field as a whole", () => {
    expect(() => parseQueue({ jobs: "x" })).toThrow(/jobs/);
    expect(() => parseQueue({})).toThrow(/jobs/);
  });

  it("skips an empty job ID and a repeated one, keeping the first", () => {
    const entry = { inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" };
    expect(parseQueue({ jobs: [{ id: "", ...entry }] })).toEqual({ jobs: [], skipped: 1 });
    const repeated = parseQueue({ jobs: [{ id: "a", ...entry, inputs: ["/first"] }, { id: "a", ...entry, inputs: ["/second"] }] });
    expect(repeated.jobs).toEqual([{ id: "a", ...entry, inputs: ["/first"] }]);
    expect(repeated.skipped).toBe(1);
  });
});

describe("queue file location and persistence", () => {
  // The queue lives under the resolved storage root. Relocating that root via
  // ZIPKIT_DATA_DIR to a throwaway directory keeps the suite out of the real home dir
  // and pins the relocation + atomic round-trip in one place.
  let root: string;
  const prev = process.env.ZIPKIT_DATA_DIR;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_DATA_DIR = root;
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
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    await saveQueue(jobs);

    const file = path.join(root, "queue.json");
    // The atomic write renames the temp (`queue-<nanoid>.tmp`) over the target, so only the final file
    // remains (no orphaned temp, no dot-appended `queue.json.tmp`). The write-through backup store's own
    // files (backups.sqlite3 + its WAL sidecars) are the one other expected presence and are filtered
    // out here; that they never carry a `.tmp` is what this still proves.
    expect(managedEntries(root)).toEqual(["queue.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jobs });
    expect((await loadQueue()).value).toEqual({ jobs, skipped: 0 });
  });

  it("saves the queue before returning for the end of a session, through the same atomic write", async () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];

    saveQueueWithin(jobs, 10_000);

    expect(managedEntries(root)).toEqual(["queue.json"]);
    expect((await loadQueue()).value).toEqual({ jobs, skipped: 0 });
  });

  it("throws when the session-end save fails", () => {
    // A file where the root's directory should be: the write cannot create its temp beside queue.json.
    const blocked = path.join(root, "blocked");
    writeFileSync(blocked, "", "utf8");
    process.env.ZIPKIT_DATA_DIR = blocked;

    expect(() => saveQueueWithin([], 10_000)).toThrow(/blocked/);
  });

  it("loads an empty queue when no file exists under the root", async () => {
    expect((await loadQueue()).value).toEqual({ jobs: [], skipped: 0 });
  });

  it("sets a corrupt queue.json aside (bytes intact) and returns an empty queue", async () => {
    const file = path.join(root, "queue.json");
    const corruptBytes = "{ not json";
    writeFileSync(file, corruptBytes, "utf8");
    const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
    const logger: AppLog = {
      debug() {},
      info() {},
      warn: (message, fields) => warnings.push({ message, fields }),
      error() {},
    };

    const { value, quarantinedTo } = await loadQueue(logger);

    expect(value).toEqual({ jobs: [], skipped: 0 });
    expect(existsSync(file)).toBe(false); // moved aside, not left in place
    const entries = readdirSync(root);
    expect(entries).toHaveLength(1);
    const quarantined = entries[0]!;
    expect(quarantined).toMatch(/^queue-\d{8}-\d{6}-utc\.invalid$/);
    expect(readFileSync(path.join(root, quarantined), "utf8")).toBe(corruptBytes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.original).toBe(file);
    expect(warnings[0]?.fields?.setAside).toBe(path.join(root, quarantined));
    expect(quarantinedTo).toBe(path.join(root, quarantined));
  });

  it("a save after setting aside writes a fresh queue.json and never touches the set-aside copy", async () => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, "{ not json", "utf8");
    await loadQueue();
    const quarantined = readdirSync(root).find((name) => name.endsWith(".invalid"))!;
    const before = readFileSync(path.join(root, quarantined), "utf8");

    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    await saveQueue(jobs);

    expect(readFileSync(path.join(root, quarantined), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jobs });
    expect(managedEntries(root).sort()).toEqual(["queue.json", quarantined].sort());
  });

  it("an unreadable job sets the whole original aside and restores its readable siblings", async () => {
    const file = path.join(root, "queue.json");
    const good = { id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const };
    const bytes = JSON.stringify({ jobs: [good, { id: "", inputs: ["/y"], intent: "save" }] });
    writeFileSync(file, bytes);
    const loaded = await loadQueue();
    expect(loaded.value).toEqual({ jobs: [good], skipped: 1 });
    // Every job, the unreadable one included, stays on disk in the set-aside copy until the next
    // save writes the readable ones back to queue.json.
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
    await saveQueue(loaded.value.jobs);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jobs: [good] });
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
  });

  it("a queue whose every job is unreadable is set aside and starts empty", async () => {
    const bytes = JSON.stringify({ jobs: [{ id: "", inputs: ["/x"], intent: "save" }] });
    writeFileSync(path.join(root, "queue.json"), bytes);
    const loaded = await loadQueue();
    expect(loaded.value).toEqual({ jobs: [], skipped: 1 });
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
  });

  it("loads a queue with a leftover format marker as current and leaves it in place", async () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    const bytes = JSON.stringify({ formatVersion: 2, jobs });
    writeFileSync(path.join(root, "queue.json"), bytes);
    expect(await loadQueue()).toEqual({ value: { jobs, skipped: 0 }, quarantinedTo: null, missing: false });
    expect(readFileSync(path.join(root, "queue.json"), "utf8")).toBe(bytes);
  });
});

describe("toResumable", () => {
  const job = (id: string, state: Job["state"]): Job => ({
    id,
    inputs: [`/${id}`],
    options: DEFAULT_OPTIONS,
    intent: "save",
    state,
  });

  it("keeps pending jobs and drops terminal ones, as specs only", () => {
    const jobs: Job[] = [
      job("a", "ready"),
      job("b", "done"),
      job("c", "planning"),
      job("d", "failed"),
      job("e", "running"),
    ];
    expect(toResumable(jobs)).toEqual([
      { id: "a", inputs: ["/a"], options: DEFAULT_OPTIONS, intent: "save" },
      { id: "c", inputs: ["/c"], options: DEFAULT_OPTIONS, intent: "save" },
      { id: "e", inputs: ["/e"], options: DEFAULT_OPTIONS, intent: "save" },
    ]);
  });
});
