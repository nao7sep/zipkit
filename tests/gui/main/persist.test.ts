/**
 * Unit tests for queue persistence parsing (pure). A stale or corrupt file must
 * degrade to an empty queue rather than crash the app, and missing option fields
 * must default — so the defensive-loading boundaries are pinned here.
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
  serializeQueue,
  toResumable,
} from "../../../src/gui/main/persist.js";
import type { AppLog } from "../../../src/gui/main/log.js";
import type { Job } from "../../../src/gui/shared/queue.js";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";
import { closeBackupStore } from "../../../src/gui/main/backupStore.js";
import { managedEntries } from "../../helpers/managedEntries.js";

describe("parseQueue", () => {
  it("round-trips serialized jobs", () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    expect(parseQueue(serializeQueue(jobs))).toEqual(jobs);
  });

  it("defaults missing option fields over DEFAULT_OPTIONS", () => {
    const text = JSON.stringify({ version: 1, jobs: [{ id: "a", inputs: ["/x"], options: { level: 9 }, intent: "save" }] });
    expect(parseQueue(text)[0]?.options).toEqual({ ...DEFAULT_OPTIONS, level: 9 });
  });

  it("rejects malformed entries and unknown intents", () => {
    const text = JSON.stringify({
      version: 1,
      jobs: [
        { id: "a", inputs: ["/x"], intent: "weird" },
        { inputs: ["/y"] },
      ],
    });
    expect(() => parseQueue(text)).toThrow(/intent/);
  });

  it("preserves the archive-and-trash intent", () => {
    const text = JSON.stringify({ version: 1, jobs: [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "archive-and-trash" }] });
    expect(parseQueue(text)[0]?.intent).toBe("archive-and-trash");
  });

  it("rejects bad JSON or a non-array jobs field", () => {
    expect(() => parseQueue("not json")).toThrow(/invalid/);
    expect(() => parseQueue(JSON.stringify({ version: 1, jobs: "x" }))).toThrow(/jobs/);
    expect(() => parseQueue(JSON.stringify({ version: 1 }))).toThrow(/jobs/);
  });

  it("rejects empty or duplicate durable job identities", () => {
    const entry = { inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" };
    expect(() => parseQueue(JSON.stringify({ version: 1, jobs: [{ id: "", ...entry }] }))).toThrow(/IDs/);
    expect(() => parseQueue(JSON.stringify({ version: 1, jobs: [{ id: "a", ...entry }, { id: "a", ...entry }] }))).toThrow(/IDs/);
  });
});

describe("queue file location and persistence", () => {
  // The queue lives under the resolved storage root. Relocating that root via
  // ZIPKIT_HOME to a throwaway directory keeps the suite out of the real home dir
  // and pins the relocation + atomic round-trip in one place.
  let root: string;
  const prev = process.env.ZIPKIT_HOME;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zipkit-home-"));
    process.env.ZIPKIT_HOME = root;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ZIPKIT_HOME;
    else process.env.ZIPKIT_HOME = prev;
    // saveQueue now records through the write-through backup store (backups.sqlite3 under this root);
    // close it so the next test re-opens against its own throwaway root and the rm below can delete
    // the file with no open handle.
    closeBackupStore();
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
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect((await loadQueue()).value).toEqual(jobs);
  });

  it("loads an empty queue when no file exists under the root", async () => {
    expect((await loadQueue()).value).toEqual([]);
  });

  it("quarantines a corrupt queue.json aside (bytes intact) and returns an empty queue", async () => {
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

    const { value: jobs, quarantinedTo } = await loadQueue(logger);

    expect(jobs).toEqual([]);
    expect(existsSync(file)).toBe(false); // moved aside, not left in place
    const entries = readdirSync(root);
    expect(entries).toHaveLength(1);
    const quarantined = entries[0]!;
    expect(quarantined).toMatch(/^queue-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
    expect(readFileSync(path.join(root, quarantined), "utf8")).toBe(corruptBytes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.original).toBe(file);
    expect(warnings[0]?.fields?.quarantined).toBe(path.join(root, quarantined));
    expect(quarantinedTo).toBe(path.join(root, quarantined));
  });

  it("a save after quarantine writes a fresh queue.json and never touches the quarantine file", async () => {
    const file = path.join(root, "queue.json");
    writeFileSync(file, "{ not json", "utf8");
    await loadQueue();
    const quarantined = readdirSync(root).find((name) => name.endsWith(".invalid"))!;
    const before = readFileSync(path.join(root, quarantined), "utf8");

    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    await saveQueue(jobs);

    expect(readFileSync(path.join(root, quarantined), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect(managedEntries(root).sort()).toEqual(["queue.json", quarantined].sort());
  });

  it("quarantines a malformed individual job rather than silently dropping it", async () => {
    const file = path.join(root, "queue.json");
    const bytes = JSON.stringify({ version: 1, jobs: [{ id: "", inputs: ["/x"], intent: "save" }] });
    writeFileSync(file, bytes);
    const loaded = await loadQueue();
    expect(loaded.value).toEqual([]);
    expect(readFileSync(loaded.quarantinedTo!, "utf8")).toBe(bytes);
  });

  it("preserves unsupported future queue versions at the live path", async () => {
    const file = path.join(root, "queue.json");
    const bytes = JSON.stringify({ version: 2, jobs: [] });
    writeFileSync(file, bytes);
    await expect(loadQueue()).rejects.toThrow(/unsupported schema version 2/);
    expect(readFileSync(file, "utf8")).toBe(bytes);
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
