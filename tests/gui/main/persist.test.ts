/**
 * Unit tests for queue persistence parsing (pure). A stale or corrupt file must
 * degrade to an empty queue rather than crash the app, and missing option fields
 * must default — so the defensive-loading boundaries are pinned here.
 */

import { describe, expect, it } from "vitest";
import { parseQueue, serializeQueue } from "../../../src/gui/main/persist.js";
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
