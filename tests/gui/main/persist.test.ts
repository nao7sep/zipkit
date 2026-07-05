/**
 * Unit tests for queue persistence parsing (pure). A stale or corrupt file must
 * degrade to an empty queue rather than crash the app, and missing option fields
 * must default — so the defensive-loading boundaries are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadQueue, parseQueue, saveQueue, serializeQueue, toResumable } from "../../../src/gui/main/persist.js";
import type { Job } from "../../../src/gui/shared/queue.js";
import { DEFAULT_OPTIONS } from "../../../src/gui/shared/spec.js";

describe("parseQueue", () => {
  it("round-trips serialized jobs", () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    expect(parseQueue(serializeQueue(jobs))).toEqual(jobs);
  });

  it("defaults missing option fields over DEFAULT_OPTIONS", () => {
    const text = JSON.stringify({ jobs: [{ id: "a", inputs: ["/x"], options: { level: 9 }, intent: "save" }] });
    expect(parseQueue(text)[0]?.options).toEqual({ ...DEFAULT_OPTIONS, level: 9 });
  });

  it("drops malformed entries and normalizes an unknown intent to save", () => {
    const text = JSON.stringify({
      jobs: [
        { id: "a", inputs: ["/x"], intent: "weird" }, // unknown intent -> save
        { inputs: ["/y"] }, // no id -> dropped
        { id: "c", inputs: "nope" }, // inputs not an array -> dropped
      ],
    });
    const out = parseQueue(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", intent: "save" });
  });

  it("preserves the archive-and-trash intent", () => {
    const text = JSON.stringify({ jobs: [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "archive-and-trash" }] });
    expect(parseQueue(text)[0]?.intent).toBe("archive-and-trash");
  });

  it("returns [] for bad JSON or a non-array jobs field", () => {
    expect(parseQueue("not json")).toEqual([]);
    expect(parseQueue(JSON.stringify({ jobs: "x" }))).toEqual([]);
    expect(parseQueue(JSON.stringify({}))).toEqual([]);
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
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips saved jobs through the relocated root, leaving no temp file", async () => {
    const jobs = [{ id: "a", inputs: ["/x"], options: DEFAULT_OPTIONS, intent: "save" as const }];
    await saveQueue(jobs);

    const file = path.join(root, "queue.json");
    // The atomic write renames the temp (`queue-<nanoid>.tmp`) over the target, so only
    // the final file remains (no orphaned temp, no dot-appended `queue.json.tmp`).
    expect(readdirSync(root)).toEqual(["queue.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    expect(await loadQueue()).toEqual(jobs);
  });

  it("loads an empty queue when no file exists under the root", async () => {
    expect(await loadQueue()).toEqual([]);
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
